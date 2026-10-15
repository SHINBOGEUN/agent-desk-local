export function normalizeRateLimits(response, checkedAt = new Date().toISOString()) {
  const byId = response?.rateLimitsByLimitId;
  const bucket = byId?.codex || response?.rateLimits || (byId && Object.values(byId)[0]);
  const windows = [bucket?.primary, bucket?.secondary].flatMap(window => {
    if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return [];
    const usedPercent = Math.min(100, Math.max(0, window.usedPercent));
    return [{
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
