import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FakeRuntime } from '#runtime-fake';
import { executeRun, normalizeRateLimits, startUsageGuard, usageSince } from '../src/index.ts';

const response = (used: number, resetsAt = 1_800_000_000, minutes = 300) => ({ rateLimitsByLimitId: { codex: { primary: { usedPercent: used, windowDurationMins: minutes, resetsAt } } } });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('normalizeRateLimits reads the codex bucket, clamps percentages and reports unavailable', () => {
  const ok = normalizeRateLimits(response(42.5));
  assert.equal(ok.status, 'available');
  assert.equal(ok.windows[0]?.remainingPercent, 57.5);
  assert.equal(normalizeRateLimits({ rateLimits: { primary: { usedPercent: 150 } } }).windows[0]?.usedPercent, 100);
  assert.equal(normalizeRateLimits({}).status, 'unavailable');
  assert.equal(normalizeRateLimits(null).status, 'unavailable');
});

test('usageSince: increase, small reset-time drift, rollover, unavailable', () => {
  const base = normalizeRateLimits(response(10)).windows[0];
  assert.deepEqual(usageSince(base, normalizeRateLimits(response(14.5, 1_800_000_100))), { status: 'available', currentUsedPercent: 14.5, consumedPercent: 4.5 });
  assert.equal(usageSince(base, normalizeRateLimits(response(12, 1_800_020_000))).status, 'reset');
  assert.equal(usageSince(base, normalizeRateLimits(response(3))).status, 'reset');
  assert.equal(usageSince(base, normalizeRateLimits({})).status, 'unavailable');
});

test('guard trips when the limit is reached, and keeps counting across a window rollover', async () => {
  const values = [response(10), response(11), response(5, 1_800_018_000), response(9, 1_800_018_000)];
  let i = 0;
  const reasons: string[] = [];
  const guard = await startUsageGuard({ read: async () => values[Math.min(i++, values.length - 1)], limitPercent: 4, intervalMs: 10, onTrip: r => reasons.push(r) });
  for (let n = 0; n < 100 && !reasons.length; n++) await sleep(10);
  guard.stop();
  assert.equal(reasons.length, 1);
  assert.match(reasons[0]!, /5 percentage points/);
});

test('guard fails closed when the limit cannot be read', async () => {
  const reasons: string[] = [];
  await startUsageGuard({ read: async () => ({}), limitPercent: 5, onTrip: r => reasons.push(r) });
  assert.match(reasons[0] ?? '', /could not be read/);
  const later: string[] = [];
  let n = 0;
  const guard = await startUsageGuard({ read: async () => { if (n++ === 0) return response(1); throw new Error('offline'); }, limitPercent: 5, intervalMs: 10, maxFailures: 2, onTrip: r => later.push(r) });
  for (let k = 0; k < 100 && !later.length; k++) await sleep(10);
  guard.stop();
  assert.match(later[0] ?? '', /during the run/);
});

test('executeRun stops a hanging run when the usage limit is crossed and records it as interrupted', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-home-'));
  let calls = 0;
  const runtime = new FakeRuntime({ scripts: { lead: [{ turns: [[{ hang: true }]] }], builder: [] } });
  const outcome = await executeRun({
    project, request: 'Add storage', env: { AGENT_DESK_HOME: home }, platform: 'linux', createRuntime: () => runtime, runtime: 'fake',
    maxUsagePercent: 3, pollUsageMs: 10, readRateLimits: async () => response(calls++ === 0 ? 20 : 25),
  });
  assert.ok(outcome.ok);
  if (outcome.ok) {
    assert.equal(outcome.result.status, 'interrupted');
    assert.match(outcome.result.reason, /5-hour usage limit/);
  }
});
