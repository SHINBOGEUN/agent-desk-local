// Runs one request through a workflow: classify -> (answer | build). The order
// of steps, the roles, access levels, gates, REDO and the final status are all
// decided here in code. Models only work inside steps.

import type { BuilderReport, HarnessTools, Requirement, RoleId, Runtime, RunStatus, Session, StepKind, TokenUsage, UserQuestion, VerifierReport } from '#core';
import { UsageLedger } from '#core';
import { ReportCollector } from '#tools-mcp';
import { classifyFailure } from './failure.ts';
import type { FailureType } from './failure.ts';
import { checkBudget, checkChangeReport, checkNoChanges, runVerify } from './gates.ts';
import type { GateResult } from './gates.ts';
import { renderDiff } from './diff-text.ts';
import { LeadCollector } from './lead-report.ts';
import { buildPrompt, classifyPrompt, freshRedoPrompt, instructionsFor, redoPrompt, reportReminder } from './prompts.ts';
import { DEFAULT_AUTO_LIMITS, decideReview, reviewPrompt } from './review.ts';
import { diffProtected, diffSnapshots, restoreProtected, takeSnapshot } from './snapshot.ts';
import type { Diff, Snapshot } from './snapshot.ts';
import type { RunConfig, RunEvent, RunEventBody, RunResult } from './types.ts';

interface Collector {
  submit(report: unknown): Promise<{ ok: boolean; message: string }>;
  done(): boolean;
}

/** The tools of a session call whatever collector is current, so a session can take several reports (REDO). */
interface Holder {
  current: Collector;
}

interface TurnOutcome {
  status: 'completed' | 'interrupted' | 'failed';
  error?: string;
}

/** Why a step could not produce its report. */
type StepFailure =
  | { kind: 'interrupted' }
  | { kind: 'budget'; reason: string; step: StepKind }
  | { kind: 'failed'; reason: string; type: FailureType }
  | { kind: 'needs_user'; question: string };

const DEFAULT_REDO_LIMIT = 2;
const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;

class RunContext {
  readonly config: RunConfig;
  readonly events: RunEvent[] = [];
  readonly gates: GateResult[] = [];
  readonly warnings: string[] = [];
  readonly ledger = new UsageLedger();
  readonly startedAt = Date.now();
  readonly #turns = new Map<string, number>();
  readonly #budgetController = new AbortController();
  readonly retried = new Set<string>();
  pendingQuestion: string | null = null;
  budgetHit: string | null = null;
  redo = 0;

  constructor(config: RunConfig) {
    this.config = config;
  }

  get signal(): AbortSignal {
    return this.config.signal ? AbortSignal.any([this.config.signal, this.#budgetController.signal]) : this.#budgetController.signal;
  }

  get ignore(): string[] {
    return this.config.ignore ?? [];
  }

  emit(body: RunEventBody): void {
    const event = { ...body, seq: this.events.length + 1, at: new Date().toISOString() } as RunEvent;
    this.events.push(event);
    this.config.onEvent?.(event);
  }

  recordGate(result: GateResult): GateResult {
    this.gates.push(result);
    this.emit({ type: 'gate', result });
    return result;
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

  /** Gate G5. Stops the running turn as soon as a limit is crossed. */
  enforceBudget(attempt: number, abortTurn: boolean): boolean {
    const gate = checkBudget({ attempt, budget: this.config.budget, usage: this.ledger.total(), elapsedMs: Date.now() - this.startedAt });
    if (gate.ok) return true;
    this.budgetHit ??= gate.problems[0] ?? 'budget exceeded';
    this.recordGate(gate);
    if (abortTurn) this.#budgetController.abort();
    return false;
  }
}

function toolsFor(ctx: RunContext, step: StepKind, role: RoleId, holder: Holder): HarnessTools {
  return {
    async submitReport(report) {
      const result = await holder.current.submit(report);
      ctx.emit({ type: 'report', step, kind: role, accepted: result.ok, detail: result.message.split('\n')[0] ?? '' });
      return result;
    },
    async requestUserInput(question: UserQuestion) {
      const ask = ctx.config.askUser;
      ctx.emit({ type: 'user_question', step, question: question.question, answered: false });
      if (!ask) {
        ctx.pendingQuestion ??= question.question;
        return 'The user cannot be asked right now. Stop working and end the step without a report; the harness will pass your question on.';
      }
      const answer = await ask(question);
      ctx.emit({ type: 'user_question', step, question: question.question, answered: true });
      return answer;
    },
  };
}

async function playTurn(ctx: RunContext, step: StepKind, role: RoleId, session: Session, text: string): Promise<TurnOutcome> {
  const turn = ctx.nextTurn(step);
  let outcome: TurnOutcome = { status: 'failed', error: 'runtime ended the turn without a result' };
  for await (const event of session.runTurn({ text }, ctx.signal)) {
    ctx.emit({ type: 'runtime', step, role, event });
    if (event.type === 'usage') { ctx.ledger.record(step, turn, event.delta); ctx.enforceBudget(ctx.redo, true); }
    if (event.type === 'turn_end') outcome = { status: event.status, ...(event.error ? { error: event.error } : {}) };
  }
  return outcome;
}

const failedStep = (reason: string, type: FailureType = classifyFailure(reason)): StepFailure => ({ kind: 'failed', reason, type });

async function openSession(ctx: RunContext, step: StepKind, role: RoleId, holder: Holder): Promise<Session> {
  const { config } = ctx;
  const effort = config.effort?.[role] ?? (role === 'lead' ? 'low' : undefined);
  const model = config.models?.[role];
  return ctx.runtimeFor(role).startSession({
    role, cwd: config.cwd, access: role === 'builder' ? 'workspace-write' : 'read-only', skills: [], tools: toolsFor(ctx, step, role, holder),
    instructions: instructionsFor(role, config.roleNotes?.[role]),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  });
}

/**
 * Plays the prompt, and if the turn ends without an accepted report, one
 * reminder. Returns null when a report was accepted.
 */
async function playUntilReport(ctx: RunContext, step: StepKind, role: RoleId, session: Session, holder: Holder, prompt: string, reminder: string): Promise<StepFailure | null> {
  for (const text of [prompt, reminder]) {
    const outcome = await playTurn(ctx, step, role, session, text);
    if (ctx.budgetHit) return { kind: 'budget', reason: ctx.budgetHit, step };
    if (outcome.status === 'interrupted' || ctx.config.signal?.aborted) return { kind: 'interrupted' };
    if (outcome.status === 'failed') return failedStep(outcome.error ?? 'turn failed');
    if (holder.current.done()) return null;
    if (ctx.pendingQuestion) return { kind: 'needs_user', question: ctx.pendingQuestion };
  }
  return failedStep(`The ${role} ended the ${step} step twice without an accepted report.`, 'other');
}

/** A flaky runtime gets one more try per step, in a fresh session. */
async function withTransientRetry(ctx: RunContext, step: StepKind, attempt: () => Promise<StepFailure | null>): Promise<StepFailure | null> {
  const failure = await attempt();
  if (failure?.kind === 'failed' && failure.type === 'transient' && !ctx.retried.has(step)) {
    ctx.retried.add(step);
    ctx.emit({ type: 'retry', step, reason: failure.reason });
    return attempt();
  }
  return failure;
}

function finish(ctx: RunContext, status: RunStatus, reason: string, extra: Partial<RunResult> = {}): RunResult {
  ctx.emit({ type: 'run_finished', status, reason });
  const usage: TokenUsage = ctx.ledger.total();
  return { status, reason, requirements: [], gates: ctx.gates, redo: ctx.redo, warnings: ctx.warnings, unverified: [], usage, usageEntries: ctx.ledger.entries(), events: ctx.events, ...extra };
}

function failureResult(ctx: RunContext, failure: StepFailure, extra: Partial<RunResult> = {}): RunResult {
  if (failure.kind === 'interrupted') return finish(ctx, 'interrupted', 'The run was stopped before it finished.', extra);
  if (failure.kind === 'budget') return finish(ctx, 'interrupted', `Stopped by the budget. ${failure.reason}`, { ...extra, resume: { step: failure.step, redo: ctx.redo, note: 'Start a new run with the remaining requirements; earlier changes stay in the folder.' } });
  if (failure.kind === 'needs_user') return finish(ctx, 'needs_user', `The agent needs an answer from you: ${failure.question}`, extra);
  if (failure.type === 'environment') return finish(ctx, 'failed', `Environment problem: ${failure.reason} Fix it (run \`agent-desk doctor\`), then start the run again.`, { ...extra, failureType: 'environment' });
  return finish(ctx, 'failed', failure.reason, { ...extra, failureType: failure.type });
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

/** Protected paths must never change. If they did, put them back and say so. */
function protectedViolation(ctx: RunContext, before: Snapshot, after: Snapshot): string | null {
  const changed = diffProtected(before, after);
  if (!changed.all.length) return null;
  const outcome = restoreProtected(ctx.config.cwd, before, after);
  const left = outcome.failed.length ? ` These could not be restored: ${outcome.failed.join(', ')}.` : ' They were restored.';
  return `A step changed protected paths (${changed.all.join(', ')}).${left}`;
}

async function runClassify(ctx: RunContext, request: string, lead: LeadCollector): Promise<RunResult | null> {
  ctx.emit({ type: 'step_started', step: 'classify', role: 'lead' });
  const before = takeSnapshot(ctx.config.cwd, { mode: 'stat', ignore: ctx.ignore });
  const holder: Holder = { current: { submit: lead.submit, done: () => lead.classify !== null } };
  const failure = await withTransientRetry(ctx, 'classify', async () => {
    let session: Session | null = null;
    try {
      session = await openSession(ctx, 'classify', 'lead', holder);
      return await playUntilReport(ctx, 'classify', 'lead', session, holder, classifyPrompt(request), reportReminder('your report (workflow, requirements, reason, and the answer when the workflow is "answer")'));
    } catch (error) {
      return failedStep(error instanceof Error ? error.message : String(error));
    } finally {
      await session?.close().catch(() => {});
    }
  });
  const after = takeSnapshot(ctx.config.cwd, { mode: 'stat', ignore: ctx.ignore });
  const violation = protectedViolation(ctx, before, after);
  const changes = ctx.recordGate(checkNoChanges({ attempt: 0, step: 'classify', diff: diffSnapshots(before, after) }));
  ctx.emit({ type: 'step_finished', step: 'classify', ok: !failure && changes.ok && !violation, detail: failure ? 'failed' : 'report accepted' });
  if (violation) return finish(ctx, 'failed', violation);
  if (!changes.ok) return finish(ctx, 'needs_review', changes.problems[0] ?? 'A read-only step changed files.', failure ? {} : { classify: lead.classify!, workflow: lead.classify!.workflow, requirements: lead.classify!.requirements });
  return failure ? failureResult(ctx, failure) : null;
}

async function runBuild(ctx: RunContext, request: string, requirements: Requirement[], base: Partial<RunResult>): Promise<RunResult> {
  const { config } = ctx;
  const redoLimit = config.redoLimit ?? DEFAULT_REDO_LIMIT;
  const before = takeSnapshot(config.cwd, { ignore: ctx.ignore, keepContent: true });
  const newCollector = (): ReportCollector<'builder'> => new ReportCollector('builder', report => builderCoverageErrors(requirements, report));
  let collector = newCollector();
  const holder: Holder = { current: { submit: report => collector.submit(report), done: () => collector.report !== null } };
  let session: Session | null = null;
  const closeSession = async () => { await session?.close().catch(() => {}); session = null; };
  let prompt = buildPrompt(request, requirements);
  let fresh = prompt;
  ctx.emit({ type: 'step_started', step: 'build', role: 'builder' });
  try {
    for (;;) {
      collector = newCollector();
      const failure = await withTransientRetry(ctx, 'build', async () => {
        try {
          const firstTry = session === null || !ctx.retried.has('build');
          if (!session) session = await openSession(ctx, 'build', 'builder', holder);
          const failed = await playUntilReport(ctx, 'build', 'builder', session, holder, firstTry ? prompt : fresh, reportReminder('your builder report'));
          if (failed) await closeSession();
          return failed;
        } catch (error) {
          await closeSession();
          return failedStep(error instanceof Error ? error.message : String(error));
        }
      });
      if (failure) {
        ctx.emit({ type: 'step_finished', step: 'build', ok: false, detail: failure.kind });
        return failureResult(ctx, failure, base);
      }
      const report = collector.report!;
      const after = takeSnapshot(config.cwd, { ignore: ctx.ignore });
      const violation = protectedViolation(ctx, before, after);
      if (violation) {
        ctx.emit({ type: 'step_finished', step: 'build', ok: false, detail: 'protected paths changed' });
        return finish(ctx, 'failed', violation, { ...base, builder: report });
      }
      const g2 = ctx.recordGate(checkChangeReport({ attempt: ctx.redo, cwd: config.cwd, reported: report.changedFiles, diff: diffSnapshots(before, after), ignore: ctx.ignore }));
      const verified = await runVerify({ attempt: ctx.redo, cwd: config.cwd, commands: config.verify ?? [], timeoutMs: config.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS });
      const g3 = ctx.recordGate(verified.result);
      if (g3.data?.unavailable) {
        ctx.emit({ type: 'step_finished', step: 'build', ok: false, detail: 'verify command unavailable' });
        return failureResult(ctx, failedStep(g3.problems[0] ?? 'A verify command could not be run.', 'environment'), { ...base, builder: report });
      }
      const notDone = report.requirements.filter(entry => entry.status === 'not_done').map(entry => `Requirement ${entry.id} is reported as not done${entry.evidence ? `: ${entry.evidence}` : ''}.`);
      let reasons = [...g2.problems, ...g3.problems, ...notDone];
      let review: ReviewOutcome = { kind: 'skipped', reason: 'earlier gates failed' };
      if (!reasons.length) {
        review = await runReview(ctx, { request, requirements, before, diff: diffSnapshots(before, after), g2, g3 });
        if (review.kind === 'stop') {
          return review.failure ? failureResult(ctx, review.failure, { ...base, builder: report }) : finish(ctx, review.status, review.reason, { ...base, builder: report });
        }
        if (review.kind === 'verdict' && review.report.verdict === 'REDO') reasons = review.report.blocking.map(finding => `Review: ${finding.reason}${finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ''})` : ''}. Evidence: ${finding.evidence}`);
      }
      if (!reasons.length) return completeBuild(ctx, report, g2, g3, base, review);
      if (!ctx.enforceBudget(ctx.redo, false)) {
        ctx.emit({ type: 'step_finished', step: 'build', ok: false, detail: 'budget' });
        return failureResult(ctx, { kind: 'budget', reason: ctx.budgetHit ?? 'budget exceeded', step: 'build' }, { ...base, builder: report });
      }
      if (ctx.redo >= redoLimit) {
        ctx.emit({ type: 'step_finished', step: 'build', ok: false, detail: 'redo limit reached' });
        return finish(ctx, 'needs_review', `Still failing after ${ctx.redo} redo round(s): ${reasons[0]?.split('\n')[0] ?? 'unknown problem'}`, { ...base, builder: report, unverified: report.unverified });
      }
      ctx.redo++;
      const mode = ctx.redo === 1 ? 'same-session' : 'new-session';
      ctx.emit({ type: 'redo', attempt: ctx.redo, mode, reasons });
      fresh = freshRedoPrompt(request, requirements, reasons, report.summary);
      if (mode === 'same-session') prompt = redoPrompt(reasons, ctx.redo);
      else { await closeSession(); prompt = fresh; }
    }
  } finally {
    await closeSession();
  }
}

type ReviewOutcome =
  | { kind: 'skipped'; reason: string }
  | { kind: 'verdict'; report: VerifierReport }
  | { kind: 'stop'; status: RunStatus; reason: string; failure?: StepFailure };

/** Gate G4: decides by policy whether to review, then runs an independent read-only verifier in a new session. */
async function runReview(ctx: RunContext, input: { request: string; requirements: Requirement[]; before: Snapshot; diff: Diff; g2: GateResult; g3: GateResult }): Promise<ReviewOutcome> {
  const { config } = ctx;
  const rendered = renderDiff({ cwd: config.cwd, before: input.before, diff: input.diff });
  const decision = decideReview({
    policy: config.review ?? 'always', verifySkipped: input.g3.skipped === true, changedFiles: input.diff.all, changedLines: rendered.lines, linesUnknown: rendered.unknown,
    limits: { ...DEFAULT_AUTO_LIMITS, ...config.autoReview },
  });
  if (!decision.review) {
    ctx.recordGate({ gate: 'G4', ok: true, skipped: true, attempt: ctx.redo, detail: `review skipped: ${decision.reason}`, problems: [] });
    return { kind: 'skipped', reason: decision.reason };
  }
  const testFiles = (input.g2.data?.testFilesChanged as string[] | undefined) ?? [];
  const verifyLines = ((input.g3.data?.commands as string[] | undefined) ?? []).map(command => `\`${command}\` passed`);
  const prompt = reviewPrompt({ request: input.request, requirements: input.requirements, verifyLines, diffText: rendered.text, changedFiles: input.diff.all, testFiles });
  const collector = new ReportCollector('verifier', report => (report.verdict === 'BLOCKED' && !report.blocking.length ? ['verifier.blocking: BLOCKED needs at least one entry that says what could not be decided and why'] : []));
  const holder: Holder = { current: { submit: report => collector.submit(report), done: () => collector.report !== null } };
  ctx.emit({ type: 'step_started', step: 'review', role: 'verifier' });
  const guardBefore = takeSnapshot(config.cwd, { mode: 'stat', ignore: ctx.ignore });
  const failure = await withTransientRetry(ctx, 'review', async () => {
    let session: Session | null = null;
    try {
      session = await openSession(ctx, 'review', 'verifier', holder);
      return await playUntilReport(ctx, 'review', 'verifier', session, holder, prompt, reportReminder('your verifier report'));
    } catch (error) {
      return failedStep(error instanceof Error ? error.message : String(error));
    } finally {
      await session?.close().catch(() => {});
    }
  });
  const guardAfter = takeSnapshot(config.cwd, { mode: 'stat', ignore: ctx.ignore });
  const violation = protectedViolation(ctx, guardBefore, guardAfter);
  const touched = diffSnapshots(guardBefore, guardAfter);
  if (violation) { ctx.emit({ type: 'step_finished', step: 'review', ok: false, detail: 'protected paths changed' }); return { kind: 'stop', status: 'failed', reason: violation }; }
  if (touched.all.length) { ctx.emit({ type: 'step_finished', step: 'review', ok: false, detail: 'read-only step changed files' }); return { kind: 'stop', status: 'needs_review', reason: `The review step is read-only but these files changed: ${touched.all.join(', ')}` }; }
  if (failure) {
    ctx.emit({ type: 'step_finished', step: 'review', ok: false, detail: failure.kind });
    if (failure.kind === 'failed' && failure.type !== 'environment') return { kind: 'stop', status: 'needs_review', reason: `The review did not produce a verdict: ${failure.reason}` };
    return { kind: 'stop', status: 'failed', reason: '', failure };
  }
  const verdict = collector.report!;
  ctx.recordGate({ gate: 'G4', ok: verdict.verdict === 'PASS', attempt: ctx.redo, detail: `verdict ${verdict.verdict}`, problems: verdict.blocking.map(finding => finding.reason), data: { optional: verdict.optional } });
  ctx.emit({ type: 'step_finished', step: 'review', ok: verdict.verdict !== 'REDO', detail: `verdict ${verdict.verdict}` });
  return { kind: 'verdict', report: verdict };
}

function completeBuild(ctx: RunContext, report: BuilderReport, g2: GateResult, g3: GateResult, base: Partial<RunResult>, review: ReviewOutcome): RunResult {
  const testFiles = (g2.data?.testFilesChanged as string[] | undefined) ?? [];
  if (testFiles.length) ctx.warnings.push(`Test or check files changed: ${testFiles.join(', ')}. Confirm the change was required by the request.`);
  const openIds = report.requirements.filter(entry => entry.status === 'unverified').map(entry => entry.id);
  const unverified = [...openIds.map(id => `Requirement ${id} was reported as unverified.`), ...report.unverified];
  if (g3.skipped) ctx.warnings.push('No automatic verification: no verify commands are configured.');
  const reviewExtra: Partial<RunResult> = review.kind === 'verdict' ? { review: review.report } : review.kind === 'skipped' ? { reviewSkipped: review.reason } : {};
  if (review.kind === 'verdict' && review.report.verdict === 'BLOCKED') {
    const why = review.report.blocking.map(finding => finding.reason).join('; ');
    if (g3.skipped) return finish(ctx, 'needs_review', `The reviewer could not decide and no verify command is configured: ${why}`, { ...base, ...reviewExtra, builder: report, unverified });
    unverified.push(`Review could not decide: ${why}`);
  }
  ctx.emit({ type: 'step_finished', step: 'build', ok: true, detail: 'gates passed' });
  if (openIds.length && g3.skipped) {
    return finish(ctx, 'needs_review', `The builder could not verify ${openIds.join(', ')} and no verify command is configured to check them.`, { ...base, ...reviewExtra, builder: report, unverified });
  }
  ctx.emit({ type: 'step_started', step: 'report', role: 'lead' });
  ctx.emit({ type: 'step_finished', step: 'report', ok: true, detail: 'build reported' });
  const note = unverified.length ? ` Not verified by the builder: ${unverified.length} item(s), listed in the result.` : '';
  return finish(ctx, 'completed', `Every requirement is done and the gates passed.${note}`, { ...base, ...reviewExtra, builder: report, unverified });
}

export async function runRequest(request: string, config: RunConfig): Promise<RunResult> {
  const ctx = new RunContext(config);
  ctx.emit({ type: 'run_started', request });
  try {
    const lead = new LeadCollector();
    const stopped = await runClassify(ctx, request, lead);
    if (stopped) return stopped;
    const classify = lead.classify!;
    const base = { workflow: classify.workflow, classify, requirements: classify.requirements };

    if (classify.workflow === 'answer') {
      ctx.emit({ type: 'step_started', step: 'report', role: 'lead' });
      ctx.emit({ type: 'step_finished', step: 'report', ok: true, detail: 'answered without changing files' });
      return finish(ctx, 'completed', 'Answered from the project files. No files were changed.', { ...base, answer: lead.answer! });
    }
    if (classify.workflow === 'build') return await runBuild(ctx, request, classify.requirements, base);
    return finish(ctx, 'failed', `The "${classify.workflow}" workflow is not available in this version.`, base);
  } catch (error) {
    return finish(ctx, 'failed', error instanceof Error ? error.message : String(error));
  }
}
