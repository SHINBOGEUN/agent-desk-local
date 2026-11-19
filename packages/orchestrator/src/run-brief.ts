// Run Brief: a short, structured summary of a finished run, built by code from
// the run's reports (no model call, no tokens). The briefs of a project's
// earlier runs make up its history (projectHistory): the latest in full, older
// ones one line each, under a size cap, so a project can be developed over many
// runs without explaining it again and without carrying a whole conversation.

import type { RunResult } from './types.ts';

export const BRIEF_MAX_CHARS = 1500;

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const list = (items: readonly string[], max: number): string => (items.length > max ? `${items.slice(0, max).join(', ')} 외 ${items.length - max}개` : items.join(', '));

export function buildRunBrief(request: string, result: RunResult): string {
  const lines = [`요청: ${clip(request, 240)}`, `결과: ${result.status} — ${clip(result.reason, 320)}`];
  if (result.workflow) lines.push(`처리: ${result.workflow}${result.redo ? ` · 재작업 ${result.redo}회` : ''}${result.review ? ` · 리뷰 ${result.review.verdict}` : ''}`);
  if (result.answer) lines.push(`답변 요지: ${clip(result.answer.answer, 400)}`);
  const files = result.builder?.changedFiles ?? [];
  if (files.length) lines.push(`변경 파일: ${list(files, 10)}`);
  const open = result.builder?.requirements.filter(entry => entry.status !== 'done').map(entry => `${entry.id}(${entry.status})`) ?? [];
  if (open.length) lines.push(`남은 요구사항: ${open.join(', ')}`);
  if (result.unverified.length) lines.push(`확인 못 한 것: ${list(result.unverified.map(item => clip(item, 120)), 4)}`);
  if (result.warnings.length) lines.push(`주의: ${list(result.warnings.map(item => clip(item, 120)), 3)}`);
  const brief = lines.join('\n');
  return brief.length > BRIEF_MAX_CHARS ? `${brief.slice(0, BRIEF_MAX_CHARS - 1)}…` : brief;
}

export const HISTORY_MAX_CHARS = 2000;
const FULL_BRIEFS = 2;

/** One line of an older run: its request, result and changed files, taken from its brief. */
function oneLine(id: number, startedAt: string, brief: string): string {
  const field = (label: string): string => brief.split('\n').find(line => line.startsWith(`${label}: `))?.slice(label.length + 2) ?? '';
  const status = field('결과').split(' — ')[0] ?? '';
  const files = field('변경 파일');
  return `- #${id} ${startedAt.slice(0, 10)} ${clip(field('요청'), 90)} → ${status}${files ? ` (변경: ${clip(files, 80)})` : ''}`;
}

/**
 * The project's history for the next run, newest first: the latest runs' briefs
 * in full, older runs one line each, cut at maxChars. Runs come newest first.
 */
export function projectHistory(runs: readonly { id: number; startedAt: string; brief: string }[], maxChars = HISTORY_MAX_CHARS): string {
  if (!runs.length) return '';
  const parts: string[] = [];
  let used = 0;
  let shown = 0;
  for (const [index, run] of runs.entries()) {
    const text = index < FULL_BRIEFS ? `#${run.id} ${run.startedAt.slice(0, 10)}\n${clip(run.brief, 600).replace(/ (결과|처리|답변 요지|변경 파일|남은 요구사항|확인 못 한 것|주의): /g, '\n$1: ')}` : oneLine(run.id, run.startedAt, run.brief);
    if (used + text.length + 1 > maxChars) break;
    parts.push(text);
    used += text.length + 1;
    shown++;
  }
  const rest = runs.length - shown;
  return `${parts.join('\n')}${rest > 0 ? `\n(${rest} older run(s) not shown; use read_history to look them up)` : ''}`;
}

