// Restore points: a copy of the project files taken before the build step, so
// "revert this run" is possible after a run ends as needs_review or failed.
// Plain file copies, no git involvement, so the user's branches and staging
// area are never touched (ADR 0006). Reverting is never automatic.

import fs from 'node:fs';
import path from 'node:path';
import { takeSnapshot } from './snapshot.ts';
import type { FileState, Snapshot } from './snapshot.ts';

export interface RestorePointInfo {
  dir: string;
  files: number;
  bytes: number;
}

export interface RestoreLimits {
  maxFiles: number;
  maxBytes: number;
}

export const DEFAULT_RESTORE_LIMITS: RestoreLimits = { maxFiles: 5000, maxBytes: 100 * 1024 * 1024 };

interface Manifest {
  createdAt: string;
  files: Record<string, string>;
}

export type CreateResult = ({ ok: true } & RestorePointInfo) | { ok: false; reason: string };

/** Copies the files of `snapshot` (taken in content mode) into `dir`. */
export function createRestorePoint(cwd: string, dir: string, snapshot: Snapshot, limits: RestoreLimits = DEFAULT_RESTORE_LIMITS): CreateResult {
  let bytes = 0;
  for (const state of snapshot.files.values()) bytes += state.size;
  if (snapshot.files.size > limits.maxFiles) return { ok: false, reason: `${snapshot.files.size} files is over the restore-point limit of ${limits.maxFiles}` };
  if (bytes > limits.maxBytes) return { ok: false, reason: `${Math.ceil(bytes / 1048576)} MB is over the restore-point limit of ${Math.floor(limits.maxBytes / 1048576)} MB` };
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    const manifest: Manifest = { createdAt: new Date().toISOString(), files: {} };
    for (const [rel, state] of snapshot.files) {
      const target = path.join(dir, 'files', ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(cwd, ...rel.split('/')), target);
      manifest.files[rel] = state.hash;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    return { ok: true, dir, files: snapshot.files.size, bytes };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: false, reason: `could not write the restore point: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export interface RevertPlan {
  restore: string[];   // modified or deleted since the restore point
  remove: string[];    // created since the restore point
}

export interface RevertOptions {
  ignore?: readonly string[];
  /** Report what would change without touching files. */
  dryRun?: boolean;
}

export interface RevertResult extends RevertPlan {
  ok: boolean;
  error?: string;
  applied: boolean;
}

function readManifest(dir: string): Manifest | null {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest; } catch { return null; }
}

export function revertToRestorePoint(cwd: string, dir: string, options: RevertOptions = {}): RevertResult {
  const manifest = readManifest(dir);
  if (!manifest) return { ok: false, error: `no restore point at ${dir}`, restore: [], remove: [], applied: false };
  const now = takeSnapshot(cwd, { ...(options.ignore ? { ignore: options.ignore } : {}) }).files;
  const restore: string[] = [];
  const remove: string[] = [];
  for (const [rel, hash] of Object.entries(manifest.files)) {
    const state: FileState | undefined = now.get(rel);
    if (!state || state.hash !== hash) restore.push(rel);
  }
  for (const rel of now.keys()) if (!(rel in manifest.files)) remove.push(rel);
  restore.sort(); remove.sort();
  if (options.dryRun) return { ok: true, restore, remove, applied: false };
  try {
    for (const rel of restore) {
      const target = path.join(cwd, ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(dir, 'files', ...rel.split('/')), target);
    }
    for (const rel of remove) fs.rmSync(path.join(cwd, ...rel.split('/')), { force: true });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), restore, remove, applied: false };
  }
  return { ok: true, restore, remove, applied: true };
}
