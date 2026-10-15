import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { normalizeRateLimits } from '../lib/usage-limits.mjs';
import { AgentHub } from '../lib/hub.mjs';

test('Codex account windows show remaining percentage, not consumed percentage', () => {
  const result = normalizeRateLimits({
    rateLimitsByLimitId: { codex: {
      primary: { usedPercent: 92, windowDurationMins: 300, resetsAt: 1800000000 },
      secondary: { usedPercent: 27, windowDurationMins: 10080, resetsAt: 1800100000 },
    } },
  }, '2026-10-15T00:00:00.000Z');
  assert.equal(result.status, 'available');
  assert.deepEqual(result.windows.map(window => window.remainingPercent), [8, 73]);
  assert.deepEqual(result.windows.map(window => window.windowDurationMins), [300, 10080]);
  assert.equal(result.windows[0].resetsAt, 1800000000);
  assert.equal(result.checkedAt, '2026-10-15T00:00:00.000Z');
});

test('legacy rate limit payload is supported and missing values are never shown as zero', () => {
  assert.equal(normalizeRateLimits({ rateLimits: { primary: { usedPercent: 120 } } }).windows[0].remainingPercent, 0);
  assert.equal(normalizeRateLimits({ rateLimits: { primary: { usedPercent: -5 } } }).windows[0].remainingPercent, 100);
  assert.equal(normalizeRateLimits({}).status, 'unavailable');
  assert.deepEqual(normalizeRateLimits({}).windows, []);
});

test('hub refresh publishes only normalized quota fields and preserves unavailable status', async () => {
  class FakeClient extends EventEmitter {
    connected = true;
    calls = 0;
    async request(method) {
      assert.equal(method, 'account/rateLimits/read'); this.calls++;
      return { rateLimitsByLimitId: { codex: { primary: { usedPercent: 25, windowDurationMins: 300 } } }, accountId: 'private' };
    }
  }
  const client = new FakeClient();
  const hub = new AgentHub({ state: { agents: [] } }, client);
  hub.connection = { status: 'connected' };
  let updates = 0; hub.on('state', () => updates++);
  const quota = await hub.refreshUsageLimits();
  assert.equal(quota.windows[0].remainingPercent, 75);
  assert.equal(JSON.stringify(hub.snapshot()).includes('private'), false);
  assert.equal(updates, 1);
  await hub.refreshUsageLimits();
  assert.equal(client.calls, 1);
  client.connected = false;
  assert.equal((await hub.refreshUsageLimits(true)).status, 'unavailable');
  assert.deepEqual(hub.snapshot().usageLimits.windows, []);
});
