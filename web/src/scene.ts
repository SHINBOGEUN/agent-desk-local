// Pure logic for the agent scene: which role is doing what, and which hand-offs happened.
// The harness (code) passes work between roles, so a "bubble" is a hand-off or a decision, never a chat between agents.

import type { Timeline } from './model.ts';

export type Mood = 'idle' | 'working' | 'done' | 'failed' | 'asking';
export type Speaker = 'lead' | 'builder' | 'verifier' | 'researcher' | 'harness';
export type Tone = 'info' | 'ok' | 'problem';

export interface Robot { role: string; mood: Mood; activity: string | null }
export interface Bubble { id: string; from: string; to: string; text: string; tone: Tone }
export interface Scene { robots: Robot[]; bubbles: Bubble[]; speaking: Bubble | null; gates: { gate: string; ok: boolean; skipped: boolean }[] }

const ROLE_ORDER = ['lead', 'builder', 'verifier', 'researcher'];
const clip = (text: string, max = 140): string => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };

export function sceneOf(timeline: Timeline, asking: boolean): Scene {
  const used = new Set(timeline.steps.map(step => step.role));
  const roles = ROLE_ORDER.filter(role => role !== 'researcher' || used.has(role));
  const running = timeline.finished === null;

  const robots: Robot[] = roles.map(role => {
    const mine = timeline.steps.filter(step => step.role === role);
    const active = running ? mine.find(step => step.finishedAt === null) : undefined;
    if (role === 'lead' && asking) return { role, mood: 'asking', activity: active?.step ?? null };
    if (active) return { role, mood: 'working', activity: active.step };
    const last = mine.at(-1);
    if (!last) return { role, mood: 'idle', activity: null };
    return { role, mood: last.ok === false ? 'failed' : 'done', activity: last.step };
  });

  const bubbles: Bubble[] = [];
  timeline.steps.forEach((step, index) => {
    const previous = timeline.steps[index - 1];
    // The same role again means the harness sent the work back; that bubble comes from the redo itself.
    if (previous && previous.finishedAt && previous.role !== step.role) {
      bubbles.push({ id: `h${index}`, from: previous.role, to: step.role, text: clip(previous.detail || `${previous.step} → ${step.step}`), tone: previous.ok === false ? 'problem' : 'info' });
    }
    step.reports.filter(report => !report.accepted).forEach((report, n) => bubbles.push({ id: `r${index}-${n}`, from: step.role, to: 'harness', text: clip(report.detail), tone: 'problem' }));
    step.redo.forEach(redo => bubbles.push({ id: `d${index}-${redo.attempt}`, from: 'harness', to: 'builder', text: clip(redo.reasons[0] ?? `REDO ${redo.attempt}`), tone: 'problem' }));
  });
  if (timeline.finished) {
    bubbles.push({ id: 'end', from: 'lead', to: 'you', text: clip(timeline.finished.reason), tone: timeline.finished.status === 'completed' ? 'ok' : 'problem' });
  }

  const gates = timeline.steps.flatMap(step => step.gates).map(result => ({ gate: result.gate, ok: result.ok, skipped: result.skipped === true }));
  return { robots, bubbles, speaking: bubbles.at(-1) ?? null, gates };
}

// ---------- role lanes (the "timeline" view of a run) ----------

export interface LaneBlock { step: string; start: number; end: number; ok: boolean | null; running: boolean }
export interface Lane { role: string; blocks: LaneBlock[] }
export interface Checkpoint { gate: string; at: number; ok: boolean; skipped: boolean }

/**
 * Each role's steps on one time axis (0 = the first step's start, 1 = the run's end or now), and the harness's
 * checks as checkpoints. A step's checks are placed where they happened: at the start of a step nested inside it
 * (the review inside the build) or else at its end. G1 (report shape) is left out: it is part of every report.
 */
export function lanesOf(timeline: Timeline, now: number): { lanes: Lane[]; checkpoints: Checkpoint[]; spanMs: number } {
  const steps = timeline.steps;
  if (!steps.length) return { lanes: [], checkpoints: [], spanMs: 0 };
  const startOf = (step: (typeof steps)[number]): number => Date.parse(step.startedAt);
  const endOf = (step: (typeof steps)[number]): number => (step.finishedAt ? Date.parse(step.finishedAt) : now);
  const t0 = Math.min(...steps.map(startOf));
  const t1 = Math.max(t0 + 1, ...steps.map(endOf));
  const span = t1 - t0;
  const at = (time: number): number => Math.min(1, Math.max(0, (time - t0) / span));
  const roles = ROLE_ORDER.filter(role => steps.some(step => step.role === role));
  const lanes = roles.map(role => ({
    role,
    blocks: steps.filter(step => step.role === role).map(step => ({ step: step.step, start: at(startOf(step)), end: Math.max(at(endOf(step)), at(startOf(step)) + 0.008), ok: step.ok, running: step.finishedAt === null && timeline.finished === null })),
  }));
  const checkpoints: Checkpoint[] = [];
  for (const step of steps) {
    const nested = steps.filter(other => other !== step && startOf(other) > startOf(step) && startOf(other) < endOf(step)).map(startOf);
    const when = nested.length ? Math.min(...nested) : endOf(step);
    step.gates.filter(gate => gate.gate !== 'G1').forEach(gate => {
      // step clear of earlier chips: right first, then left; bounded, so chips piled at the end cannot loop forever
      const base = at(when);
      let place = base;
      for (let k = 1; k <= 40 && checkpoints.some(point => Math.abs(point.at - place) < 0.03); k++) {
        const shift = Math.ceil(k / 2) * 0.035 * (k % 2 ? 1 : -1);
        place = Math.min(1, Math.max(0, base + shift));
      }
      checkpoints.push({ gate: gate.gate, at: place, ok: gate.ok, skipped: gate.skipped === true });
    });
  }
  return { lanes, checkpoints, spanMs: span };
}

export type LampState = 'ok' | 'fail' | 'skip' | 'wait';

/** The harness pillar's three lamps: the latest result of changed files (G2), tests (G3) and review (G4). */
export function gateLamps(timeline: Timeline): { gate: 'G2' | 'G3' | 'G4'; state: LampState }[] {
  const all = timeline.steps.flatMap(step => step.gates);
  return (['G2', 'G3', 'G4'] as const).map(gate => {
    const last = all.filter(result => result.gate === gate).at(-1);
    return { gate, state: !last ? 'wait' : last.skipped ? 'skip' : last.ok ? 'ok' : 'fail' };
  });
}

// ---------- stations (what each role's screen shows in the 3D room) ----------

export interface Station {
  /** The step on screen: the running one, else the role's last one. */
  step: string | null;
  elapsedMs: number;
  commands: number;
  fileChanges: number;
  /** One real line about the step: a sent-back reason, its result detail or its last message. */
  note: string | null;
  checks: { gate: string; ok: boolean }[];
}

/** A role's screen, built only from recorded events (nothing invented for show). */
export function stationOf(timeline: Timeline, role: string, now: number): Station {
  const mine = timeline.steps.filter(step => step.role === role);
  const step = mine.find(item => item.finishedAt === null && timeline.finished === null) ?? mine.at(-1);
  if (!step) return { step: null, elapsedMs: 0, commands: 0, fileChanges: 0, note: null, checks: [] };
  const end = step.finishedAt ? Date.parse(step.finishedAt) : now;
  const redo = step.redo.at(-1)?.reasons[0];
  const note = redo ?? (step.detail || step.messages.at(-1) || null);
  return {
    step: step.step,
    elapsedMs: Math.max(0, end - Date.parse(step.startedAt)),
    commands: step.commands,
    fileChanges: step.fileChanges,
    note: note ? clip(note, 90) : null,
    checks: step.gates.filter(gate => gate.gate !== 'G1').map(gate => ({ gate: gate.gate, ok: gate.ok })),
  };
}
