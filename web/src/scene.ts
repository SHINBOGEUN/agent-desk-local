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
    if (previous && previous.finishedAt) {
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
