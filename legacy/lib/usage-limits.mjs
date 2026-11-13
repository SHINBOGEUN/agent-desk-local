// The account API can shift the reported reset timestamp by a few seconds
// while the same five-hour window is still active. A real rollover moves it
// by hours, so ignore small timestamp drift when identifying a window.
export function sameFiveHourWindow(firstResetsAt, secondResetsAt) {
  return Number.isFinite(firstResetsAt) && Number.isFinite(secondResetsAt)
    && Math.abs(firstResetsAt - secondResetsAt) < 300;
}

export function normalizeRateLimits(response, checkedAt = new Date().toISOString()) {
  const byId = response?.rateLimitsByLimitId;
  const bucket = byId?.codex || response?.rateLimits || (byId && Object.values(byId)[0]);
  const windows = [['primary', bucket?.primary], ['secondary', bucket?.secondary]].flatMap(([kind, window]) => {
    if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return [];
    const usedPercent = Math.min(100, Math.max(0, window.usedPercent));
    return [{
      kind,
      windowDurationMins: Number.isFinite(window.windowDurationMins) && window.windowDurationMins > 0 ? window.windowDurationMins : null,
      usedPercent,
      remainingPercent: Math.round((100 - usedPercent) * 10) / 10,
      resetsAt: Number.isFinite(window.resetsAt) && window.resetsAt > 0 ? window.resetsAt : null,
    }];
  });
  return windows.length
    ? { status: 'available', windows, checkedAt }
    : { status: 'unavailable', windows: [], checkedAt, message: '이 로그인에서는 한도 정보를 확인할 수 없습니다.' };
}

export function primaryUsageSince(baseline, currentLimits) {
  const current = currentLimits?.status === 'available' && currentLimits.windows.find(window => window.kind === 'primary');
  if (!baseline || !current) return { status: 'unavailable' };
  if (baseline.windowDurationMins !== current.windowDurationMins) return { status: 'reset' };
  if (baseline.resetsAt && current.resetsAt && !sameFiveHourWindow(baseline.resetsAt, current.resetsAt)) return { status: 'reset' };
  if (current.usedPercent < baseline.usedPercent) return { status: 'reset' };
  return { status: 'available', currentUsedPercent: current.usedPercent, consumedPercent: Math.round((current.usedPercent - baseline.usedPercent) * 10) / 10, checkedAt: currentLimits.checkedAt };
}
