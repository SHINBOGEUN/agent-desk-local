// What the robots do between and around their real work: where the office's spots are, how a robot walks around
// the furniture, and what it picks next. Pure logic (no three.js) so it can be tested. The real state of each role
// (working, done, failed, asking) always wins: a working robot goes back to its desk, an asking robot steps forward.

import type { Mood } from './scene.ts';

export interface P { x: number; z: number }
export interface Circle extends P { r: number }

export type SpotKind = 'coffee' | 'board' | 'lounge' | 'rack' | 'shelf' | 'window';
export interface Spot extends P { id: string; kind: SpotKind; look: P }

export const GATE_AT: P = { x: 0, z: -1.2 };

/** Places a robot can go when it is not on duty. `look` is what it faces there. */
export const SPOTS: Spot[] = [
  { id: 'coffee-a', kind: 'coffee', x: -6.05, z: 0.75, look: { x: -7.0, z: 1.0 } },
  { id: 'coffee-b', kind: 'coffee', x: -6.15, z: 2.35, look: { x: -7.0, z: 2.0 } },
  { id: 'board-a', kind: 'board', x: -0.75, z: -4.35, look: { x: -0.75, z: -5.3 } },
  { id: 'board-b', kind: 'board', x: 0.85, z: -4.35, look: { x: 0.85, z: -5.3 } },
  { id: 'lounge-a', kind: 'lounge', x: 6.0, z: 0.9, look: { x: 6.7, z: 1.9 } },
  { id: 'lounge-b', kind: 'lounge', x: 6.2, z: 3.0, look: { x: 6.7, z: 1.9 } },
  { id: 'rack', kind: 'rack', x: 4.9, z: -3.9, look: { x: 5.7, z: -4.7 } },
  { id: 'shelf', kind: 'shelf', x: -4.9, z: -3.9, look: { x: -5.7, z: -4.7 } },
  { id: 'window', kind: 'window', x: 2.6, z: -5.2, look: { x: 3.2, z: -7.5 } },
];

/** Furniture and the gate, as circles on the floor that walking routes go around. */
export const OBSTACLES: Circle[] = [
  { ...GATE_AT, r: 1.75 },
  { x: -7.0, z: 1.55, r: 0.85 }, // coffee bar
  { x: -1.0, z: -5.25, r: 0.75 }, { x: 1.0, z: -5.25, r: 0.75 }, // whiteboard
  { x: 6.75, z: 1.95, r: 0.6 }, // lounge table
  { x: 5.75, z: -4.75, r: 0.6 }, // server rack
  { x: -5.75, z: -4.75, r: 0.6 }, // bookshelf
];

const dist = (a: P, b: P): number => Math.hypot(a.x - b.x, a.z - b.z);

/** Closest point to `c` on the segment a-b. */
function closest(a: P, b: P, c: P): P {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = dx * dx + dz * dz;
  const k = len ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.z - a.z) * dz) / len)) : 0;
  return { x: a.x + dx * k, z: a.z + dz * k };
}

/**
 * Waypoints from `from` to `to` (ending at `to`) that go around the obstacles. An obstacle that contains the start or
 * the end is ignored (you can always leave your own desk). Each crossing adds one point pushed out past the circle.
 */
export function route(from: P, to: P, obstacles: readonly Circle[]): P[] {
  const points: P[] = [from, to];
  const active = obstacles.filter(o => dist(o, from) > o.r && dist(o, to) > o.r);
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (let i = 0; i < points.length - 1 && !changed; i++) {
      const a = points[i]!, b = points[i + 1]!;
      for (const o of active) {
        const near = closest(a, b, o);
        const gap = dist(near, o);
        if (gap >= o.r) continue;
        // push the closest point out of the circle, on the side the path already leans to
        let nx = near.x - o.x, nz = near.z - o.z;
        if (Math.hypot(nx, nz) < 1e-6) { nx = -(b.z - a.z); nz = b.x - a.x; }
        const n = Math.hypot(nx, nz) || 1;
        points.splice(i + 1, 0, { x: o.x + (nx / n) * (o.r + 0.4), z: o.z + (nz / n) * (o.r + 0.4) });
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return points.slice(1);
}

/** A small seeded random generator, so each robot has its own but repeatable habits. */
export function seeded(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Plan =
  | { kind: 'desk'; until: number }
  | { kind: 'spot'; spot: Spot; until: number }
  | { kind: 'chat'; with: string; until: number }
  | { kind: 'ask'; until: number };

/** Roles prefer different places when they have nothing to do. */
const TASTE: Record<string, Partial<Record<SpotKind, number>>> = {
  lead: { board: 3, coffee: 2, window: 1, lounge: 1 },
  builder: { coffee: 3, rack: 2, lounge: 2, window: 1 },
  verifier: { shelf: 2, board: 2, window: 2, coffee: 1 },
  researcher: { shelf: 3, window: 2, lounge: 1, coffee: 1 },
};

/**
 * What a robot does next. On-duty moods are fixed (working or failed: at the desk; asking: step forward);
 * otherwise it picks a free spot it likes, a chat with another free robot, or a rest at its desk.
 */
export function nextPlan(input: { role: string; mood: Mood; now: number; free: readonly Spot[]; partners: readonly string[]; random: () => number }): Plan {
  const { role, mood, now, free, partners, random } = input;
  if (mood === 'working' || mood === 'failed') return { kind: 'desk', until: Infinity };
  if (mood === 'asking') return { kind: 'ask', until: Infinity };
  const stay = (min: number, max: number): number => now + min + random() * (max - min);
  const taste = TASTE[role] ?? {};
  const options: { weight: number; plan: () => Plan }[] = [
    { weight: 1.2, plan: () => ({ kind: 'desk', until: stay(6, 12) }) },
    ...free.map(spot => ({ weight: taste[spot.kind] ?? 0.5, plan: (): Plan => ({ kind: 'spot', spot, until: stay(8, 16) }) })),
    ...partners.map(other => ({ weight: 1.5, plan: (): Plan => ({ kind: 'chat', with: other, until: stay(6, 10) }) })),
  ];
  const total = options.reduce((sum, option) => sum + option.weight, 0);
  let pick = random() * total;
  for (const option of options) { pick -= option.weight; if (pick <= 0) return option.plan(); }
  return options[0]!.plan();
}
