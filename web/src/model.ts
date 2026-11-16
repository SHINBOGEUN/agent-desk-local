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
  | { type: 'run_started'; request: string }
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
}

const emptyStep = (step: string, role: string, at: string): TimelineStep => ({ step, role, startedAt: at, finishedAt: null, ok: null, detail: '', gates: [], redo: [], retries: [], reports: [], messages: [], commands: 0, fileChanges: 0 });

/** Adds events to a timeline and returns a new one. Safe to call with already-seen events (they are skipped by seq). */
export function applyEvents(timeline: Timeline, events: StoredEvent[]): Timeline {
  let steps = timeline.steps;
  let finished = timeline.finished;
  let lastSeq = timeline.lastSeq;
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
      default: break;
    }
  }
  return lastSeq === timeline.lastSeq ? timeline : { steps, finished, lastSeq };
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
