// Memory proposals as notes. A run's memory suggestions become inbox/ notes; the user approves one by
// setting `status: approved` in Obsidian (picked up before the next run) or with the dashboard's
// "add to memory" button. Approval adds the fact to memory.md and moves the note to decisions/, where it
// keeps its reason and a link to the run it came from. Nothing reaches memory.md without that step.

import fs from 'node:fs';
import path from 'node:path';
import { addMemory, loadMemory, memoryFacts } from './memory.ts';
import { listNotes, moveNote, noteFileName, readNote, setNoteProperty, trashNote, VAULT_FOLDERS, writeNote } from './vault.ts';

type Lang = 'en' | 'ko';
const APPROVED = ['approved', '승인'];
const REJECTED = ['rejected', '거절'];
const same = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();
const today = (): string => new Date().toISOString().slice(0, 10);
const factOf = (frontmatter: Record<string, string | string[]>, title: string): string => (typeof frontmatter.fact === 'string' && frontmatter.fact.trim() ? frontmatter.fact.trim() : title);

/** Front matter values are one line; quotes keep a leading or trailing space or a colon readable. */
const quoted = (value: string): string => `"${value.replace(/\s+/g, ' ').replace(/"/g, "'").trim()}"`;

function freePath(root: string, folder: string, name: string): string {
  let rel = `${folder}/${noteFileName(name)}.md`;
  for (let n = 2; fs.existsSync(path.join(root, ...rel.split('/'))); n++) rel = `${folder}/${noteFileName(name)} ${n}.md`;
  return rel;
}

/** Writes inbox notes for suggestions not yet in memory, the inbox or decisions. Returns the new note paths. */
export function proposeMemory(project: string, root: string, facts: readonly string[], options: { run?: number; runNote?: string; lang?: Lang } = {}): string[] {
  const known = [...memoryFacts(loadMemory(project)), ...listNotes(root).filter(note => note.folder === 'inbox' || note.folder === 'decisions').map(note => factOf(note.frontmatter, note.title))];
  const created: string[] = [];
  for (const raw of facts) {
    const fact = raw.replace(/\s+/g, ' ').trim();
    if (!fact || known.some(item => same(item, fact))) continue;
    known.push(fact);
    const rel = freePath(root, 'inbox', fact);
    const ko = options.lang === 'ko';
    const text = [
      '---', 'type: memory', 'status: proposed', `fact: ${quoted(fact)}`, ...(options.run !== undefined ? [`run: ${options.run}`] : []), `created: ${today()}`, '---',
      `# ${fact}`, '',
      ko ? '실행 중에 나온 메모 제안입니다. 맞으면 `status`를 `approved`로 바꾸거나 대시보드에서 "메모에 추가"를 누르세요. 틀리면 `rejected`로 바꾸세요.'
        : 'A memory suggestion from a run. If it is right, set `status` to `approved` or press "Add to memory" in the dashboard. If not, set it to `rejected`.',
      '', ...(options.runNote ? [`${ko ? '출처' : 'From'}: [[${options.runNote}]]`] : []), '',
    ].join('\n');
    if (writeNote(root, rel, text, { create: true }).ok) created.push(rel);
  }
  return created;
}

export type ApproveResult = { ok: true; decision: string; fact: string } | { ok: false; error: string };

/** Adds an inbox note's fact to memory.md and moves the note to decisions/. */
export function approveProposal(project: string, root: string, rel: string): ApproveResult {
  const read = readNote(root, rel);
  if ('error' in read) return { ok: false, error: read.error };
  const note = listNotes(root).find(entry => entry.path === read.path);
  const fact = factOf(note?.frontmatter ?? {}, read.path.split('/').pop()!.replace(/\.md$/i, ''));
  const added = addMemory(project, fact);
  if (!added.ok && added.error !== 'already in memory') return { ok: false, error: added.error };
  const text = setNoteProperty(setNoteProperty(read.text, 'status', 'approved'), 'approved', today());
  const written = writeNote(root, read.path, text);
  if (!written.ok) return { ok: false, error: written.error };
  if (read.path.startsWith('decisions/')) return { ok: true, decision: read.path, fact };
  const target = freePath(root, 'decisions', read.path.split('/').pop()!.replace(/\.md$/i, ''));
  const moved = moveNote(root, read.path, target);
  return moved.ok ? { ok: true, decision: moved.path, fact } : { ok: false, error: moved.error };
}

/**
 * The dashboard's "add to memory" on a run suggestion: approves the matching inbox note, or writes a decision
 * note when there is none (a vault set up after the run), so every memory entry has a note with its source.
 */
export function recordDecision(project: string, root: string, fact: string, options: { run?: number; runNote?: string; lang?: Lang } = {}): ApproveResult {
  const inbox = listNotes(root).find(note => note.folder === 'inbox' && same(factOf(note.frontmatter, note.title), fact));
  if (inbox) return approveProposal(project, root, inbox.path);
  const added = addMemory(project, fact);
  if (!added.ok && added.error !== 'already in memory') return { ok: false, error: added.error };
  if (listNotes(root).some(note => note.folder === 'decisions' && same(factOf(note.frontmatter, note.title), fact))) return { ok: true, decision: '', fact };
  const rel = freePath(root, 'decisions', fact);
  const ko = options.lang === 'ko';
  const text = ['---', 'type: memory', 'status: approved', `fact: ${quoted(fact)}`, ...(options.run !== undefined ? [`run: ${options.run}`] : []), `approved: ${today()}`, '---', `# ${fact}`, '', ...(options.runNote ? [`${ko ? '출처' : 'From'}: [[${options.runNote}]]`, ''] : [])].join('\n');
  const written = writeNote(root, rel, text, { create: true });
  return written.ok ? { ok: true, decision: written.path, fact } : { ok: false, error: written.error };
}

export interface SyncResult { approved: string[]; rejected: string[]; errors: string[] }

/** Applies the status the user set in Obsidian: approved notes go to memory and decisions/, rejected ones to .trash. */
export function syncApprovals(project: string, root: string): SyncResult {
  const result: SyncResult = { approved: [], rejected: [], errors: [] };
  if (!fs.existsSync(root)) return result;
  for (const note of listNotes(root).filter(entry => entry.folder === 'inbox')) {
    const status = typeof note.frontmatter.status === 'string' ? note.frontmatter.status.trim().toLowerCase() : '';
    if (APPROVED.includes(status)) {
      const done = approveProposal(project, root, note.path);
      if (done.ok) result.approved.push(done.fact); else result.errors.push(`${note.path}: ${done.error}`);
    } else if (REJECTED.includes(status)) {
      const gone = trashNote(root, note.path);
      if (gone.ok) result.rejected.push(note.path); else result.errors.push(`${note.path}: ${gone.error}`);
    }
  }
  return result;
}

/** Creates the four folders (empty; the dashboard explains each one), so Obsidian shows the layout from the start. */
export function initVault(root: string): string[] {
  const created: string[] = [];
  for (const folder of VAULT_FOLDERS) {
    const abs = path.join(root, folder);
    if (!fs.existsSync(abs)) { fs.mkdirSync(abs, { recursive: true }); created.push(folder); }
  }
  return created;
}
