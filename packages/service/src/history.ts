// The read_history tool: details of a project's earlier runs, looked up only
// when an agent asks (the always-sent summary is projectHistory). Built from
// stored briefs and reports by code; no model call.

import type { HistoryQuery } from '#core';
import type { RunStore } from '#store';

export const HISTORY_ANSWER_MAX_CHARS = 4000;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
type Report = Record<string, unknown>;
const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null) : []);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

/** One run in detail: its brief plus what the stored report adds (requirements, builder summary, review, plan, answer). */
export function runDetailText(id: number, startedAt: string, brief: string, report: Report | null): string {
  const lines = [`#${id} ${startedAt.slice(0, 10)}`, brief];
  if (report) {
    const requirements = records(report.requirements).map(entry => `${String(entry.id)}: ${String(entry.text ?? '')}`);
    if (requirements.length) lines.push(`요구사항: ${requirements.join(' / ')}`);
    const plan = report.plan as Report | undefined;
    if (plan && typeof plan.approach === 'string') lines.push(`계획: ${clip(plan.approach, 300)}`);
    const builder = report.builder as Report | undefined;
    if (builder) {
      if (typeof builder.summary === 'string') lines.push(`작업 요약: ${clip(builder.summary, 600)}`);
      const done = records(builder.requirements).map(entry => `${String(entry.id)} ${String(entry.status)}${entry.evidence ? ` (${clip(String(entry.evidence), 120)})` : ''}`);
      if (done.length) lines.push(`요구사항 결과: ${done.join('; ')}`);
      const commands = records(builder.commandsRun).map(entry => `${String(entry.command)} → ${String(entry.exitCode)}`);
      if (commands.length) lines.push(`실행한 명령: ${commands.join(', ')}`);
    }
    const review = report.review as Report | undefined;
    if (review && typeof review.verdict === 'string') {
      const blocking = records(review.blocking).map(entry => `${String(entry.reason)}${entry.file ? ` (${String(entry.file)}${entry.line ? `:${String(entry.line)}` : ''})` : ''}`);
      lines.push(`리뷰: ${review.verdict}${blocking.length ? ` — ${blocking.join('; ')}` : ''}`);
      const optional = strings(review.optional);
      if (optional.length) lines.push(`리뷰 제안: ${clip(optional.join('; '), 300)}`);
    }
    const answer = report.answer as Report | undefined;
    if (answer && typeof answer.answer === 'string') lines.push(`답변: ${clip(answer.answer, 800)}`);
  }
  return lines.join('\n');
}

export function historyLookup(store: RunStore, project: string, query: HistoryQuery): string {
  if (query.runId !== undefined) {
    const run = store.getRun(query.runId);
    if (!run || run.project !== project || run.status === 'running') return `Run #${query.runId} is not a finished run of this project.`;
    return clip(runDetailText(run.id, run.startedAt, run.brief ?? `요청: ${run.request}`, store.getReport(run.id)), HISTORY_ANSWER_MAX_CHARS);
  }
  const words = (query.search ?? '').split(/\s+/).filter(Boolean);
  const ids = store.searchRuns(project, words);
  if (!ids.length) {
    const recent = store.recentBriefs(project, 5).map(run => `- #${run.id} ${run.brief.split('\n')[0] ?? ''}`).join('\n');
    return `No earlier run matches "${query.search ?? ''}".${recent ? ` Recent runs:\n${recent}` : ''}`;
  }
  const parts = ids.map(id => { const run = store.getRun(id)!; return runDetailText(run.id, run.startedAt, run.brief ?? `요청: ${run.request}`, store.getReport(run.id)); });
  return clip(parts.join('\n\n'), HISTORY_ANSWER_MAX_CHARS);
}
