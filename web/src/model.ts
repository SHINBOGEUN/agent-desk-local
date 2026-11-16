// Pure view logic for the dashboard: turns stored run events into the timeline
// the screens draw. No React and no DOM here, so it runs under node:test.

export interface GateResult {
  gate: string;
  ok: boolean;
  skipped?: boolean;
  attempt?: number;
  detail: string;
  problems?: string[];
}

/** The parts of a stored RunEvent the dashboard reads. Unknown event types are ignored. */
export type RunEventData =
  | { type: 'run_started'; request: string; runtimes?: Record<string, string> }
  | { type: 'step_started'; step: string; role: string }
  | { type: 'step_finished'; step: string; ok: boolean; detail: string }
  | { type: 'gate'; result: GateResult }
  | { type: 'redo'; attempt: number; mode: string; reasons: string[] }
  | { type: 'retry'; step: string; reason: string }
  | { type: 'report'; step: string; kind: string; accepted: boolean; detail: string }
  | { type: 'user_question'; step: string; question: string; answered: boolean }
  | { type: 'run_finished'; status: string; reason: string }
  | { type: 'runtime'; step: string; role: string; event: { type: string; [key: string]: unknown } };

export interface StoredEvent {
  seq: number;
  at: string;
  type: string;
  data: RunEventData;
}

export interface TimelineStep {
  step: string;
  role: string;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  detail: string;
  gates: GateResult[];
  redo: { attempt: number; mode: string; reasons: string[] }[];
  retries: string[];
  reports: { kind: string; accepted: boolean; detail: string }[];
  messages: string[];
  commands: number;
  fileChanges: number;
}

export interface Timeline {
  steps: TimelineStep[];
  finished: { status: string; reason: string } | null;
  lastSeq: number;
  /** Runtime per role ("codex" / "claude"), from run_started. */
  runtimes?: Record<string, string>;
  /** Questions agents asked the user, in order. */
  questions?: { step: string; question: string; answered: boolean }[];
}

const emptyStep = (step: string, role: string, at: string): TimelineStep => ({ step, role, startedAt: at, finishedAt: null, ok: null, detail: '', gates: [], redo: [], retries: [], reports: [], messages: [], commands: 0, fileChanges: 0 });

/** Adds events to a timeline and returns a new one. Safe to call with already-seen events (they are skipped by seq). */
export function applyEvents(timeline: Timeline, events: StoredEvent[]): Timeline {
  let steps = timeline.steps;
  let finished = timeline.finished;
  let lastSeq = timeline.lastSeq;
  let runtimes = timeline.runtimes;
  let questions = timeline.questions;
  const copy = (): TimelineStep[] => {
    if (steps === timeline.steps) steps = timeline.steps.map(step => ({ ...step, gates: [...step.gates], redo: [...step.redo], retries: [...step.retries], reports: [...step.reports], messages: [...step.messages] }));
    return steps;
  };
  const current = (): TimelineStep | undefined => copy().at(-1);
  for (const stored of events) {
    if (stored.seq <= lastSeq) continue;
    lastSeq = stored.seq;
    const event = stored.data;
    switch (event.type) {
      case 'step_started': copy().push(emptyStep(event.step, event.role, stored.at)); break;
      case 'step_finished': { const step = current(); if (step) { step.finishedAt = stored.at; step.ok = event.ok; step.detail = event.detail; } break; }
      case 'gate': current()?.gates.push(event.result); break;
      case 'redo': current()?.redo.push({ attempt: event.attempt, mode: event.mode, reasons: event.reasons }); break;
      case 'retry': current()?.retries.push(event.reason); break;
      case 'report': current()?.reports.push({ kind: event.kind, accepted: event.accepted, detail: event.detail }); break;
      case 'runtime': {
        const step = current();
        if (!step) break;
        const inner = event.event;
        if (inner.type === 'command') step.commands++;
        else if (inner.type === 'file_change') step.fileChanges++;
        else if (inner.type === 'message' && typeof inner.text === 'string' && inner.final === true) step.messages.push(inner.text);
        break;
      }
      case 'run_finished': finished = { status: event.status, reason: event.reason }; break;
      case 'run_started': if (event.runtimes) runtimes = { ...event.runtimes }; break;
      case 'user_question': questions = [...(questions ?? []), { step: event.step, question: event.question, answered: event.answered }]; break;
      default: break;
    }
  }
  if (lastSeq === timeline.lastSeq) return timeline;
  return { steps, finished, lastSeq, ...(runtimes ? { runtimes } : {}), ...(questions ? { questions } : {}) };
}

export const emptyTimeline = (): Timeline => ({ steps: [], finished: null, lastSeq: 0 });

export function buildTimeline(events: StoredEvent[]): Timeline {
  return applyEvents(emptyTimeline(), events);
}

export const STATUS_LABEL: Record<string, string> = {
  running: 'Running',
  completed: 'Completed',
  needs_review: 'Needs review',
  needs_user: 'Needs your answer',
  interrupted: 'Interrupted',
  failed: 'Failed',
};

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'accent';

export function statusTone(status: string): Tone {
  if (status === 'completed') return 'success';
  if (status === 'needs_review' || status === 'needs_user' || status === 'interrupted') return 'warning';
  if (status === 'failed') return 'danger';
  if (status === 'running') return 'accent';
  return 'neutral';
}

export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '-';
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${seconds % 60} s`;
}

/** One line for a gate chip, for example "G4 failed" or "G3 skipped". */
export function gateLabel(gate: GateResult): string {
  const name = gate.attempt ? `${gate.gate}#${gate.attempt}` : gate.gate;
  return `${name} ${gate.skipped ? 'skipped' : gate.ok ? 'ok' : 'failed'}`;
}

/** Counts of final gate outcomes across all steps, in first-seen order of the gate name. */
export function gateSummary(timeline: Timeline): { gate: string; ok: number; failed: number; skipped: number }[] {
  const order: string[] = [];
  const counts = new Map<string, { ok: number; failed: number; skipped: number }>();
  for (const step of timeline.steps) {
    for (const result of step.gates) {
      if (!counts.has(result.gate)) { counts.set(result.gate, { ok: 0, failed: 0, skipped: 0 }); order.push(result.gate); }
      const entry = counts.get(result.gate)!;
      if (result.skipped) entry.skipped++; else if (result.ok) entry.ok++; else entry.failed++;
    }
  }
  return order.map(gate => ({ gate, ...counts.get(gate)! }));
}

export function stepDurationMs(step: TimelineStep): number | null {
  if (!step.finishedAt) return null;
  const ms = Date.parse(step.finishedAt) - Date.parse(step.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export interface RoleStat { role: string; steps: number; durationMs: number; tokens: number }

/** Time and tokens per role. Usage rows are matched to steps by step name; a suffix after ":" or "#" is ignored. */
export function roleSummary(timeline: Timeline, usage: { stepId: string; usage: { totalTokens: number } }[]): RoleStat[] {
  const stats = new Map<string, RoleStat>();
  const roleOf = new Map<string, string>();
  const stat = (role: string): RoleStat => { if (!stats.has(role)) stats.set(role, { role, steps: 0, durationMs: 0, tokens: 0 }); return stats.get(role)!; };
  for (const step of timeline.steps) {
    const entry = stat(step.role);
    entry.steps++;
    entry.durationMs += stepDurationMs(step) ?? 0;
    if (!roleOf.has(step.step)) roleOf.set(step.step, step.role);
  }
  for (const row of usage) {
    const role = roleOf.get(row.stepId) ?? roleOf.get(row.stepId.split(/[:#]/)[0] ?? '') ?? 'other';
    stat(role).tokens += row.usage.totalTokens;
  }
  return [...stats.values()];
}

/** Minutes until a reset time given in epoch seconds; null when unknown or already past. */
export function minutesUntil(resetsAtSeconds: number | null, nowMs: number): number | null {
  if (resetsAtSeconds === null) return null;
  const minutes = Math.round((resetsAtSeconds * 1000 - nowMs) / 60000);
  return minutes > 0 ? minutes : null;
}

export interface BenchTask { runs: number; success: number; meanTokens: number | null; meanAgents: number | null; meanMinutes: number | null }
export interface BenchSummary {
  label: string; enabledAgents: number | null; runs: number; excluded: number;
  successRate: number | null; claimedRate: number | null; falseCompletionRate: number | null;
  meanTokens: number | null; medianTokens: number | null; meanAgents: number | null; meanMinutes: number | null; meanAccountPercent: number | null;
  perTask: Record<string, BenchTask>;
}
export interface BenchSet { id: 'standard' | 'hard' | 'general'; baseline: BenchSummary | null; challengers: BenchSummary[] }

/** Task set of a label: "-hard" labels are the hard set, "-general" labels the generality set (Python and web samples), the rest standard. */
export const benchSetOf = (label: string): BenchSet['id'] => (label.endsWith('-hard') ? 'hard' : label.endsWith('-general') ? 'general' : 'standard');

/** Groups results by task set and picks the v1 label as the baseline. Only sets with something to show are returned. */
export function benchSets(summaries: BenchSummary[]): BenchSet[] {
  const sets: BenchSet[] = [];
  for (const id of ['standard', 'hard', 'general'] as const) {
    const members = summaries.filter(summary => benchSetOf(summary.label) === id);
    if (!members.length) continue;
    sets.push({ id, baseline: members.find(summary => summary.label.startsWith('v1')) ?? null, challengers: members.filter(summary => !summary.label.startsWith('v1')) });
  }
  return sets;
}

/** Change from before to after in percent, rounded; null when either side is missing or the baseline is zero. */
export function changePercent(before: number | null, after: number | null): number | null {
  if (before === null || after === null || before === 0) return null;
  return Math.round(((after - before) / before) * 100);
}

/** Builder/reviewer runtime choice offered in the dashboard; '' means "use the project's config". */
export type RuntimeMode = 'codex' | 'claude' | 'codex+claude' | 'claude+codex';
export const RUNTIME_MODES: readonly RuntimeMode[] = ['codex+claude', 'claude+codex', 'codex', 'claude'];

/** Which runtimes a mode needs, so the UI can warn when one is not installed. */
export function modeNeeds(mode: RuntimeMode): ('codex' | 'claude')[] {
  return [...new Set(mode.split('+'))] as ('codex' | 'claude')[];
}

/** Last folder name of a path, for the sidebar. */
export function projectName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

export interface ProjectEntry { path: string; name: string; lastRunAt: string | null; runs: number; active: boolean; bench: boolean }

/** Workspaces made by the benchmark runner (<tmp>/agent-desk-bench/<label>/<task>-r<n>-<stamp>); same rule as the server. */
export const isBenchWorkspace = (path: string): boolean => /[\\/]agent-desk-bench(?:-validate-[^\\/]*)?[\\/]/.test(path);

/**
 * Projects for the sidebar: every folder the user opened (saved) plus every
 * folder that has runs, newest activity first. Paths compare case-insensitively
 * on Windows-style paths so C:\\a and c:\\a are one project.
 */
export function projectList(saved: string[], runs: { project: string; startedAt: string }[], activeProject: string | null): ProjectEntry[] {
  const key = (path: string): string => (/^[a-z]:\\/i.test(path) ? path.toLowerCase() : path).replace(/[\\/]+$/, '');
  const map = new Map<string, ProjectEntry>();
  const touch = (path: string): ProjectEntry => {
    const k = key(path);
    let entry = map.get(k);
    if (!entry) { entry = { path, name: projectName(path), lastRunAt: null, runs: 0, active: false, bench: isBenchWorkspace(path) }; map.set(k, entry); }
    return entry;
  };
  for (const path of saved) if (path.trim()) touch(path);
  for (const run of runs) {
    const entry = touch(run.project);
    entry.runs++;
    if (!entry.lastRunAt || run.startedAt > entry.lastRunAt) entry.lastRunAt = run.startedAt;
  }
  if (activeProject) { const entry = map.get(key(activeProject)); if (entry) entry.active = true; }
  return [...map.values()].sort((a, b) => (b.lastRunAt ?? '').localeCompare(a.lastRunAt ?? '') || a.name.localeCompare(b.name));
}

export const sameProject = (a: string, b: string): boolean => {
  const key = (path: string): string => (/^[a-z]:\\/i.test(path) ? path.toLowerCase() : path).replace(/[\\/]+$/, '');
  return key(a) === key(b);
};
