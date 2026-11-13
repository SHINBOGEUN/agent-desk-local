// Token accounting. The harness stores per-turn increments only and derives
// every total from them. v1 stored a resumed thread's cumulative total as each
// request's usage and over-reported tokens 10.7x; this module makes that
// mistake hard to repeat.

import type { TokenUsage } from './types.ts';

const FIELDS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens'] as const;

export const emptyUsage = (): TokenUsage => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 });

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const sum = emptyUsage();
  for (const field of FIELDS) sum[field] = a[field] + b[field];
  return sum;
}

export function isValidUsage(usage: TokenUsage): boolean {
  return FIELDS.every(field => Number.isFinite(usage[field]) && usage[field] >= 0)
    && usage.cachedInputTokens <= usage.inputTokens;
}

/**
 * For runtimes that only report a running total per session: turns the latest
 * cumulative snapshot into this turn's increment. A total lower than the
 * previous one means the session was replaced, so the snapshot itself is the
 * increment.
 */
export function deltaFromCumulative(previous: TokenUsage | null, current: TokenUsage): TokenUsage {
  if (!previous || current.totalTokens < previous.totalTokens) return { ...current };
  const delta = emptyUsage();
  for (const field of FIELDS) delta[field] = Math.max(0, current[field] - previous[field]);
  return delta;
}

export interface UsageEntry {
  stepId: string;
  turn: number;
  delta: TokenUsage;
}

/** Append-only record of per-turn usage. Totals are always sums of entries. */
export class UsageLedger {
  readonly #entries: UsageEntry[] = [];

  record(stepId: string, turn: number, delta: TokenUsage): void {
    if (!isValidUsage(delta)) throw new Error(`invalid usage for ${stepId} turn ${turn}: ${JSON.stringify(delta)}`);
    this.#entries.push({ stepId, turn, delta: { ...delta } });
  }

  entries(): readonly UsageEntry[] { return this.#entries; }

  total(): TokenUsage {
    return this.#entries.reduce((sum, entry) => addUsage(sum, entry.delta), emptyUsage());
  }

  byStep(): Map<string, TokenUsage> {
    const totals = new Map<string, TokenUsage>();
    for (const entry of this.#entries) totals.set(entry.stepId, addUsage(totals.get(entry.stepId) ?? emptyUsage(), entry.delta));
    return totals;
  }

  /** Uncached input + output: closer to real cost than the raw total. */
  billable(): number {
    const total = this.total();
    return total.inputTokens - total.cachedInputTokens + total.outputTokens;
  }
}
