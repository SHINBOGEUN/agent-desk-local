// Runs one request through a workflow: classify -> (answer | build). The order
// of steps, the roles, access levels, gates, REDO and the final status are all
// decided here in code. Models only work inside steps.

import type { Access, AnswerReport, ApprovalDecision, ApprovalRequest, BuilderReport, PlanReport, ResearchReport, HarnessTools, Requirement, RoleId, Runtime, RunStatus, Session, StepKind, TokenUsage, UserQuestion, VerifierReport } from '#core';
import { UsageLedger } from '#core';
import { ReportCollector } from '#tools-mcp';
import { classifyFailure } from './failure.ts';
import type { FailureType } from './failure.ts';
import { checkBudget, checkChangeReport, checkNoChanges, runVerify, detectVerify } from './gates.ts';
import type { GateResult } from './gates.ts';
import { renderDiff } from './diff-text.ts';
import { LeadCollector } from './lead-report.ts';
import { commandClaimErrors, encodingDamageErrors, findingLocationErrors, missingSourceErrors, skillsTouched, staleFindingErrors } from './evidence.ts';
import type { ObservedCommand } from './evidence.ts';
import { buildPrompt, classifyPrompt, freshRedoPrompt, instructionsFor, planPrompt, redoPrompt, reportReminder, researchPrompt } from './prompts.ts';
import { DEFAULT_AUTO_LIMITS, decideReview, reviewPrompt, selfReviewPrompt } from './review.ts';
import type { PreviousReview } from './review.ts';
import { decideApproval } from './approval.ts';
import { createRestorePoint } from './restore-point.ts';
import type { RestorePointInfo } from './restore-point.ts';
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
  /** The turn this session is playing now. Parallel sessions (researchers) each stop only their own turn. */
  turn?: { stop: AbortController; endedByReport: boolean } | null;
}

interface TurnOutcome {
  status: 'completed' | 'interrupted' | 'failed';
  error?: string;
}

/** Why a step could not produce its report. */
type StepFailure =
  | { kind: 'interrupted' }
  | { kind: 'budget'; reason: string; step: StepKind }
  | { kind: 'failed'; reason: string; type: FailureType; step?: StepKind }
  | { kind: 'needs_user'; question: string };

const DEFAULT_REDO_LIMIT = 2;
const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;

class RunContext {
  readonly config: RunConfig;
  readonly events: RunEvent[] = [];
  /** The harness's own messages in the run's language. */
  say(english: string, korean: string): string { return this.config.language === 'ko' ? korean : english; }
  readonly gates: GateResult[] = [];
  readonly warnings: string[] = [];
  restorePoint?: RestorePointInfo;
  memorySuggestions: string[] = [];
  leadMemory: string[] = [];
  /** Commands the runtime really ran, per step (checked against builder.commandsRun). */
  readonly commands = new Map<StepKind, ObservedCommand[]>();
  /** Skills whose SKILL.md a session opened: "role:skill" once per step. */
  readonly skillsRead: { step: StepKind; role: RoleId; skill: string }[] = [];
  readonly attempts: { attempt: number; summary: string; changedFiles: string[]; sentBackFor: string[] }[] = [];
  readonly modelsUsed: Partial<Record<RoleId, string>> = {};
  readonly ledger = new UsageLedger();
  readonly startedAt = Date.now();
  readonly #turns = new Map<string, number>();
  readonly #budgetController = new AbortController();
  readonly retried = new Set<string>();
  pendingQuestion: string | null = null;
  budgetHit: string | null = null;
  /** The turn being played. Once its report is accepted the harness ends it: the model's closing message after that is never used, but would cost a whole model call. */
  currentTurn: { stop: AbortController; endedByReport: boolean } | null = null;
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
    const gate = checkBudget({ attempt, language: this.config.language, budget: this.config.budget, usage: this.ledger.total(), elapsedMs: Date.now() - this.startedAt });
    if (gate.ok) return true;
    this.budgetHit ??= gate.problems[0] ?? 'budget exceeded';
    this.recordGate(gate);
    if (abortTurn) this.#budgetController.abort();
    return false;
  }
}

/** Roles are read-only except the builder; a role file may only restrict that, never widen it. */
function accessFor(ctx: RunContext, role: RoleId): Access {
  const configured = ctx.config.access?.[role];
  if (role !== 'builder') return 'read-only';
  return configured ?? 'workspace-write';
}

function toolsFor(ctx: RunContext, step: StepKind, role: RoleId, holder: Holder): HarnessTools {
  return {
    async submitReport(report) {
      const result = await holder.current.submit(report);
      ctx.emit({ type: 'report', step, kind: role, accepted: result.ok, detail: result.ok ? (result.message.split('\n')[0] ?? '') : result.message.split('\n').slice(0, 6).join('\n').slice(0, 900) });
      if (result.ok && holder.current.done()) {
        // End the turn once the tool answer is on its way back (setImmediate), so the session history stays whole.
        const turn = holder.turn ?? null;
        if (turn) setImmediate(() => { if (!turn.stop.signal.aborted) { turn.endedByReport = true; turn.stop.abort(); } });
      }
      return result;
    },
    async readHistory(query) {
      const read = ctx.config.readHistory;
      ctx.emit({ type: 'runtime', step, role, event: { type: 'tool', name: `read_history:${query.runId !== undefined ? `#${query.runId}` : query.search ?? ''}` } });
      return read ? await read(query) : 'No history is available for this run.';
    },
    async readNotes(query) {
      const read = ctx.config.readNotes;
      ctx.emit({ type: 'runtime', step, role, event: { type: 'tool', name: `read_notes:${query.path ?? query.search ?? ''}` } });
      return read ? await read(query) : 'This project has no notes.';
    },
    async approve(request: ApprovalRequest): Promise<ApprovalDecision> {
      const decision = decideApproval(request, { cwd: ctx.config.cwd, canWrite: accessFor(ctx, role) === 'workspace-write', ...(ctx.config.allowCommands ? { allowCommands: ctx.config.allowCommands } : {}) });
      ctx.emit({ type: 'runtime', step, role, event: { type: 'approval_request', id: request.toolUseId ?? request.toolName, kind: request.toolName, detail: { input: request.input, decision: decision.behavior, ...(decision.behavior === 'deny' ? { message: decision.message } : {}) } } });
      return decision;
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

async function playTurn(ctx: RunContext, step: StepKind, role: RoleId, session: Session, holder: Holder, text: string, images?: string[]): Promise<TurnOutcome> {
  const turn = ctx.nextTurn(step);
  let outcome: TurnOutcome = { status: 'failed', error: 'runtime ended the turn without a result' };
  const current = { stop: new AbortController(), endedByReport: false };
  ctx.currentTurn = current;
  holder.turn = current;
  const signal = AbortSignal.any([ctx.signal, current.stop.signal]);
  for await (const event of session.runTurn({ text, ...(images?.length ? { images } : {}) }, signal)) {
    ctx.emit({ type: 'runtime', step, role, event });
    if (event.type === 'command') { const list = ctx.commands.get(step) ?? []; list.push({ command: event.command, exitCode: event.exitCode }); ctx.commands.set(step, list); }
    if (event.type === 'command' || event.type === 'file_read') {
      for (const skill of skillsTouched(event, ctx.config.skills?.[role] ?? [])) {
        if (ctx.skillsRead.some(entry => entry.step === step && entry.role === role && entry.skill === skill)) continue;
        ctx.skillsRead.push({ step, role, skill });
        ctx.emit({ type: 'skill_read', step, role, skill });
      }
    }
    if (event.type === 'usage') { ctx.ledger.record(step, turn, event.delta); ctx.enforceBudget(ctx.redo, true); }
    if (event.type === 'session_info') ctx.modelsUsed[role] ??= event.model;
    if (event.type === 'turn_end') outcome = { status: event.status, ...(event.error ? { error: event.error } : {}) };
  }
  if (ctx.currentTurn === current) ctx.currentTurn = null;
  if (holder.turn === current) holder.turn = null;
  // Stopped by the harness after an accepted report: the step is done, not interrupted (unless the user stopped the run too).
  if (current.endedByReport && !ctx.signal.aborted && outcome.status !== 'completed') {
    outcome = { status: 'completed' };
  }
  return outcome;
}

const failedStep = (reason: string, type: FailureType = classifyFailure(reason), step?: StepKind): StepFailure => ({ kind: 'failed', reason, type, ...(step ? { step } : {}) });

async function openSession(ctx: RunContext, step: StepKind, role: RoleId, holder: Holder): Promise<Session> {
  const { config } = ctx;
  const effort = config.effort?.[role] ?? (role === 'lead' && step === 'classify' ? 'low' : undefined);
  const model = config.models?.[role];
  const skills = config.skills?.[role] ?? [];
  return ctx.runtimeFor(role).startSession({
    role, cwd: config.cwd, access: accessFor(ctx, role), skills, tools: toolsFor(ctx, step, role, holder),
    // The history goes to the lead (to read follow-ups) and the builder (to build on earlier work); the verifier
    // judges the change on its own and the researcher only its angle.
    instructions: instructionsFor(role, config.roleNotes?.[role], step, config.projectMemory, skills, config.language, role === 'lead' || role === 'builder' ? config.projectHistory : undefined, role === 'lead' || role === 'builder' ? config.vaultIndex : undefined),
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
    // Images the user attached go with the first prompt of every step that reads the request.
    const outcome = await playTurn(ctx, step, role, session, holder, text, text === prompt && step !== 'review' ? ctx.config.images : undefined);
    if (ctx.budgetHit) return { kind: 'budget', reason: ctx.budgetHit, step };
    if (outcome.status === 'interrupted' || ctx.config.signal?.aborted) return { kind: 'interrupted' };
    if (outcome.status === 'failed') return failedStep(outcome.error ?? 'turn failed', undefined, step);
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
  return { status, reason, requirements: [], gates: ctx.gates, redo: ctx.redo, warnings: ctx.warnings, unverified: [], usage, usageEntries: ctx.ledger.entries(), events: ctx.events, ...(ctx.restorePoint ? { restorePoint: ctx.restorePoint } : {}), ...((memory => (memory.length ? { memorySuggestions: memory } : {}))([...new Set([...ctx.leadMemory, ...ctx.memorySuggestions])].slice(0, 5))), ...(ctx.skillsRead.length ? { skillsRead: ctx.skillsRead } : {}), ...(ctx.attempts.length > 1 ? { attempts: ctx.attempts } : {}), ...(Object.keys(ctx.modelsUsed).length ? { modelsUsed: ctx.modelsUsed } : {}), ...extra };
}

function failureResult(ctx: RunContext, failure: StepFailure, extra: Partial<RunResult> = {}): RunResult {
  if (failure.kind === 'interrupted') return finish(ctx, 'interrupted', ctx.say('The run was stopped before it finished.', '실행이 끝나기 전에 중지되었습니다.'), extra);
  if (failure.kind === 'budget') return finish(ctx, 'interrupted', ctx.say(`Stopped by the budget. ${failure.reason}`, `예산 한도에 도달해 중단되었습니다. ${failure.reason}`), { ...extra, resume: { step: failure.step, redo: ctx.redo, note: ctx.say('Start a new run with the remaining requirements; earlier changes stay in the folder.', '남은 요구사항으로 새 실행을 시작하세요. 이전 변경은 폴더에 그대로 남아 있습니다.') } });
  if (failure.kind === 'needs_user') return finish(ctx, 'needs_user', ctx.say(`The agent needs an answer from you: ${failure.question}`, `에이전트가 답변을 기다립니다: ${failure.question}`), extra);
  if (failure.type === 'limit') return finish(ctx, 'interrupted', ctx.say(
    `Stopped: the usage limit was reached (${failure.reason}). Resume after the limit resets, or pick the other runtime in the team choice and resume now; earlier changes stay in the folder.`,
    `사용량 한도에 도달해 중단되었습니다 (${failure.reason}). 한도가 풀린 뒤 이어하거나, 팀 선택에서 다른 런타임을 골라 지금 이어하세요. 이전 변경은 폴더에 그대로 남아 있습니다.`,
  ), { ...extra, failureType: 'limit', resume: { step: failure.step ?? 'build', redo: ctx.redo, note: ctx.say('Resume with the remaining requirements once a runtime has allowance left.', '사용량이 남은 런타임으로 남은 요구사항을 이어서 진행하세요.') } });
  if (failure.type === 'auth') return finish(ctx, 'interrupted', ctx.say(
    `Stopped: a runtime's sign-in expired (${failure.reason}). Sign in again (Claude: run \`claude\` in a terminal and use /login; Codex: \`codex login\`), then resume; or pick the other runtime in the team choice and resume now. Earlier changes stay in the folder.`,
    `런타임 로그인이 만료되어 중단되었습니다 (${failure.reason}). 다시 로그인한 뒤(Claude: 터미널에서 \`claude\` 실행 후 /login, Codex: \`codex login\`) 이어하기를 누르세요. 팀 선택에서 다른 런타임을 골라 지금 이어해도 됩니다. 이전 변경은 폴더에 그대로 남아 있습니다.`,
  ), { ...extra, failureType: 'auth', resume: { step: failure.step ?? 'build', redo: ctx.redo, note: ctx.say('Resume after signing in again.', '다시 로그인한 뒤 이어서 진행하세요.') } });
  if (failure.type === 'environment') return finish(ctx, 'failed', ctx.say(`Environment problem: ${failure.reason} Fix it (run \`agent-desk doctor\`), then start the run again.`, `환경 문제: ${failure.reason} \`agent-desk doctor\`로 확인해 고친 뒤 다시 실행하세요.`), { ...extra, failureType: 'environment' });
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
  const left = outcome.failed.length ? ctx.say(` These could not be restored: ${outcome.failed.join(', ')}.`, ` 다음 파일은 복원하지 못했습니다: ${outcome.failed.join(', ')}.`) : ctx.say(' They were restored.', ' 원래대로 복원했습니다.');
  return ctx.say(`A step changed protected paths (${changed.all.join(', ')}).${left}`, `한 단계가 보호된 경로(${changed.all.join(', ')})를 바꿨습니다.${left}`);
}

async function runClassify(ctx: RunContext, request: string, lead: LeadCollector): Promise<RunResult | null> {
  ctx.emit({ type: 'step_started', step: 'classify', role: 'lead' });
  const before = takeSnapshot(ctx.config.cwd, { mode: 'stat', ignore: ctx.ignore });
  const holder: Holder = { current: { submit: lead.submit, done: () => lead.classify !== null } };
  const failure = await withTransientRetry(ctx, 'classify', async () => {
    let session: Session | null = null;
    try {
      session = await openSession(ctx, 'classify', 'lead', holder);
      return await playUntilReport(ctx, 'classify', 'lead', session, holder, classifyPrompt(request, ctx.config.previousBrief), reportReminder('your report (workflow, requirements, reason, and the answer when the workflow is "answer")'));
    } catch (error) {
      return failedStep(error instanceof Error ? error.message : String(error));
    } finally {
      await session?.close().catch(() => {});
    }
  });
  const after = takeSnapshot(ctx.config.cwd, { mode: 'stat', ignore: ctx.ignore });
  const violation = protectedViolation(ctx, before, after);
  const changes = ctx.recordGate(checkNoChanges({ attempt: 0, language: ctx.config.language, step: 'classify', diff: diffSnapshots(before, after) }));
  ctx.emit({ type: 'step_finished', step: 'classify', ok: !failure && changes.ok && !violation, detail: failure ? 'failed' : 'report accepted' });
  if (violation) return finish(ctx, 'failed', violation);
  if (!changes.ok) return finish(ctx, 'needs_review', changes.problems[0] ?? ctx.say('A read-only step changed files.', '읽기 전용 단계에서 파일이 변경되었습니다.'), failure ? {} : { classify: lead.classify!, workflow: lead.classify!.workflow, requirements: lead.classify!.requirements });
  return failure ? failureResult(ctx, failure) : null;
}


/** Runs a read-only step body between two snapshots: it may not change files or protected paths. */
async function guardedReadOnly(ctx: RunContext, step: StepKind, work: () => Promise<StepFailure | null>): Promise<{ failure: StepFailure | null; stop: RunResult | null }> {
  const before = takeSnapshot(ctx.config.cwd, { mode: 'stat', ignore: ctx.ignore });
  const failure = await work();
  const after = takeSnapshot(ctx.config.cwd, { mode: 'stat', ignore: ctx.ignore });
  const violation = protectedViolation(ctx, before, after);
  const changes = ctx.recordGate(checkNoChanges({ attempt: 0, language: ctx.config.language, step, diff: diffSnapshots(before, after) }));
  if (violation) return { failure, stop: finish(ctx, 'failed', violation) };
  if (!changes.ok) return { failure, stop: finish(ctx, 'needs_review', changes.problems[0] ?? ctx.say('A read-only step changed files.', '읽기 전용 단계에서 파일이 변경되었습니다.')) };
  return { failure, stop: null };
}

async function runPlan(ctx: RunContext, request: string, requirements: Requirement[], base: Partial<RunResult>): Promise<{ plan: PlanReport } | { stop: RunResult }> {
  ctx.emit({ type: 'step_started', step: 'plan', role: 'lead' });
  const collector = new ReportCollector('plan');
  const holder: Holder = { current: { submit: report => collector.submit(report), done: () => collector.report !== null } };
  const { failure, stop } = await guardedReadOnly(ctx, 'plan', () => withTransientRetry(ctx, 'plan', async () => {
    let session: Session | null = null;
    try {
      session = await openSession(ctx, 'plan', 'lead', holder);
      return await playUntilReport(ctx, 'plan', 'lead', session, holder, planPrompt(request, requirements), reportReminder('your plan'));
    } catch (error) {
      return failedStep(error instanceof Error ? error.message : String(error));
    } finally {
      await session?.close().catch(() => {});
    }
  }));
  ctx.emit({ type: 'step_finished', step: 'plan', ok: !failure && !stop, detail: failure ? 'failed' : 'plan accepted' });
  if (stop) return { stop };
  if (failure) return { stop: failureResult(ctx, failure, base) };
  return { plan: collector.report! };
}

const MAX_ANGLES = 3;

async function runInvestigate(ctx: RunContext, request: string, requirements: Requirement[], base: Partial<RunResult>): Promise<RunResult> {
  const angles = requirements.length ? requirements.slice(0, MAX_ANGLES).map(requirement => requirement.text) : [request];
  if (requirements.length > MAX_ANGLES) ctx.warnings.push(`Only the first ${MAX_ANGLES} of ${requirements.length} angles were investigated.`);
  ctx.emit({ type: 'step_started', step: 'research', role: 'researcher' });
  const collectors = angles.map(() => new ReportCollector('research', report => missingSourceErrors(ctx.config.cwd, report.sources, 'research.sources')));
  const { failure, stop } = await guardedReadOnly(ctx, 'research', async () => {
    const outcomes = await Promise.all(angles.map(async (angle, index) => {
      const collector = collectors[index]!;
      const holder: Holder = { current: { submit: report => collector.submit(report), done: () => collector.report !== null } };
      return withTransientRetry(ctx, 'research', async () => {
        let session: Session | null = null;
        try {
          session = await openSession(ctx, 'research', 'researcher', holder);
          return await playUntilReport(ctx, 'research', 'researcher', session, holder, researchPrompt(request, angle), reportReminder('your research report'));
        } catch (error) {
          return failedStep(error instanceof Error ? error.message : String(error));
        } finally {
          await session?.close().catch(() => {});
        }
      });
    }));
    return outcomes.find(outcome => outcome !== null) ?? null;
  });
  ctx.emit({ type: 'step_finished', step: 'research', ok: !failure && !stop, detail: failure ? 'failed' : `${angles.length} report(s) accepted` });
  if (stop) return stop;
  if (failure) return failureResult(ctx, failure, base);
  const reports: ResearchReport[] = collectors.map(collector => collector.report!);
  const text = reports.map((report, index) => [`## ${index + 1}. ${report.angle}`, report.summary, ...report.findings.map(finding => `- ${finding.claim} (${finding.evidence})`)].join('\n')).join('\n\n');
  const answer: AnswerReport = { answer: text, sources: [...new Set(reports.flatMap(report => report.sources))] };
  ctx.emit({ type: 'step_started', step: 'report', role: 'lead' });
  ctx.emit({ type: 'step_finished', step: 'report', ok: true, detail: 'investigation assembled' });
  return finish(ctx, 'completed', ctx.say(`Investigated ${reports.length} angle(s). No files were changed.`, `${reports.length}개 관점을 조사했습니다. 변경된 파일은 없습니다.`), { ...base, answer, research: reports });
}

async function runBuild(ctx: RunContext, request: string, requirements: Requirement[], base: Partial<RunResult>, plan?: PlanReport): Promise<RunResult> {
  const { config } = ctx;
  const redoLimit = config.redoLimit ?? DEFAULT_REDO_LIMIT;
  const before = takeSnapshot(config.cwd, { ignore: ctx.ignore, keepContent: true });
  if (config.restorePointDir) {
    const point = createRestorePoint(config.cwd, config.restorePointDir, before);
    if (point.ok) ctx.restorePoint = { dir: point.dir, files: point.files, bytes: point.bytes };
    else ctx.warnings.push(`No restore point was made: ${point.reason}. Revert will not be available for this run.`);
  }
  const newCollector = (): ReportCollector<'builder'> => new ReportCollector('builder', report => {
    const now = diffSnapshots(before, takeSnapshot(config.cwd, { ignore: ctx.ignore }));
    return [...builderCoverageErrors(requirements, report), ...commandClaimErrors(report.commandsRun, ctx.commands.get('build') ?? []), ...encodingDamageErrors(config.cwd, before, [...now.added, ...now.modified])];
  });
  let collector = newCollector();
  const holder: Holder = { current: { submit: report => collector.submit(report), done: () => collector.report !== null } };
  let session: Session | null = null;
  const closeSession = async () => { await session?.close().catch(() => {}); session = null; };
  let prompt = buildPrompt(request, requirements, plan);
  let fresh = prompt;
  // The last REDO review: its findings and the files as they were then, so a re-review only covers what changed since.
  let lastReview: { snapshot: Snapshot; findings: VerifierReport['blocking'] } | null = null;
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
      ctx.memorySuggestions = report.memorySuggestions ?? [];
      const attemptRecord = { attempt: ctx.redo + 1, summary: report.summary, changedFiles: report.changedFiles, sentBackFor: [] as string[] };
      ctx.attempts.push(attemptRecord);
      const after = takeSnapshot(config.cwd, { ignore: ctx.ignore });
      const violation = protectedViolation(ctx, before, after);
      if (violation) {
        ctx.emit({ type: 'step_finished', step: 'build', ok: false, detail: 'protected paths changed' });
        return finish(ctx, 'failed', violation, { ...base, builder: report });
      }
      const g2 = ctx.recordGate(checkChangeReport({ attempt: ctx.redo, language: config.language, cwd: config.cwd, reported: report.changedFiles, diff: diffSnapshots(before, after), ignore: ctx.ignore }));
      const configured = config.verify ?? [];
      const detected = configured.length ? [] : detectVerify(config.cwd);
      const verified = await runVerify({ attempt: ctx.redo, language: config.language, cwd: config.cwd, commands: configured.length ? configured : detected, timeoutMs: config.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS });
      if (detected.length) verified.result.data = { ...verified.result.data, detected: true };
      const g3 = ctx.recordGate(verified.result);
      if (g3.data?.unavailable) {
        ctx.emit({ type: 'step_finished', step: 'build', ok: false, detail: 'verify command unavailable' });
        return failureResult(ctx, failedStep(g3.problems[0] ?? 'A verify command could not be run.', 'environment'), { ...base, builder: report });
      }
      const notDone = report.requirements.filter(entry => entry.status === 'not_done').map(entry => `Requirement ${entry.id} is reported as not done${entry.evidence ? `: ${entry.evidence}` : ''}.`);
      let reasons = [...g2.problems, ...g3.problems, ...notDone];
      let review: ReviewOutcome = { kind: 'skipped', reason: 'earlier gates failed' };
      if (!reasons.length) {
        const previous = lastReview ? { snapshot: lastReview.snapshot, findings: lastReview.findings, diff: diffSnapshots(lastReview.snapshot, after) } : undefined;
        review = await runReview(ctx, { request, requirements, before, diff: diffSnapshots(before, after), g2, g3, ...(plan ? { plannedFiles: plan.files } : {}), ...(session ? { self: { session, holder } } : {}), ...(previous ? { previous } : {}) });
        if (review.kind === 'stop') {
          return review.failure ? failureResult(ctx, review.failure, { ...base, builder: report }) : finish(ctx, review.status, review.reason, { ...base, builder: report });
        }
        if (review.kind === 'verdict' && review.report.verdict === 'REDO') lastReview = { snapshot: takeSnapshot(config.cwd, { ignore: ctx.ignore, keepContent: true }), findings: review.report.blocking };
        if (review.kind === 'verdict' && review.report.verdict === 'REDO') reasons = review.report.blocking.map(finding => `Review: ${finding.reason}${finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ''})` : ''}. Evidence: ${finding.evidence}`);
      }
      if (!reasons.length) return completeBuild(ctx, report, g2, g3, base, review);
      if (!ctx.enforceBudget(ctx.redo, false)) {
        ctx.emit({ type: 'step_finished', step: 'build', ok: false, detail: 'budget' });
        return failureResult(ctx, { kind: 'budget', reason: ctx.budgetHit ?? 'budget exceeded', step: 'build' }, { ...base, builder: report });
      }
      if (ctx.redo >= redoLimit) {
        ctx.emit({ type: 'step_finished', step: 'build', ok: false, detail: 'redo limit reached' });
        return finish(ctx, 'needs_review', ctx.say(`Still failing after ${ctx.redo} redo round(s): ${reasons[0]?.split('\n')[0] ?? 'unknown problem'}`, `재작업 ${ctx.redo}회 후에도 실패합니다: ${reasons[0]?.split('\n')[0] ?? '원인을 알 수 없음'}`), { ...base, builder: report, unverified: report.unverified });
      }
      attemptRecord.sentBackFor = reasons.map(reason => reason.split('\n')[0] ?? reason);
      ctx.redo++;
      const mode = ctx.redo === 1 ? 'same-session' : 'new-session';
      ctx.emit({ type: 'redo', attempt: ctx.redo, mode, reasons });
      fresh = freshRedoPrompt(request, requirements, reasons, report.summary, plan);
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
async function runReview(ctx: RunContext, input: { request: string; requirements: Requirement[]; before: Snapshot; diff: Diff; g2: GateResult; g3: GateResult; plannedFiles?: string[]; self?: { session: Session; holder: Holder }; previous?: { snapshot: Snapshot; findings: VerifierReport['blocking']; diff: Diff } }): Promise<ReviewOutcome> {
  const { config } = ctx;
  const rendered = renderDiff({ cwd: config.cwd, before: input.before, diff: input.diff });
  // A re-review sees only the diff since the last review (fewer tokens, no moved goalposts).
  const since = input.previous ? renderDiff({ cwd: config.cwd, before: input.previous.snapshot, diff: input.previous.diff }) : null;
  const previous: PreviousReview | undefined = input.previous ? { findings: input.previous.findings, changedSince: input.previous.diff.all } : undefined;
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
  const planned = input.plannedFiles?.map(file => file.replace(/\\/g, '/').replace(/^\.\//, ''));
  const unplannedFiles = planned?.length ? input.diff.all.filter(file => !planned.includes(file)) : [];
  const facts = { request: input.request, requirements: input.requirements, verifyLines, diffText: since ? since.text : rendered.text, changedFiles: input.diff.all, testFiles, unplannedFiles, ...(previous ? { previous } : {}) };
  const selfCheck = config.review === 'self' && input.self !== undefined;
  const prompt = selfCheck ? selfReviewPrompt(facts) : reviewPrompt(facts);
  const earlierFiles = input.previous?.findings.flatMap(finding => (finding.file ? [finding.file] : [])) ?? [];
  const collector = new ReportCollector('verifier', report => [
    ...(report.verdict === 'BLOCKED' && !report.blocking.length ? ['verifier.blocking: BLOCKED needs at least one entry that says what could not be decided and why'] : []),
    ...findingLocationErrors(config.cwd, report, { deleted: input.diff.deleted, requirementIds: input.requirements.map(requirement => requirement.id) }),
    ...(previous && report.verdict === 'REDO' ? staleFindingErrors(report.blocking, { changedSince: previous.changedSince, earlierFiles }) : []),
  ]);
  const holder: Holder = { current: { submit: report => collector.submit(report), done: () => collector.report !== null } };
  ctx.emit({ type: 'step_started', step: 'review', role: selfCheck ? 'builder' : 'verifier' });
  const guardBefore = takeSnapshot(config.cwd, { mode: 'stat', ignore: ctx.ignore });
  const failure = selfCheck ? await (async () => {
    // Same session as the build: the report tool is pointed at the verifier collector for this turn only.
    const self = input.self!;
    const builderTarget = self.holder.current;
    self.holder.current = holder.current;
    try { return await playUntilReport(ctx, 'review', 'builder', self.session, self.holder, prompt, reportReminder('a verifier report about your own work')); }
    catch (error) { return failedStep(error instanceof Error ? error.message : String(error)); }
    finally { self.holder.current = builderTarget; }
  })() : await withTransientRetry(ctx, 'review', async () => {
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
    if (failure.kind === 'failed' && failure.type !== 'environment' && failure.type !== 'limit' && failure.type !== 'auth') return { kind: 'stop', status: 'needs_review', reason: `The review did not produce a verdict: ${failure.reason}` };
    return { kind: 'stop', status: 'failed', reason: '', failure };
  }
  const verdict = collector.report!;
  ctx.recordGate({ gate: 'G4', ok: verdict.verdict === 'PASS', attempt: ctx.redo, detail: `verdict ${verdict.verdict}`, problems: verdict.blocking.map(finding => finding.reason), data: { optional: verdict.optional } });
  ctx.emit({ type: 'step_finished', step: 'review', ok: verdict.verdict !== 'REDO', detail: `verdict ${verdict.verdict}` });
  return { kind: 'verdict', report: verdict };
}

function completeBuild(ctx: RunContext, report: BuilderReport, g2: GateResult, g3: GateResult, base: Partial<RunResult>, review: ReviewOutcome): RunResult {
  const testFiles = (g2.data?.testFilesChanged as string[] | undefined) ?? [];
  if (testFiles.length) ctx.warnings.push(ctx.say(`Test or check files changed: ${testFiles.join(', ')}. Confirm the change was required by the request.`, `테스트·검사 파일이 바뀌었습니다: ${testFiles.join(', ')}. 요청에 필요한 변경이었는지 확인하세요.`));
  const openIds = report.requirements.filter(entry => entry.status === 'unverified').map(entry => entry.id);
  const unverified = [...openIds.map(id => ctx.say(`Requirement ${id} was reported as unverified.`, `요구사항 ${id}은(는) 검증되지 않은 것으로 보고되었습니다.`)), ...report.unverified];
  if (g3.skipped) ctx.warnings.push(ctx.say('No automatic verification: no verify commands are configured.', '자동 검증이 없습니다: 검증 명령이 설정되어 있지 않습니다.'));
  if (g3.data?.detected) ctx.warnings.push(ctx.say('No verify command is configured, so the harness ran the project\'s `npm test`. Add it to the verify commands in the settings to keep it.', '검증 명령이 설정되어 있지 않아 프로젝트의 `npm test`를 하네스가 실행했습니다. 계속 쓰려면 설정의 검증 명령에 넣으세요.'));
  const reviewExtra: Partial<RunResult> = review.kind === 'verdict' ? { review: review.report } : review.kind === 'skipped' ? { reviewSkipped: review.reason } : {};
  if (review.kind === 'verdict' && review.report.verdict === 'BLOCKED') {
    const why = review.report.blocking.map(finding => finding.reason).join('; ');
    if (g3.skipped) return finish(ctx, 'needs_review', ctx.say(`The reviewer could not decide and no verify command is configured: ${why}`, `리뷰어가 판단하지 못했고 검증 명령도 설정되어 있지 않습니다: ${why}`), { ...base, ...reviewExtra, builder: report, unverified });
    unverified.push(ctx.say(`Review could not decide: ${why}`, `리뷰가 판단하지 못했습니다: ${why}`));
  }
  ctx.emit({ type: 'step_finished', step: 'build', ok: true, detail: 'gates passed' });
  if (openIds.length && g3.skipped) {
    return finish(ctx, 'needs_review', ctx.say(`The builder could not verify ${openIds.join(', ')} and no verify command is configured to check them.`, `빌더가 ${openIds.join(', ')}을(를) 검증하지 못했고, 확인할 검증 명령도 설정되어 있지 않습니다.`), { ...base, ...reviewExtra, builder: report, unverified });
  }
  ctx.emit({ type: 'step_started', step: 'report', role: 'lead' });
  ctx.emit({ type: 'step_finished', step: 'report', ok: true, detail: 'build reported' });
  const note = unverified.length ? ctx.say(` Not verified by the builder: ${unverified.length} item(s), listed in the result.`, ` 빌더가 검증하지 못한 항목 ${unverified.length}개가 결과에 정리되어 있습니다.`) : '';
  // name only the checks that actually ran: "the gates passed" must not cover a test run that never happened
  const reviewed = review.kind === 'verdict' && review.report.verdict === 'PASS';
  const passed = ctx.say(
    ['the changed-files check', ...(g3.skipped ? [] : ['the tests']), ...(reviewed ? ['the review'] : [])].join(', ').replace(/, ([^,]*)$/, ' and $1'),
    ((list: string[]) => `${list.join(', ')}${objectParticle(list.at(-1) ?? '')}`)(['변경 파일 확인', ...(g3.skipped ? [] : ['테스트']), ...(reviewed ? ['리뷰'] : [])]),
  );
  const noTests = g3.skipped ? ctx.say(' No tests ran: no verify command is configured.', ' 검증 명령이 없어 테스트는 실행하지 않았습니다.') : '';
  return finish(ctx, 'completed', ctx.say(`Every requirement is done; passed ${passed}.${noTests}${note}`, `모든 요구사항이 완료되었고 ${passed} 통과했습니다.${noTests}${note}`), { ...base, ...reviewExtra, builder: report, unverified });
}

export async function runRequest(request: string, config: RunConfig): Promise<RunResult> {
  const ctx = new RunContext(config);
  const single = 'startSession' in config.runtime ? (config.runtime as Runtime) : null;
  const runtimes = Object.fromEntries((['lead', 'builder', 'verifier', 'researcher'] as RoleId[]).map(role => [role, (single ?? (config.runtime as Partial<Record<RoleId, Runtime>>)[role])?.id]).filter(([, id]) => id)) as Partial<Record<RoleId, string>>;
  ctx.emit({ type: 'run_started', request, ...(Object.keys(runtimes).length ? { runtimes } : {}) });
  try {
    const lead = new LeadCollector({ request, cwd: config.cwd, ...(config.noteText ? { noteText: config.noteText } : {}) });
    const stopped = await runClassify(ctx, request, lead);
    if (stopped) return stopped;
    const classify = lead.classify!;
    const base = { workflow: classify.workflow, classify, requirements: classify.requirements };
    // A rule the user stated is offered for the project memory whatever the workflow.
    ctx.leadMemory = lead.memorySuggestions;

    if (classify.workflow === 'answer') {
      ctx.emit({ type: 'step_started', step: 'report', role: 'lead' });
      ctx.emit({ type: 'step_finished', step: 'report', ok: true, detail: 'answered without changing files' });
      return finish(ctx, 'completed', ctx.say('Answered from the project files. No files were changed.', '프로젝트 파일을 바탕으로 답했습니다. 변경된 파일은 없습니다.'), { ...base, answer: lead.answer! });
    }
    if (classify.workflow === 'build') return await runBuild(ctx, request, classify.requirements, base);
    if (classify.workflow === 'investigate') return await runInvestigate(ctx, request, classify.requirements, base);
    if (classify.workflow === 'plan-build') {
      const planned = await runPlan(ctx, request, classify.requirements, base);
      if ('stop' in planned) return planned.stop;
      if (config.confirmPlan && !(await config.confirmPlan(planned.plan, classify.requirements))) {
        return finish(ctx, 'needs_user', ctx.say('You stopped the run after reading the plan. Nothing was changed.', '계획을 읽고 실행을 멈추셨습니다. 변경된 것은 없습니다.'), { ...base, plan: planned.plan });
      }
      return await runBuild(ctx, request, classify.requirements, { ...base, plan: planned.plan }, planned.plan);
    }
    return finish(ctx, 'failed', ctx.say(`The "${classify.workflow}" workflow is not available in this version.`, `"${classify.workflow}" 워크플로는 이 버전에서 사용할 수 없습니다.`), base);
  } catch (error) {
    return finish(ctx, 'failed', error instanceof Error ? error.message : String(error));
  }
}

/** 을 after a final consonant, 를 after a vowel (Korean object particle). */
function objectParticle(word: string): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return code >= 0 && code < 11172 && code % 28 !== 0 ? '을' : '를';
}
