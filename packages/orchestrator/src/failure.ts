// Failure types (design: "실패 유형별 처리"). The harness reacts differently to a
// code problem (REDO), an environment problem (stop at once and say what to fix),
// a missing piece of information (ask the user) and a flaky runtime (retry once).

// "limit": the account's usage allowance ran out mid-run (Codex "You've hit your usage limit",
// Claude "You've hit your session limit · resets 3:45pm"). Retrying wastes the same wall; the run stops
// as resumable so it can continue after the reset or with the other runtime.
export type FailureType = 'environment' | 'transient' | 'limit' | 'other';

const ENVIRONMENT = [/\bEPERM\b/, /\bEACCES\b/, /\bENOENT\b/, /permission denied/i, /access is denied/i, /not recognized as an internal or external command/i, /command not found/i, /cannot start/i, /not logged in|please log ?in|authentication (failed|required)|unauthorized/i, /\bENOSPC\b/];
const LIMIT = [/hit your (usage|session|weekly|opus|sonnet|fable|mythos) limit/i, /usage limit (reached|exceeded)/i, /usage_?limit_?exceeded/i, /\bquota (exceeded|exhausted)\b/i];
const TRANSIENT = [/temporarily limiting requests/i, /\bECONNRESET\b/, /\bETIMEDOUT\b/, /\bEPIPE\b/, /socket hang up/i, /timed out/i, /disconnected/i, /app-server exited/i, /temporar(y|ily) unavailable/i, /rate limit|overloaded|\b5\d\d\b/i];

export function classifyFailure(message: string): FailureType {
  // A short server-side throttle says "not your usage limit"; it is transient, not the allowance.
  if (!/not your usage limit/i.test(message) && LIMIT.some(pattern => pattern.test(message))) return 'limit';
  if (ENVIRONMENT.some(pattern => pattern.test(message))) return 'environment';
  if (TRANSIENT.some(pattern => pattern.test(message))) return 'transient';
  return 'other';
}
