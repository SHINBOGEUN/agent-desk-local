// Secret masking for anything written to the event log. Conservative patterns:
// a false positive hides a harmless string, a false negative stores a secret.

const PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|credential)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)([^\s"',;]{4,})\3/gi;

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of PATTERNS) result = result.replace(pattern, '[redacted]');
  return result.replace(ASSIGNMENT, (_match, name: string, separator: string, quote: string) => `${name}${separator}${quote}[redacted]${quote}`);
}

/** Masks secrets and shortens long strings inside any JSON-like value. */
export function sanitize(value: unknown, maxString: number): unknown {
  if (typeof value === 'string') {
    const masked = redactSecrets(value);
    return masked.length > maxString ? `${masked.slice(0, maxString)}… [cut ${masked.length - maxString} chars]` : masked;
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item, maxString));
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitize(entry, maxString)]));
  return value;
}
