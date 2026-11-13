import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageLedger, deltaFromCumulative, emptyUsage, isValidUsage } from '#core';
import type { TokenUsage } from '#core';

const usage = (total: number, input = total, cached = 0, output = 0): TokenUsage => ({ inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningTokens: 0, totalTokens: total });

test('totals are sums of per-turn increments, per step and overall', () => {
  const ledger = new UsageLedger();
  ledger.record('build', 1, usage(1_000, 900, 600, 100));
  ledger.record('build', 2, usage(500, 450, 300, 50));
  ledger.record('review', 1, usage(300, 280, 200, 20));
  assert.equal(ledger.total().totalTokens, 1_800);
  assert.equal(ledger.byStep().get('build')?.totalTokens, 1_500);
  assert.equal(ledger.billable(), (900 + 450 + 280) - (600 + 300 + 200) + (100 + 50 + 20));
  assert.equal(ledger.entries().length, 3);
});

test('negative or inconsistent usage is rejected instead of silently summed', () => {
  const ledger = new UsageLedger();
  assert.throws(() => ledger.record('build', 1, usage(-1)));
  assert.throws(() => ledger.record('build', 1, usage(100, 100, 150)));
  assert.equal(isValidUsage(emptyUsage()), true);
});

test('cumulative snapshots become increments (the v1 10.7x over-count case)', () => {
  // A resumed thread reports running totals: 3.0M after request 1, 3.1M after request 2.
  const first = deltaFromCumulative(null, usage(3_000_000));
  const second = deltaFromCumulative(usage(3_000_000), usage(3_100_000));
  assert.equal(first.totalTokens, 3_000_000);
  assert.equal(second.totalTokens, 100_000);
  // v1 summed the snapshots (6.1M); the ledger of increments gives the real 3.1M.
  const ledger = new UsageLedger();
  ledger.record('main', 1, first);
  ledger.record('main', 2, second);
  assert.equal(ledger.total().totalTokens, 3_100_000);
});

test('a lower snapshot means a new session, so the snapshot is the increment', () => {
  assert.equal(deltaFromCumulative(usage(5_000), usage(800)).totalTokens, 800);
});
