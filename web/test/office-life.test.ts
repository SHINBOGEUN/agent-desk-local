import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GATE_AT, OBSTACLES, SPOTS, nextPlan, route, seeded } from '../src/office-life.ts';

const clear = (points: { x: number; z: number }[], from: { x: number; z: number }): boolean => {
  let a = from;
  for (const b of points) {
    for (const o of OBSTACLES) {
      if (Math.hypot(o.x - from.x, o.z - from.z) <= o.r || Math.hypot(o.x - points.at(-1)!.x, o.z - points.at(-1)!.z) <= o.r) continue;
      for (let k = 0; k <= 20; k++) {
        const x = a.x + (b.x - a.x) * (k / 20), z = a.z + (b.z - a.z) * (k / 20);
        if (Math.hypot(x - o.x, z - o.z) < o.r - 1e-6) return false;
      }
    }
    a = b;
  }
  return true;
};

test('a walk across the room goes around the harness gate instead of through it', () => {
  const from = { x: -4, z: -1.2 }, to = { x: 4, z: -1.2 };
  const points = route(from, to, OBSTACLES);
  assert.ok(points.length > 1, 'a detour point is added');
  assert.deepEqual(points.at(-1), to);
  assert.ok(clear(points, from));
  assert.ok(points.every(p => Math.hypot(p.x - GATE_AT.x, p.z - GATE_AT.z) >= 1.75));
});

test('a free path is walked straight, and every spot is reachable from every desk without crossing furniture', () => {
  assert.deepEqual(route({ x: -3, z: 4 }, { x: 3, z: 4 }, OBSTACLES), [{ x: 3, z: 4 }]);
  for (const spot of SPOTS) for (const desk of [{ x: -4, z: -1.7 }, { x: 4, z: -1.7 }, { x: 1.55, z: 2.5 }, { x: -1.55, z: 2.5 }]) assert.ok(clear(route(desk, spot, OBSTACLES), desk), `${spot.id} from ${desk.x},${desk.z}`);
});

test('duty decides first: working or failed means the desk, asking means stepping forward; free robots wander', () => {
  const random = seeded('builder');
  assert.equal(nextPlan({ role: 'builder', mood: 'working', now: 0, free: SPOTS, partners: ['lead'], random }).kind, 'desk');
  assert.equal(nextPlan({ role: 'builder', mood: 'failed', now: 0, free: SPOTS, partners: [], random }).kind, 'desk');
  assert.equal(nextPlan({ role: 'builder', mood: 'asking', now: 0, free: SPOTS, partners: [], random }).kind, 'ask');
  const kinds = new Set(Array.from({ length: 60 }, () => nextPlan({ role: 'builder', mood: 'idle', now: 0, free: SPOTS, partners: ['lead'], random }).kind));
  assert.ok(kinds.has('spot') && kinds.has('chat') && kinds.has('desk'));
  const plan = nextPlan({ role: 'lead', mood: 'done', now: 100, free: [], partners: [], random: seeded('lead') });
  assert.equal(plan.kind, 'desk');
  assert.ok(plan.until > 100 && plan.until < 120);
});

test('two robots get different habits from their own seeds', () => {
  const a = seeded('lead'), b = seeded('verifier');
  assert.notDeepEqual([a(), a(), a()], [b(), b(), b()]);
  assert.deepEqual([seeded('x')(), seeded('x')()], [seeded('x')(), seeded('x')()]);
});
