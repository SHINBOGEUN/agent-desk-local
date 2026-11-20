// Project notes: a folder of markdown files that Obsidian can open as a vault
// (or a folder inside the user's existing vault). The harness writes run notes
// and memory proposals there from verified data, the user writes specs and
// approves decisions there, and the dashboard shows the [[links]] between them.
//
// Folders (created on first use):
//   specs/      what the user wants built; lead and builder read them with read_notes
//   decisions/  approved rules with their reason; the short list in memory.md comes from here
//   inbox/      memory proposals waiting for approval (status: proposed -> approved)
//   runs/       one note per run, written by the harness after the run
// Anything else in the folder is the user's and is only read.

import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './roles.ts';

export const VAULT_FOLDERS = ['specs', 'decisions', 'inbox', 'runs'] as const;
export const DEFAULT_VAULT = '.agent-desk/notes';
/** Notes listed at most; a vault bigger than this is cut, newest first. */
export const VAULT_MAX_NOTES = 2000;
export const NOTE_MAX_BYTES = 512 * 1024;

export interface NoteLink {
  /** As written, without alias and heading: [[folder/Name#Heading|alias]] -> "folder/Name". */
  target: string;
  /** The note it points to (relative path), or null when no note has that name. */
  resolved: string | null;
}

export interface NoteInfo {
  /** Path inside the vault, with forward slashes, ending in .md. */
  path: string;
  /** File name without .md (what [[links]] use). */
  title: string;
  /** First folder ("specs", "runs", ...) or "" for the vault root. */
  folder: string;
  frontmatter: Record<string, string | string[]>;
  tags: string[];
  links: NoteLink[];
  size: number;
  mtimeMs: number;
}

export interface VaultGraph {
  nodes: { id: string; title: string; folder: string; kind: 'note' | 'missing'; links: number }[];
  edges: { from: string; to: string }[];
}

/** The vault folder for a project: config.vault (absolute, or relative to the project) or .agent-desk/notes. */
export function vaultRoot(project: string, configured?: string): string {
  const value = configured?.trim() || DEFAULT_VAULT;
  return path.resolve(project, value);
}

/** Relative path inside the vault, or an error. Only .md files, no way out of the folder, no hidden folders. */
export function safeNotePath(root: string, rel: string): { ok: true; abs: string; rel: string } | { ok: false; error: string } {
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!clean.toLowerCase().endsWith('.md')) return { ok: false, error: 'a note path must end in .md' };
  if (clean.split('/').some(part => part === '' || part === '.' || part === '..' || part.startsWith('.'))) return { ok: false, error: 'bad note path' };
  if (/[<>:"|?*\u0000-\u001f]/.test(clean)) return { ok: false, error: 'a note path cannot contain < > : " | ? *' };
  const abs = path.resolve(root, ...clean.split('/'));
  const inside = path.relative(root, abs);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return { ok: false, error: 'bad note path' };
  return { ok: true, abs, rel: clean };
}

/** A string usable as a note file name: no path characters, at most `max` characters. */
export function noteFileName(text: string, max = 60): string {
  const cleaned = text.replace(/[\\/<>:"|?*#^[\]\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  const cut = cleaned.length > max ? `${cleaned.slice(0, max).trim()}…` : cleaned;
  return cut || 'untitled';
}

const stripCode = (text: string): string => text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');

/** [[links]] in a note body (not inside code). */
export function parseLinks(text: string): string[] {
  const out: string[] = [];
  for (const match of stripCode(text).matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
    const target = match[1]!.split('|')[0]!.split('#')[0]!.trim();
    if (target && !out.includes(target)) out.push(target);
  }
  return out;
}

/** #tags in the body and `tags:` in the frontmatter. */
export function parseTags(body: string, frontmatter: Record<string, string | string[]>): string[] {
  const tags = new Set<string>();
  const front = frontmatter.tags;
  for (const tag of Array.isArray(front) ? front : typeof front === 'string' ? front.split(/[,\s]+/) : []) if (tag.trim()) tags.add(tag.trim().replace(/^#/, ''));
  for (const match of stripCode(body).matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) if (!/^\d+$/.test(match[1]!)) tags.add(match[1]!);
  return [...tags];
}

/** Resolves [[target]] like Obsidian: a path suffix when it has a slash, else the file name; the shortest path wins. */
export function resolveLink(target: string, paths: readonly string[]): string | null {
  const want = target.replace(/\\/g, '/').replace(/\.md$/i, '').toLowerCase();
  const candidates = paths.filter(rel => {
    const bare = rel.replace(/\.md$/i, '').toLowerCase();
    return want.includes('/') ? bare === want || bare.endsWith(`/${want}`) : bare.split('/').pop() === want;
  });
  return candidates.sort((a, b) => a.length - b.length || a.localeCompare(b))[0] ?? null;
}

function walk(root: string, rel: string, out: { rel: string; size: number; mtimeMs: number }[]): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(root, childRel, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      try { const stat = fs.statSync(path.join(root, childRel)); out.push({ rel: childRel, size: stat.size, mtimeMs: stat.mtimeMs }); } catch { /* vanished */ }
    }
  }
}

function infoOf(rel: string, text: string, size: number, mtimeMs: number): Omit<NoteInfo, 'links'> & { rawLinks: string[] } {
  const parsed = parseFrontmatter(text);
  const frontmatter = parsed.error ? {} : parsed.data;
  const body = parsed.error ? text : parsed.body;
  return {
    path: rel,
    title: rel.split('/').pop()!.replace(/\.md$/i, ''),
    folder: rel.includes('/') ? rel.split('/')[0]! : '',
    frontmatter,
    tags: parseTags(body, frontmatter),
    rawLinks: parseLinks(text),
    size,
    mtimeMs,
  };
}

/** Every note in the vault with its links resolved. A missing folder is an empty vault. */
export function listNotes(root: string): NoteInfo[] {
  const files: { rel: string; size: number; mtimeMs: number }[] = [];
  walk(root, '', files);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const kept = files.slice(0, VAULT_MAX_NOTES);
  const infos = kept.map(file => {
    let text = '';
    if (file.size <= NOTE_MAX_BYTES) { try { text = fs.readFileSync(path.join(root, file.rel), 'utf8'); } catch { /* unreadable */ } }
    return infoOf(file.rel, text, file.size, file.mtimeMs);
  });
  const paths = infos.map(info => info.path);
  return infos.map(({ rawLinks, ...info }) => ({ ...info, links: rawLinks.map(target => ({ target, resolved: resolveLink(target, paths) })) }));
}

/** Nodes for notes and for link targets that are not notes (source files, skills, notes not written yet). */
export function buildGraph(notes: readonly NoteInfo[]): VaultGraph {
  const nodes = new Map<string, VaultGraph['nodes'][number]>();
  const edges: VaultGraph['edges'] = [];
  for (const note of notes) nodes.set(note.path, { id: note.path, title: note.title, folder: note.folder, kind: 'note', links: 0 });
  for (const note of notes) {
    for (const link of note.links) {
      const to = link.resolved ?? `missing:${link.target.toLowerCase()}`;
      if (!link.resolved && !nodes.has(to)) nodes.set(to, { id: to, title: link.target, folder: '', kind: 'missing', links: 0 });
      if (to === note.path || edges.some(edge => edge.from === note.path && edge.to === to)) continue;
      edges.push({ from: note.path, to });
      nodes.get(note.path)!.links++;
      nodes.get(to)!.links++;
    }
  }
  return { nodes: [...nodes.values()], edges };
}

export interface NoteRead { path: string; text: string; mtimeMs: number }

export function readNote(root: string, rel: string): NoteRead | { error: string } {
  const safe = safeNotePath(root, rel);
  if (!safe.ok) return { error: safe.error };
  try {
    const stat = fs.statSync(safe.abs);
    if (stat.size > NOTE_MAX_BYTES) return { error: 'the note is larger than 512 KB' };
    return { path: safe.rel, text: fs.readFileSync(safe.abs, 'utf8'), mtimeMs: stat.mtimeMs };
  } catch { return { error: 'note not found' }; }
}

export type WriteNoteResult = { ok: true; path: string; mtimeMs: number } | { ok: false; error: string; conflict?: boolean };

/**
 * Writes a note. `create` refuses to overwrite; `expectedMtimeMs` refuses when the file changed since it was
 * read (someone edited it in Obsidian meanwhile), so neither side silently loses an edit.
 */
export function writeNote(root: string, rel: string, text: string, options: { create?: boolean; expectedMtimeMs?: number } = {}): WriteNoteResult {
  const safe = safeNotePath(root, rel);
  if (!safe.ok) return { ok: false, error: safe.error };
  if (Buffer.byteLength(text) > NOTE_MAX_BYTES) return { ok: false, error: 'the note is larger than 512 KB' };
  const exists = fs.existsSync(safe.abs);
  if (options.create && exists) return { ok: false, error: 'a note with that name already exists' };
  if (options.expectedMtimeMs !== undefined && exists && Math.abs(fs.statSync(safe.abs).mtimeMs - options.expectedMtimeMs) > 1) {
    return { ok: false, error: 'the note was changed elsewhere (for example in Obsidian); reload it first', conflict: true };
  }
  fs.mkdirSync(path.dirname(safe.abs), { recursive: true });
  fs.writeFileSync(safe.abs, text);
  return { ok: true, path: safe.rel, mtimeMs: fs.statSync(safe.abs).mtimeMs };
}

/** Moves a note (rename or into another folder). Links elsewhere are not rewritten; they show as missing until fixed. */
export function moveNote(root: string, from: string, to: string): WriteNoteResult {
  const source = safeNotePath(root, from);
  const target = safeNotePath(root, to);
  if (!source.ok) return { ok: false, error: source.error };
  if (!target.ok) return { ok: false, error: target.error };
  if (!fs.existsSync(source.abs)) return { ok: false, error: 'note not found' };
  if (fs.existsSync(target.abs)) return { ok: false, error: 'a note with that name already exists' };
  fs.mkdirSync(path.dirname(target.abs), { recursive: true });
  fs.renameSync(source.abs, target.abs);
  return { ok: true, path: target.rel, mtimeMs: fs.statSync(target.abs).mtimeMs };
}

/** Deletes into the vault's .trash folder, as Obsidian does, so a mistake can be undone by hand. */
export function trashNote(root: string, rel: string): { ok: true } | { ok: false; error: string } {
  const safe = safeNotePath(root, rel);
  if (!safe.ok) return { ok: false, error: safe.error };
  if (!fs.existsSync(safe.abs)) return { ok: false, error: 'note not found' };
  const trash = path.join(root, '.trash');
  fs.mkdirSync(trash, { recursive: true });
  let name = path.basename(safe.abs);
  for (let n = 2; fs.existsSync(path.join(trash, name)); n++) name = path.basename(safe.abs).replace(/\.md$/i, ` ${n}.md`);
  fs.renameSync(safe.abs, path.join(trash, name));
  return { ok: true };
}

/** Rewrites one frontmatter key (adds the frontmatter when missing), keeping the rest of the note as it is. */
export function setNoteProperty(text: string, key: string, value: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  const line = `${key}: ${value}`;
  if (!normalized.startsWith('---\n')) return `---\n${line}\n---\n${normalized}`;
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return `---\n${line}\n---\n${normalized}`;
  const head = normalized.slice(4, end).split('\n');
  const at = head.findIndex(entry => new RegExp(`^${key}\\s*:`).test(entry));
  if (at >= 0) head[at] = line; else head.push(line);
  return `---\n${head.join('\n')}${normalized.slice(end)}`;
}

export interface NoteHit { path: string; title: string; folder: string; score: number; excerpt: string }

/**
 * Finds notes by words (title counts double), newest first among equal scores. Excerpts are cut around the
 * first match so the answer stays small. `folders` limits where to look (default: everything but runs/).
 */
export function searchNotes(root: string, words: string, options: { folders?: readonly string[]; limit?: number; excerptChars?: number } = {}): NoteHit[] {
  const terms = [...new Set(words.toLowerCase().split(/\s+/).filter(term => term.length >= 2))];
  if (!terms.length) return [];
  const notes = listNotes(root).filter(note => (options.folders ? options.folders.includes(note.folder) : note.folder !== 'runs'));
  const hits: NoteHit[] = [];
  for (const note of notes) {
    const read = readNote(root, note.path);
    if ('error' in read) continue;
    const text = read.text.toLowerCase();
    const title = note.title.toLowerCase();
    let score = 0;
    for (const term of terms) { if (title.includes(term)) score += 2; if (text.includes(term)) score += 1; }
    if (!score) continue;
    const first = Math.min(...terms.map(term => text.indexOf(term)).filter(at => at >= 0), text.length);
    const span = options.excerptChars ?? 400;
    const start = Math.max(0, first - Math.floor(span / 4));
    const excerpt = read.text.slice(start, start + span).replace(/\s+/g, ' ').trim();
    hits.push({ path: note.path, title: note.title, folder: note.folder, score, excerpt: `${start > 0 ? '…' : ''}${excerpt}${start + span < read.text.length ? '…' : ''}` });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, options.limit ?? 5);
}
