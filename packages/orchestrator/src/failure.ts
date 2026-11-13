// Failure types (design: "실패 유형별 처리"). The harness reacts differently to a
// code problem (REDO), an environment problem (stop at once and say what to fix),
// a missing piece of information (ask the user) and a flaky runtime (retry once).

export type FailureType = 'environment' | 'transient' | 'other';

const ENVIRONMENT = [/\bEPERM\b/, /\bEACCES\b/, /\bENOENT\b/, /permission denied/i, /access is denied/i, /not recognized as an internal or external command/i, /command not found/i, /cannot start/i, /not logged in|please log ?in|authentication (failed|required)|unauthorized/i, /\bENOSPC\b/];
const TRANSIENT = [/\bECONNRESET\b/, /\bETIMEDOUT\b/, /\bEPIPE\b/, /socket hang up/i, /timed out/i, /disconnected/i, /app-server exited/i, /temporar(y|ily) unavailable/i, /rate limit|overloaded|\b5\d\d\b/i];

export function classifyFailure(message: string): FailureType {
  if (ENVIRONMENT.some(pattern => pattern.test(message))) return 'environment';
  if (TRANSIENT.some(pattern => pattern.test(message))) return 'transient';
  return 'other';
}
