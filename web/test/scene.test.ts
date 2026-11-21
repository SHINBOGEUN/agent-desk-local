import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTimeline, emptyTimeline } from '../src/model.ts';
import type { StoredEvent } from '../src/model.ts';
import { sceneOf } from '../src/scene.ts';

let seq = 0;
const at = (second: number) => `2026-11-16T09:00:${String(second).padStart(2, '0')}.000Z`;
const ev = (second: number, data: StoredEvent['data']): StoredEvent => ({ seq: ++seq, at: at(second), type: data.type, data });

test('an empty run has idle robots and no speech', () => {
  const scene = sceneOf(emptyTimeline(), false);
  assert.deepEqual(scene.robots.map(robot => [robot.role, robot.mood]), [['lead', 'idle'], ['builder', 'idle'], ['verifier', 'idle']]);
  assert.equal(scene.speaking, null);
});

test('the active step makes its role work, hand-offs and REDO become bubbles, and the end speaks to the user', () => {
  seq = 0;
  const running = buildTimeline([
    ev(0, { type: 'step_started', step: 'classify', role: 'lead' }),
    ev(2, { type: 'step_finished', step: 'classify', ok: true, detail: 'one file change' }),
    ev(3, { type: 'step_started', step: 'build', role: 'builder' }),
  ]);
  const live = sceneOf(running, false);
  assert.equal(live.robots.find(robot => robot.role === 'builder')!.mood, 'working');
  assert.equal(live.robots.find(robot => robot.role === 'lead')!.mood, 'done');
  assert.deepEqual([live.speaking!.from, live.speaking!.to, live.speaking!.text], ['lead', 'builder', 'one file change']);
  assert.equal(sceneOf(running, true).robots[0]!.mood, 'asking');

  const finished = buildTimeline([
    ev(0, { type: 'step_started', step: 'build', role: 'builder' }),
    ev(2, { type: 'gate', result: { gate: 'G4', ok: false, attempt: 1, detail: 'REDO', problems: ['R4'] } }),
    ev(3, { type: 'redo', attempt: 1, mode: 'builder', reasons: ['edge case R4 is missing'] }),
    ev(4, { type: 'step_finished', step: 'build', ok: false, detail: 'needs work' }),
    ev(5, { type: 'run_finished', status: 'needs_review', reason: 'Stopped after 2 REDO rounds.' }),
  ]);
  const scene = sceneOf(finished, false);
  assert.equal(scene.robots.find(robot => robot.role === 'builder')!.mood, 'failed');
  assert.deepEqual(scene.bubbles.map(bubble => [bubble.from, bubble.to, bubble.tone]), [['harness', 'builder', 'problem'], ['lead', 'you', 'problem']]);
  assert.deepEqual(scene.gates, [{ gate: 'G4', ok: false, skipped: false }]);
});

test('a role that starts again after being sent back gets the REDO bubble, not a hand-off to itself', () => {
  seq = 0;
  const timeline = buildTimeline([
    ev(0, { type: 'step_started', step: 'build', role: 'builder' }),
    ev(2, { type: 'step_finished', step: 'build', ok: false, detail: 'R2 evidence missing' }),
    ev(3, { type: 'redo', attempt: 1, mode: 'fix', reasons: ['add a test for R2'] }),
    ev(4, { type: 'step_started', step: 'build', role: 'builder' }),
  ]);
  assert.deepEqual(sceneOf(timeline, false).bubbles.map(bubble => [bubble.from, bubble.to, bubble.text]), [['harness', 'builder', 'add a test for R2']]);
});

test('the researcher only appears when it was used', () => {
  seq = 0;
  const scene = sceneOf(buildTimeline([ev(0, { type: 'step_started', step: 'research', role: 'researcher' })]), false);
  assert.ok(scene.robots.some(robot => robot.role === 'researcher'));
});

test('lanes put each role on one time axis and place checks where they happened', async () => {
  const { lanesOf, gateLamps } = await import('../src/scene.ts');
  const at = (s: number) => new Date(Date.UTC(2026, 10, 20, 9, 0, s)).toISOString();
  const step = (name: string, role: string, start: number, end: number | null, gates: { gate: string; ok: boolean }[] = []) => ({ step: name, role, startedAt: at(start), finishedAt: end === null ? null : at(end), ok: true, detail: '', gates, redo: [], retries: [], reports: [], messages: [], commands: 0, fileChanges: 0 });
  const timeline = { steps: [step('classify', 'lead', 0, 4, [{ gate: 'G1', ok: true }]), step('build', 'builder', 4, 40, [{ gate: 'G2', ok: true }, { gate: 'G3', ok: true }]), step('review', 'verifier', 28, 39, [{ gate: 'G4', ok: true }])], finished: { status: 'completed', reason: 'ok' }, lastSeq: 9 };
  const { lanes, checkpoints, spanMs } = lanesOf(timeline, Date.parse(at(60)));
  assert.equal(spanMs, 40_000);
  assert.deepEqual(lanes.map(lane => lane.role), ['lead', 'builder', 'verifier']);
  assert.deepEqual(lanes[1]!.blocks[0], { step: 'build', start: 0.1, end: 1, ok: true, running: false });
  assert.deepEqual(checkpoints.map(point => point.gate), ['G2', 'G3', 'G4']);
  assert.equal(checkpoints[0]!.at, 0.7);
  assert.ok(checkpoints[1]!.at > checkpoints[0]!.at);
  assert.deepEqual(gateLamps(timeline).map(lamp => lamp.state), ['ok', 'ok', 'ok']);
  assert.deepEqual(gateLamps({ ...timeline, steps: [timeline.steps[0]!] }).map(lamp => lamp.state), ['wait', 'wait', 'wait']);
  assert.deepEqual(lanesOf({ steps: [], finished: null, lastSeq: 0 }, 0), { lanes: [], checkpoints: [], spanMs: 0 });
});

test('a station shows only what the events recorded: the running step, its time, counts, and a sent-back reason first', async () => {
  const { stationOf } = await import('../src/scene.ts');
  seq = 0;
  const timeline = buildTimeline([
    ev(0, { type: 'step_started', step: 'build', role: 'builder' }),
    ev(2, { type: 'gate', result: { gate: 'G2', ok: false, attempt: 0, detail: 'R2' } }),
    ev(3, { type: 'redo', attempt: 1, mode: 'fix', reasons: ['add evidence for R2'] }),
  ]);
  const station = stationOf(timeline, 'builder', Date.parse(at(10)));
  assert.equal(station.step, 'build');
  assert.equal(station.elapsedMs, 10_000);
  assert.equal(station.note, 'add evidence for R2');
  assert.deepEqual(station.checks, [{ gate: 'G2', ok: false }]);
  assert.deepEqual(stationOf(timeline, 'verifier', 0), { step: null, elapsedMs: 0, commands: 0, fileChanges: 0, note: null, checks: [] });
});
