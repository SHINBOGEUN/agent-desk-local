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

test('the researcher only appears when it was used', () => {
  seq = 0;
  const scene = sceneOf(buildTimeline([ev(0, { type: 'step_started', step: 'research', role: 'researcher' })]), false);
  assert.ok(scene.robots.some(robot => robot.role === 'researcher'));
});
