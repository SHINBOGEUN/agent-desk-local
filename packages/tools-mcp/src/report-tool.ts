// Gate G1: checks the report a step submits through `submit_report`. A rejected
// report comes back with the exact field paths to fix, so the same session can
// correct it. Only the first valid report is kept.

import type { ReportByKind, ReportKind, ToolResult } from '#core';
import { reportConsistencyErrors, validateReport } from '#core';

const MAX_LISTED_ERRORS = 12;

export class ReportCollector<K extends ReportKind> {
  readonly kind: K;
  #report: ReportByKind[K] | null = null;
  #invalidAttempts = 0;
  #lastErrors: string[] = [];

  constructor(kind: K) {
    this.kind = kind;
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
    const checked = validateReport(this.kind, raw);
    const errors = checked.ok ? reportConsistencyErrors(this.kind, checked.value) : checked.errors;
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
