// File snapshots for gate G2. The harness compares the working folder before
// and after a step, so what a model says it changed is checked against what
// actually changed. Protected paths (.agent-desk/ and the parts of .git that
// hold history pointers) are tracked separately and can be restored.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface FileState {
  size: number;
  hash: string;
}

export interface Snapshot {
  /** Regular project files (ignored and protected paths excluded). */
  files: Map<string, FileState>;
  /** Protected files, with content kept (up to 1 MB each) so they can be restored. */
  protectedFiles: Map<string, FileState>;
  protectedContent: Map<string, Buffer>;
  /** Text content of small files, kept when `keepContent` was set, so a diff can be shown later. */
  contents: Map<string, string>;
}

export interface SnapshotOptions {
  /** Extra ignore patterns: "dir/" (any directory with that name), "*.ext", or a path prefix. */
  ignore?: readonly string[];
  /** "content" hashes file contents; "stat" uses size and modification time (faster, for read-only checks). */
  mode?: 'content' | 'stat';
  /** Keep the text of small files (128 KB each, 16 MB in total) for diffs. */
  keepContent?: boolean;
}

export const DEFAULT_IGNORE: readonly string[] = ['node_modules/'];
const MAX_PROTECTED_BYTES = 1024 * 1024;
const MAX_HASHED_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_BYTES = 128 * 1024;
const MAX_TEXT_TOTAL = 16 * 1024 * 1024;

export function isProtectedPath(rel: string): boolean {
  return rel.startsWith('.agent-desk/') || rel === '.git/HEAD' || rel === '.git/config' || rel === '.git/packed-refs' || rel.startsWith('.git/refs/');
}

export function matchesIgnore(rel: string, isDirectory: boolean, patterns: readonly string[]): boolean {
  const segments = rel.split('/');
  const directories = isDirectory ? segments : segments.slice(0, -1);
  for (const pattern of patterns) {
    if (pattern.startsWith('*.')) {
      if (!isDirectory && rel.endsWith(pattern.slice(1))) return true;
    } else if (pattern.endsWith('/')) {
      const name = pattern.slice(0, -1);
      if (name.includes('/')) { if (`${rel}${isDirectory ? '/' : ''}`.startsWith(pattern)) return true; }
      else if (directories.includes(name)) return true;
    } else if (rel === pattern || rel.startsWith(`${pattern}/`)) return true;
  }
  return false;
}

function stateOf(file: string, mode: 'content' | 'stat'): FileState {
  const stat = fs.statSync(file);
  if (mode === 'stat' || stat.size > MAX_HASHED_BYTES) return { size: stat.size, hash: `stat:${stat.size}:${Math.floor(stat.mtimeMs)}` };
  return { size: stat.size, hash: crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex') };
}

export function takeSnapshot(cwd: string, options: SnapshotOptions = {}): Snapshot {
  const ignore = [...DEFAULT_IGNORE, ...(options.ignore ?? [])];
  const mode = options.mode ?? 'content';
  const snapshot: Snapshot = { files: new Map(), protectedFiles: new Map(), protectedContent: new Map(), contents: new Map() };
  let textTotal = 0;
  const record = (rel: string, absolute: string) => {
    let state: FileState;
    try { state = stateOf(absolute, mode === 'stat' && isProtectedPath(rel) ? 'content' : mode); } catch { return; }
    if (isProtectedPath(rel)) {
      snapshot.protectedFiles.set(rel, state);
      if (state.size <= MAX_PROTECTED_BYTES) { try { snapshot.protectedContent.set(rel, fs.readFileSync(absolute)); } catch { /* unreadable: cannot be restored */ } }
    } else {
      snapshot.files.set(rel, state);
      if (options.keepContent && state.size <= MAX_TEXT_BYTES && textTotal + state.size <= MAX_TEXT_TOTAL) {
        try {
          const buffer = fs.readFileSync(absolute);
          if (!buffer.includes(0)) { snapshot.contents.set(rel, buffer.toString('utf8')); textTotal += state.size; }
        } catch { /* unreadable: no diff for this file */ }
      }
    }
  };
  const walk = (directory: string, rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (childRel === '.git') { walkGit(absolute); continue; }
        if (childRel === '.agent-desk' || !matchesIgnore(childRel, true, ignore)) walk(absolute, childRel);
      } else if (entry.isFile()) {
        if (isProtectedPath(childRel) || !matchesIgnore(childRel, false, ignore)) record(childRel, absolute);
      }
    }
  };
  const walkGit = (gitDirectory: string) => {
    for (const name of ['HEAD', 'config', 'packed-refs']) {
      const absolute = path.join(gitDirectory, name);
      if (fs.existsSync(absolute)) record(`.git/${name}`, absolute);
    }
    const refs = path.join(gitDirectory, 'refs');
    if (fs.existsSync(refs)) walk(refs, '.git/refs');
  };
  walk(cwd, '');
  return snapshot;
}

export interface Diff {
  added: string[];
  modified: string[];
  deleted: string[];
  /** All changed paths, sorted. */
  all: string[];
}

function diffMaps(before: Map<string, FileState>, after: Map<string, FileState>): Diff {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [file, state] of after) {
    const previous = before.get(file);
    if (!previous) added.push(file); else if (previous.hash !== state.hash) modified.push(file);
  }
  for (const file of before.keys()) if (!after.has(file)) deleted.push(file);
  const sort = (list: string[]) => list.sort();
  return { added: sort(added), modified: sort(modified), deleted: sort(deleted), all: [...added, ...modified, ...deleted].sort() };
}

export const diffSnapshots = (before: Snapshot, after: Snapshot): Diff => diffMaps(before.files, after.files);
export const diffProtected = (before: Snapshot, after: Snapshot): Diff => diffMaps(before.protectedFiles, after.protectedFiles);

/** Puts protected files back as they were in `before`. Returns what could not be restored. */
export function restoreProtected(cwd: string, before: Snapshot, after: Snapshot): { restored: string[]; failed: string[] } {
  const restored: string[] = [];
  const failed: string[] = [];
  const changes = diffProtected(before, after);
  for (const rel of changes.added) {
    try { fs.rmSync(path.join(cwd, rel), { force: true }); restored.push(rel); } catch { failed.push(rel); }
  }
  for (const rel of [...changes.modified, ...changes.deleted]) {
    const content = before.protectedContent.get(rel);
    if (!content) { failed.push(rel); continue; }
    try { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), content); restored.push(rel); } catch { failed.push(rel); }
  }
  return { restored, failed };
}
