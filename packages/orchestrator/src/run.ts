// Runs one request through a workflow: classify -> (answer | build). The order
// of steps, the roles, access levels and the final status are decided here in
// code. Gates, REDO and review are added around the build step in later steps
// of the roadmap (2-4, 2-5); this file keeps the step runner reusable for them.

import type { BuilderReport, HarnessTools, Requirement, RoleId, Runtime, RunStatus, Session, StepKind, TokenUsage, UserQuestion } from '#core';
import { UsageLedger } from '#core';
import { ReportCollector } from '#tools-mcp';
import { LeadCollector } from './lead-report.ts';
import { buildPrompt, classifyPrompt, instructionsFor, reportReminder } from './prompts.ts';
import type { RunConfig, RunEvent, RunEventBody, RunResult } from './types.ts';

interface Collector {
  submit(report: unknown): Promise<{ ok: boolean; message: string }>;
  done(): boolean;
}

interface TurnOutcome {
  status: 'completed' | 'interrupted' | 'failed';
  error?: string;
}

/** Why a step could not produce its report. */
type StepFailure =
  | { kind: 'interrupted' }
  | { kind: 'failed'; reason: string }
  | { kind: 'needs_user'; question: string };

class RunContext {
  readonly config: RunConfig;
  readonly events: RunEvent[] = [];
  readonly ledger = new UsageLedger();
  readonly #turns = new Map<string, number>();
  pendingQuestion: string | null = null;

  constructor(config: RunConfig) {
    this.config = config;
  }

  emit(body: RunEventBody): void {
    const event = { ...body, seq: this.events.length + 1, at: new Date().toISOString() } as RunEvent;
    this.events.push(event);
    this.config.onEvent?.(event);
  }

  nextTurn(step: string): number {
    const turn = (this.#turns.get(step) ?? 0) + 1;
    this.#turns.set(step, turn);
    return turn;
  }

  runtimeFor(role: RoleId): Runtime {
    const { runtime } = this.config;
    if ('startSession' in runtime) return runtime;
    const chosen = runtime[role];
    if (!chosen) throw new Error(`no runtime configured for role "${role}"`);
    return chosen;
  }

  get aborted(): boolean {
    return this.config.signal?.aborted ?? false;
  }
}

function toolsFor(ctx: RunContext, step: StepKind, role: RoleId, collector: Collector): HarnessTools {
  return {
    async submitReport(report) {
      const result = await collector.submit(report);
      ctx.emit({ type: 'report', step, kind: role, accepted: result.ok, detail: result.message.split('\n')[0] ?? '' });
      return result;
    },
    async requestUserInput(question: UserQuestion) {
      const ask = ctx.config.askUser;
      if (!ask) {
        ctx.pendingQuestion ??= question.question;
        ctx.emit({ type: 'user_question', step, question: question.question, answered: false });
        return 'The user cannot be asked right now. Stop working and end the step without a report; the harness will pass your question on.';
      }
      ctx.emit({ type: 'user_question', step, question: question.question, answered: false });
      const answer = await ask(question);
      ctx.emit({ type: 'user_question', step, question: question.question, answered: true });
      return answer;
    },
  };
}

async function playTurn(ctx: RunContext, step: StepKind, role: RoleId, session: Session, text: string): Promise<TurnOutcome> {
  const turn = ctx.nextTurn(step);
  const signal = ctx.config.signal ?? new AbortController().signal;
  let outcome: TurnOutcome = { status: 'failed', error: 'runtime ended the turn without a result' };
  for await (const event of session.runTurn({ text }, signal)) {
    ctx.emit({ type: 'runtime', step, role, event });
    if (event.type === 'usage') ctx.ledger.record(step, turn, event.delta);
    if (event.type === 'turn_end') outcome = { status: event.status, ...(event.error ? { error: event.error } : {}) };
  }
  return outcome;
}

/**
 * Opens a session for a role, plays the step prompt, and makes sure a report was
 * accepted. A turn that ends without one gets one reminder; after that the step
 * fails. Returns null on success.
 */
async function runReportingStep(ctx: RunContext, step: StepKind, role: RoleId, collector: Collector, prompt: string, reminder: string): Promise<StepFailure | null> {
  const { config } = ctx;
  ctx.emit({ type: 'step_started', step, role });
  const access = role === 'builder' ? 'workspace-write' : 'read-only';
  const effort = config.effort?.[role] ?? (role === 'lead' ? 'low' : undefined);
  const model = config.models?.[role];
  const tools = toolsFor(ctx, step, role, collector);
  let session: Session | null = null;
  try {
    session = await ctx.runtimeFor(role).startSession({
      role, cwd: config.cwd, access, skills: [], tools,
      instructions: instructionsFor(role, config.roleNotes?.[role]),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    });
    for (const text of [prompt, reminder]) {
      const outcome = await playTurn(ctx, step, role, session, text);
      if (outcome.status === 'interrupted' || ctx.aborted) return finishStep(ctx, step, false, 'interrupted', { kind: 'interrupted' });
      if (outcome.status === 'failed') return finishStep(ctx, step, false, outcome.error ?? 'turn failed', { kind: 'failed', reason: outcome.error ?? 'turn failed' });
      if (collector.done()) return finishStep(ctx, step, true, 'report accepted', null);
      if (ctx.pendingQuestion) return finishStep(ctx, step, false, 'waiting for the user', { kind: 'needs_user', question: ctx.pendingQuestion });
    }
    return finishStep(ctx, step, false, 'no accepted report', { kind: 'failed', reason: `The ${role} ended the ${step} step twice without an accepted report.` });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return finishStep(ctx, step, false, reason, { kind: 'failed', reason });
  } finally {
    await session?.close().catch(() => {});
  }
}

function finishStep(ctx: RunContext, step: StepKind, ok: boolean, detail: string, failure: StepFailure | null): StepFailure | null {
  ctx.emit({ type: 'step_finished', step, ok, detail });
  return failure;
}

function finish(ctx: RunContext, status: RunStatus, reason: string, extra: Partial<RunResult> = {}): RunResult {
  ctx.emit({ type: 'run_finished', status, reason });
  const usage: TokenUsage = ctx.ledger.total();
  return { status, reason, requirements: [], usage, usageEntries: ctx.ledger.entries(), events: ctx.events, ...extra };
}

function failureResult(ctx: RunContext, failure: StepFailure, extra: Partial<RunResult> = {}): RunResult {
  if (failure.kind === 'interrupted') return finish(ctx, 'interrupted', 'The run was stopped before it finished.', extra);
  if (failure.kind === 'needs_user') return finish(ctx, 'needs_user', `The agent needs an answer from you: ${failure.question}`, extra);
  return finish(ctx, 'failed', failure.reason, extra);
}

/** Requirement coverage rule for builder reports: every run requirement exactly once, no invented ids. */
export function builderCoverageErrors(requirements: Requirement[], report: BuilderReport): string[] {
  const errors: string[] = [];
  const expected = new Set(requirements.map(requirement => requirement.id));
  const seen = new Set<string>();
  report.requirements.forEach((entry, index) => {
    if (!expected.has(entry.id)) errors.push(`builder.requirements[${index}].id: "${entry.id}" is not one of the given requirements (${[...expected].join(', ')})`);
    else if (seen.has(entry.id)) errors.push(`builder.requirements[${index}].id: "${entry.id}" is reported twice`);
    seen.add(entry.id);
  });
  for (const id of expected) if (!seen.has(id)) errors.push(`builder.requirements: missing an entry for ${id}`);
  return errors;
}

export async function runRequest(request: string, config: RunConfig): Promise<RunResult> {
  const ctx = new RunContext(config);
  ctx.emit({ type: 'run_started', request });
  try {
    // classify (fast path: an "answer" report carries the answer too)
    const lead = new LeadCollector();
    const classifyFailure = await runReportingStep(ctx, 'classify', 'lead', { submit: lead.submit, done: () => lead.classify !== null }, classifyPrompt(request), reportReminder('your report (workflow, requirements, reason, and the answer when the workflow is "answer")'));
    if (classifyFailure) return failureResult(ctx, classifyFailure);
    const classify = lead.classify!;
    const base = { workflow: classify.workflow, classify, requirements: classify.requirements };

    if (classify.workflow === 'answer') {
      const answer = lead.answer!;
      ctx.emit({ type: 'step_started', step: 'report', role: 'lead' });
      ctx.emit({ type: 'step_finished', step: 'report', ok: true, detail: 'answered without changing files' });
      return finish(ctx, 'completed', 'Answered from the project files. No files were changed.', { ...base, answer });
    }

    if (classify.workflow === 'build') {
      const builder = new ReportCollector('builder', report => builderCoverageErrors(classify.requirements, report));
      const buildFailure = await runReportingStep(ctx, 'build', 'builder', { submit: builder.submit, done: () => builder.report !== null }, buildPrompt(request, classify.requirements), reportReminder('your builder report'));
      if (buildFailure) return failureResult(ctx, buildFailure, base);
      const report = builder.report!;
      const open = report.requirements.filter(entry => entry.status !== 'done');
      if (open.length) {
        const list = open.map(entry => `${entry.id} (${entry.status})`).join(', ');
        return finish(ctx, 'needs_review', `The builder did not complete: ${list}.`, { ...base, builder: report });
      }
      ctx.emit({ type: 'step_started', step: 'report', role: 'lead' });
      ctx.emit({ type: 'step_finished', step: 'report', ok: true, detail: 'build reported' });
      return finish(ctx, 'completed', 'The builder completed every requirement.', { ...base, builder: report });
    }

    return finish(ctx, 'failed', `The "${classify.workflow}" workflow is not available in this version.`, base);
  } catch (error) {
    return finish(ctx, 'failed', error instanceof Error ? error.message : String(error));
  }
}
