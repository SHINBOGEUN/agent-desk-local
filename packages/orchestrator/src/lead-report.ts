// The lead answers in one turn when it can: a single report carries the
// classification and, for "answer", the answer itself. This collector accepts
// that combined shape and checks both halves with the core validators.

import type { AnswerReport, ClassifyReport, ToolResult } from '#core';
import { reportConsistencyErrors, validateReport } from '#core';
import { missingSourceErrors, requirementQuoteErrors } from './evidence.ts';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export class LeadCollector {
  #classify: ClassifyReport | null = null;
  #answer: AnswerReport | null = null;
  #invalid = 0;

  get classify(): ClassifyReport | null { return this.#classify; }
  get answer(): AnswerReport | null { return this.#answer; }
  /** Decisions or rules the user stated, offered for the project memory (the user approves each one). */
  get memorySuggestions(): string[] { return this.#memorySuggestions; }
  #memorySuggestions: string[] = [];
  get invalidAttempts(): number { return this.#invalid; }

  /** With the request and project folder, requirements must quote the request and cited files must exist. */
  readonly context: { request: string; cwd: string; noteText?: (path: string) => string | null } | undefined;
  constructor(context?: { request: string; cwd: string; noteText?: (path: string) => string | null }) { this.context = context; }

  readonly submit = async (raw: unknown): Promise<ToolResult> => {
    if (this.#classify) return { ok: false, message: 'A report was already accepted for this step. Do not submit another one.' };
    const errors: string[] = [];
    let classify: ClassifyReport | null = null;
    let answer: AnswerReport | null = null;
    if (!isRecord(raw)) {
      errors.push(`report: expected object, got ${Array.isArray(raw) ? 'array' : typeof raw}`);
    } else {
      const { answer: answerText, sources, memorySuggestions, ...classifyPart } = raw;
      if (memorySuggestions !== undefined) {
        if (!Array.isArray(memorySuggestions) || memorySuggestions.some(item => typeof item !== 'string' || !item.trim() || item.length > 1_000) || memorySuggestions.length > 5) errors.push('report.memorySuggestions: up to 5 non-empty strings');
        else this.#memorySuggestions = memorySuggestions as string[];
      }
      const checkedClassify = validateReport('classify', classifyPart);
      if (!checkedClassify.ok) errors.push(...checkedClassify.errors.map(error => error.replace(/^classify/, 'report')));
      else { errors.push(...reportConsistencyErrors('classify', checkedClassify.value).map(error => error.replace(/^classify/, 'report'))); classify = checkedClassify.value; }
      const hasAnswerPart = answerText !== undefined || sources !== undefined;
      if (classify?.workflow === 'answer' || hasAnswerPart) {
        const checkedAnswer = validateReport('answer', { answer: answerText, sources: sources ?? [] });
        if (!checkedAnswer.ok) errors.push(...checkedAnswer.errors.map(error => error.replace(/^answer/, 'report.answer').replace('report.answer.answer', 'report.answer')));
        else answer = checkedAnswer.value;
      }
      if (classify && classify.workflow !== 'answer' && hasAnswerPart) errors.push('report.answer: only include "answer" and "sources" when workflow is "answer"');
      if (this.context && classify && (classify.workflow === 'build' || classify.workflow === 'plan-build')) errors.push(...requirementQuoteErrors(this.context.request, classify.requirements, this.context.noteText));
      if (this.context && answer) errors.push(...missingSourceErrors(this.context.cwd, answer.sources, 'report.sources', this.context.noteText));
    }
    if (errors.length || !classify) {
      this.#invalid++;
      return { ok: false, message: `Report rejected: ${errors.length} problem(s). Fix these and call submit_report again with the complete report.\n${errors.slice(0, 12).map(error => `- ${error}`).join('\n')}` };
    }
    this.#classify = classify;
    this.#answer = answer;
    return { ok: true, message: 'Report accepted.' };
  };
}
