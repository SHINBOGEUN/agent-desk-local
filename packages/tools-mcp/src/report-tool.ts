// Gate G1: checks the report a step submits through `submit_report`. A rejected
// report comes back with the exact field paths to fix, so the same session can
// correct it. Only the first valid report is kept.

import type { ReportByKind, ReportKind, ToolResult } from '#core';
import { reportConsistencyErrors, validateReport } from '#core';

const MAX_LISTED_ERRORS = 12;

/**
 * Some MCP clients deliver arrays and objects as JSON text. When the report fails as sent, try again with strings that
 * parse as a JSON array or object turned back into values. Only used after a failed first check, so a text field that
 * happens to look like JSON is never changed in a report that is otherwise valid.
 */
export function unstringify(value: unknown): unknown {
  if (typeof value === 'string') {
    const text = value.trim();
    if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}'))) {
      try { return unstringify(JSON.parse(text)); } catch { return value; }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(unstringify);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, unstringify(entry)]));
  return value;
}

/** Extra rules that depend on the run (for example: the report must cover every requirement id). */
export type ReportCheck<K extends ReportKind> = (report: ReportByKind[K]) => string[];

export class ReportCollector<K extends ReportKind> {
  readonly kind: K;
  readonly #check: ReportCheck<K> | undefined;
  #report: ReportByKind[K] | null = null;
  #invalidAttempts = 0;
  #lastErrors: string[] = [];

  constructor(kind: K, check?: ReportCheck<K>) {
    this.kind = kind;
    this.#check = check;
  }

  get report(): ReportByKind[K] | null {
    return this.#report;
  }

  /** How many submissions were rejected. The orchestrator allows one correction round. */
  get invalidAttempts(): number {
    return this.#invalidAttempts;
  }

  get lastErrors(): readonly string[] {
    return this.#lastErrors;
  }

  readonly submit = async (raw: unknown): Promise<ToolResult> => {
    if (this.#report) return { ok: false, message: 'A report was already accepted for this step. Do not submit another one.' };
    let checked = validateReport(this.kind, raw);
    if (!checked.ok) {
      const second = validateReport(this.kind, unstringify(raw));
      if (second.ok) checked = second;
    }
    const errors = checked.ok ? [...reportConsistencyErrors(this.kind, checked.value), ...(this.#check?.(checked.value) ?? [])] : checked.errors;
    if (!checked.ok || errors.length) {
      this.#invalidAttempts++;
      this.#lastErrors = errors;
      const shown = errors.slice(0, MAX_LISTED_ERRORS).map(error => `- ${error}`);
      const hidden = errors.length - shown.length;
      return {
        ok: false,
        message: `Report rejected: ${errors.length} problem(s). Fix these and call submit_report again with the complete corrected ${this.kind} report.\n${shown.join('\n')}${hidden > 0 ? `\n- ...and ${hidden} more` : ''}`,
      };
    }
    this.#report = checked.value;
    this.#lastErrors = [];
    return { ok: true, message: 'Report accepted.' };
  };
}
