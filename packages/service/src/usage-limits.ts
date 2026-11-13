// Codex 5-hour account limit tracking, ported from v1. The account usage
// percentage is the only quota signal Codex gives, so a run's share is the
// increase since the run started. Other Codex work on the same account is
// counted too; the numbers are a stop condition, not an accounting of this run.

export interface LimitWindow {
  kind: 'primary' | 'secondary';
  windowDurationMins: number | null;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: number | null;
}

export interface Limits {
  status: 'available' | 'unavailable';
  windows: LimitWindow[];
  checkedAt: string;
}

type Raw = { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown } | null | undefined;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The reported reset time can drift a few seconds inside one window; a real rollover moves it by hours. */
export function sameWindow(first: number | null, second: number | null): boolean {
  return first !== null && second !== null && Math.abs(first - second) < 300;
}

export function normalizeRateLimits(response: unknown, checkedAt = new Date().toISOString()): Limits {
  const root = response as { rateLimitsByLimitId?: Record<string, { primary?: Raw; secondary?: Raw }>; rateLimits?: { primary?: Raw; secondary?: Raw } } | null | undefined;
  const byId = root?.rateLimitsByLimitId;
  const bucket = byId?.codex ?? root?.rateLimits ?? (byId ? Object.values(byId)[0] : undefined);
  const windows: LimitWindow[] = [];
  for (const kind of ['primary', 'secondary'] as const) {
    const raw = bucket?.[kind];
    if (!raw || !finite(raw.usedPercent)) continue;
    const usedPercent = Math.min(100, Math.max(0, raw.usedPercent));
    windows.push({
      kind,
      windowDurationMins: finite(raw.windowDurationMins) && raw.windowDurationMins > 0 ? raw.windowDurationMins : null,
      usedPercent,
      remainingPercent: Math.round((100 - usedPercent) * 10) / 10,
      resetsAt: finite(raw.resetsAt) && raw.resetsAt > 0 ? raw.resetsAt : null,
    });
  }
  return windows.length ? { status: 'available', windows, checkedAt } : { status: 'unavailable', windows: [], checkedAt };
}

export type Reading =
  | { status: 'unavailable' }
  | { status: 'reset' }
  | { status: 'available'; currentUsedPercent: number; consumedPercent: number };

export function usageSince(baseline: LimitWindow | undefined, current: Limits): Reading {
  const now = current.status === 'available' ? current.windows.find(window => window.kind === 'primary') : undefined;
  if (!baseline || !now) return { status: 'unavailable' };
  if (baseline.windowDurationMins !== now.windowDurationMins) return { status: 'reset' };
  if (baseline.resetsAt !== null && now.resetsAt !== null && !sameWindow(baseline.resetsAt, now.resetsAt)) return { status: 'reset' };
  if (now.usedPercent < baseline.usedPercent) return { status: 'reset' };
  return { status: 'available', currentUsedPercent: now.usedPercent, consumedPercent: Math.round((now.usedPercent - baseline.usedPercent) * 10) / 10 };
}

export interface GuardOptions {
  /** Returns the raw `account/rateLimits/read` response. */
  read(): Promise<unknown>;
  /** Stop once the primary window grew by this many percentage points. */
  limitPercent: number;
  /** Called once, with the reason, when the run should stop. */
  onTrip(reason: string): void;
  intervalMs?: number;
  /** Consecutive failed reads tolerated before stopping. Default 3. */
  maxFailures?: number;
}

export interface UsageGuard {
  stop(): void;
  /** Percentage points consumed since the guard started, or null if never read. */
  consumed(): number | null;
}

/** Polls the account limits while a run is active. Fails closed: if usage cannot be read repeatedly, the run stops. */
export async function startUsageGuard(options: GuardOptions): Promise<UsageGuard> {
  const maxFailures = options.maxFailures ?? 3;
  let baseline: LimitWindow | undefined;
  let consumed: number | null = null;
  let failures = 0;
  let tripped = false;
  let stopped = false;
  const trip = (reason: string): void => { if (!tripped && !stopped) { tripped = true; options.onTrip(reason); } };

  const first = normalizeRateLimits(await options.read().catch(() => undefined));
  baseline = first.status === 'available' ? first.windows.find(window => window.kind === 'primary') : undefined;
  if (!baseline) {
    trip('The 5-hour Codex limit could not be read, so usage cannot be tracked safely. Remove limits.codexUsagePercent to run without tracking.');
    return { stop: () => { stopped = true; }, consumed: () => null };
  }

  const check = async (): Promise<void> => {
    if (tripped || stopped) return;
    let reading: Reading;
    let current: Limits;
    try { current = normalizeRateLimits(await options.read()); reading = usageSince(baseline, current); }
    catch { reading = { status: 'unavailable' }; current = { status: 'unavailable', windows: [], checkedAt: '' }; }
    if (reading.status === 'reset') {
      const now = current.windows.find(window => window.kind === 'primary');
      if (!now || now.windowDurationMins !== 300) { reading = { status: 'unavailable' }; }
      else { baseline = { ...now, usedPercent: 0 }; reading = usageSince(baseline, current); }
    }
    if (reading.status !== 'available') {
      if (++failures >= maxFailures) trip('The 5-hour Codex limit could not be read during the run, so it was stopped.');
      return;
    }
    failures = 0;
    consumed = reading.consumedPercent;
    if (reading.consumedPercent >= options.limitPercent) trip(`Stopped by the 5-hour usage limit: ${reading.consumedPercent} percentage points used during this run (limit ${options.limitPercent}). Other Codex work on the account counts too.`);
  };
  const timer = setInterval(() => { void check(); }, options.intervalMs ?? 15_000);
  return { stop: () => { stopped = true; clearInterval(timer); }, consumed: () => consumed };
}
