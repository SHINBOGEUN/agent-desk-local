// Run notes for the project vault: written by the harness after each run from the stored result (the gates,
// the diff, the review), never from a model call, so the notes cost no tokens and say only what was checked.

import type { RunResult } from '#orchestrator';
import { listNotes, noteFileName, proposeMemory, readNote, searchNotes, writeNote } from '#project';

type Lang = 'en' | 'ko';

const pad = (id: number): string => String(id).padStart(4, '0');

/** "runs/0056 <request>" (no .md), the link target other notes use. */
export function runNoteName(id: number, request: string): string {
  return `runs/${pad(id)} ${noteFileName(request.split('\n')[0] ?? '', 50)}`;
}

/** The existing note of a run (its file name holds the request it had then), if any. */
export function findRunNote(root: string, id: number): string | null {
  const hit = listNotes(root).find(note => note.folder === 'runs' && note.title.startsWith(`${pad(id)} `));
  return hit ? hit.path.replace(/\.md$/i, '') : null;
}

const STATUS_KO: Record<string, string> = { completed: '완료', needs_review: '검토 필요', needs_user: '답변 필요', failed: '실패', interrupted: '중단' };
const REQ_KO: Record<string, string> = { done: '완료', not_done: '미완료', unverified: '확인 못 함' };

export interface RunNoteInput {
  id: number;
  request: string;
  result: RunResult;
  lang: Lang;
  /** Link target of the run this one resumed. */
  resumedNote?: string | null;
  /** Inbox notes made from this run's memory suggestions. */
  proposals?: readonly string[];
}

export function runNoteText(input: RunNoteInput): string {
  const { id, request, result, lang } = input;
  const ko = lang === 'ko';
  const say = (en: string, kr: string): string => (ko ? kr : en);
  const status = ko ? STATUS_KO[result.status] ?? result.status : result.status;
  const changed = result.builder?.changedFiles ?? [];
  const skills = [...new Set((result.skillsRead ?? []).map(entry => entry.skill))];
  const lines: string[] = [
    '---',
    'type: run',
    `run: ${id}`,
    `status: ${result.status}`,
    ...(result.workflow ? [`workflow: ${result.workflow}`] : []),
    `tokens: ${result.usage.totalTokens}`,
    `redo: ${result.redo}`,
    `date: ${new Date().toISOString().slice(0, 10)}`,
    ...(changed.length ? ['files:', ...changed.map(file => `  - ${file}`)] : []),
    '---',
    `# ${say('Run', '실행')} #${id}: ${request.split('\n')[0]}`,
    '',
    `- ${say('Result', '결과')}: ${status}. ${result.reason}`,
    `- ${say('Tokens', '토큰')}: ${result.usage.totalTokens.toLocaleString('en-US')}${result.redo ? `, ${say('redo', '재작업')} ${result.redo}` : ''}`,
    ...(input.resumedNote ? [`- ${say('Continues', '이어서')}: [[${input.resumedNote}]]`] : []),
    '',
  ];
  if (request.includes('\n')) lines.push(`## ${say('Request', '요청')}`, '', request, '');
  if (result.answer) lines.push(`## ${say('Answer', '답변')}`, '', result.answer.answer, '');
  if (result.requirements.length) {
    lines.push(`## ${say('Requirements', '요구사항')}`, '');
    for (const requirement of result.requirements) {
      const entry = result.builder?.requirements.find(item => item.id === requirement.id);
      const state = entry ? (ko ? REQ_KO[entry.status] ?? entry.status : entry.status) : '';
      lines.push(`- ${requirement.id} ${state ? `(${state}) ` : ''}${requirement.text}`);
    }
    lines.push('');
  }
  if (result.builder) lines.push(`## ${say('What was done', '한 일')}`, '', result.builder.summary, '');
  if (result.attempts && result.attempts.length > 1) {
    lines.push(`## ${say('Sent back', '되돌려진 이유')}`, '');
    for (const attempt of result.attempts) for (const reason of attempt.sentBackFor) lines.push(`- ${say('attempt', '시도')} ${attempt.attempt}: ${reason}`);
    lines.push('');
  }
  if (changed.length) lines.push(`## ${say('Changed files', '변경 파일')}`, '', ...changed.map(file => `- [[${file}]]`), '');
  const gates = result.gates.filter(gate => gate.gate !== 'G1');
  if (gates.length) lines.push(`## ${say('Checks', '검사')}`, '', ...gates.map(gate => `- ${gate.gate} ${gate.ok ? say('passed', '통과') : say('failed', '실패')}${gate.detail ? `: ${gate.detail}` : ''}`), '');
  if (result.review) {
    lines.push(`## ${say('Review', '리뷰')}: ${result.review.verdict}`, '');
    for (const finding of result.review.blocking) lines.push(`- ${finding.file ? `[[${finding.file}]]${finding.line ? `:${finding.line}` : ''} ` : ''}${finding.reason}`);
    for (const suggestion of result.review.optional) lines.push(`- ${say('Suggestion', '제안')}: ${suggestion}`);
    lines.push('');
  }
  if (skills.length) lines.push(`## ${say('Skills used', '쓰인 스킬')}`, '', ...skills.map(skill => `- [[skills/${skill}]]`), '');
  if (input.proposals?.length) lines.push(`## ${say('Memory proposals', '메모 제안')}`, '', ...input.proposals.map(rel => `- [[${rel.replace(/\.md$/i, '')}]]`), '');
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * After a run: memory suggestions to inbox/, then the run note linking them. Errors are returned, not thrown;
 * a vault problem must never turn a finished run into a failure.
 */
export function writeRunNotes(project: string, root: string, input: Omit<RunNoteInput, 'proposals'>): { note: string | null; proposals: string[]; error?: string } {
  try {
    const name = runNoteName(input.id, input.request);
    const proposals = proposeMemory(project, root, input.result.memorySuggestions ?? [], { run: input.id, runNote: name, lang: input.lang });
    const written = writeNote(root, `${name}.md`, runNoteText({ ...input, proposals }));
    return written.ok ? { note: written.path, proposals } : { note: null, proposals, error: written.error };
  } catch (error) {
    return { note: null, proposals: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** What read_notes answers at most, so one look-up cannot flood the context. */
export const NOTES_ANSWER_MAX_CHARS = 4000;
const INDEX_MAX_CHARS = 1500;
/** Runs are the harness's own record (read_history covers them); inbox notes are unapproved, so not facts. */
const readable = (folder: string): boolean => folder !== 'runs' && folder !== 'inbox';

/** Titles of the notes the roles may read (specs, decisions and the user's own folders), newest first. Empty when none. */
export function vaultIndexText(root: string): string {
  const notes = listNotes(root).filter(note => readable(note.folder));
  if (!notes.length) return '';
  const lines: string[] = [];
  let used = 0;
  for (const note of notes) {
    const line = `- ${note.path}${note.tags.length ? ` (#${note.tags.slice(0, 3).join(' #')})` : ''}`;
    if (used + line.length + 1 > INDEX_MAX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  const rest = notes.length - lines.length;
  return `${lines.join('\n')}${rest > 0 ? `\n(${rest} more; find them with read_notes search)` : ''}`;
}

/** A readable note's text by vault path ("specs/Login.md", with or without .md), or null. */
export function noteTextOf(root: string, rel: string): string | null {
  const clean = rel.replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
  const withExt = /\.md$/i.test(clean) ? clean : `${clean}.md`;
  if (!readable(withExt.includes('/') ? withExt.split('/')[0]! : '')) return null;
  const read = readNote(root, withExt);
  return 'error' in read ? null : read.text;
}

/** The read_notes tool: one note by path, or the best matches for some words, cut to NOTES_ANSWER_MAX_CHARS. */
export function notesLookup(root: string, query: { path?: string; search?: string }): string {
  if (query.path) {
    const text = noteTextOf(root, query.path);
    if (text === null) return `No readable note "${query.path}". Use a path from the notes list, or search. (Run records are read with read_history; inbox notes are unapproved suggestions.)`;
    return text.length > NOTES_ANSWER_MAX_CHARS ? `${text.slice(0, NOTES_ANSWER_MAX_CHARS)}\n…(cut at ${NOTES_ANSWER_MAX_CHARS} characters of ${text.length})` : text;
  }
  const hits = searchNotes(root, query.search ?? '', { limit: 20 }).filter(hit => readable(hit.folder)).slice(0, 5);
  if (!hits.length) return `No notes match "${query.search ?? ''}".`;
  const text = hits.map(hit => `## ${hit.path}\n${hit.excerpt}`).join('\n\n');
  return text.length > NOTES_ANSWER_MAX_CHARS ? `${text.slice(0, NOTES_ANSWER_MAX_CHARS)}\n…(cut)` : `${text}\n\n(Read a whole note with read_notes path.)`;
}
