// Run Brief: a short, structured summary of a finished run, built by code from
// the run's reports (no model call, no tokens). Only the most recent brief is
// passed to the next run's classify step, so follow-up requests ("now also...")
// have context without carrying a whole conversation.

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
