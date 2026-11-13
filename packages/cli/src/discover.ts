// Finds the real Codex executable. On Windows, npm installs a codex.cmd shim
// that cannot be started without a shell, so the search follows the shim to
// the actual codex.exe inside the npm package.

import fs from 'node:fs';
import path from 'node:path';

export interface Found {
  path: string;
  source: string;
}

const isFile = (file: string): boolean => { try { return fs.statSync(file).isFile(); } catch { return false; } };

function findExecutableIn(directory: string, names: readonly string[], depth: number): string | null {
  if (depth < 0) return null;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) if (entry.isFile() && names.includes(entry.name.toLowerCase())) return path.join(directory, entry.name);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const hit = findExecutableIn(path.join(directory, entry.name), names, depth - 1);
    if (hit) return hit;
  }
  return null;
}

export function resolveCodexExecutable(input: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; saved?: string }): Found | null {
  const { env, platform } = input;
  const win = platform === 'win32';
  const exeNames = win ? ['codex.exe'] : ['codex'];
  if (env.AGENT_DESK_CODEX && isFile(env.AGENT_DESK_CODEX)) return { path: env.AGENT_DESK_CODEX, source: 'AGENT_DESK_CODEX' };
  if (input.saved && isFile(input.saved)) return { path: input.saved, source: 'saved settings' };

  const separator = win ? ';' : ':';
  const pathDirectories = (env.PATH ?? env.Path ?? '').split(separator).filter(Boolean);
  for (const directory of pathDirectories) {
    for (const name of exeNames) {
      const candidate = path.join(directory, name);
      if (isFile(candidate)) return { path: candidate, source: 'PATH' };
    }
    if (win) {
      // npm shim: <dir>\codex.cmd next to <dir>\node_modules\@openai\codex\...\codex.exe
      if (isFile(path.join(directory, 'codex.cmd')) || isFile(path.join(directory, 'codex.ps1'))) {
        const hit = findExecutableIn(path.join(directory, 'node_modules', '@openai', 'codex'), exeNames, 8);
        if (hit) return { path: hit, source: 'npm global (followed codex.cmd)' };
      }
    }
  }
  if (win && env.APPDATA) {
    const hit = findExecutableIn(path.join(env.APPDATA, 'npm', 'node_modules', '@openai', 'codex'), exeNames, 8);
    if (hit) return { path: hit, source: 'npm global folder' };
  }
  return null;
}

/** Codex App Server is experimental; these are the versions the adapter was checked against (ADR 0003). */
export const VERIFIED_CODEX_MINOR = '0.167';

export function versionWarning(versionText: string): string | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(versionText);
  if (!match) return 'could not read the Codex version';
  const minor = `${match[1]}.${match[2]}`;
  return minor === VERIFIED_CODEX_MINOR ? null : `Codex ${match[0]} has not been checked with this adapter (checked: ${VERIFIED_CODEX_MINOR}.x). The App Server protocol is experimental, so re-run the smoke test.`;
}
