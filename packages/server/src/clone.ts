// "Import from git": clone a repository into a folder the user chose, optionally on a work branch and with its
// packages installed, so the start card (and the survey) can take over. The URL is checked and passed after "--",
// prompts are turned off (a missing login fails instead of hanging), and every step has a time limit.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface CloneInput {
  url: string;
  /** Folder to clone into (created inside `parent`). */
  parent: string;
  /** Folder name; derived from the URL when empty. */
  name?: string;
  /** Create and switch to this branch after cloning. */
  branch?: string;
  /** Install packages (npm, pnpm or yarn, by lockfile) when the project has a package.json. */
  install?: boolean;
}

export interface CloneStep { step: 'clone' | 'branch' | 'install'; ok: boolean; command: string; output: string; skipped?: string }
export interface CloneResult { ok: boolean; path: string; steps: CloneStep[]; error?: string }

const URL_PATTERN = /^(https?:\/\/[^\s]+|ssh:\/\/[^\s]+|git@[\w.-]+:[^\s]+|file:\/\/[^\s]+)$/i;

/** https, ssh, scp-style (git@host:path) or file URLs; nothing that git could read as an option. */
export const isCloneUrl = (url: string): boolean => URL_PATTERN.test(url.trim()) && !url.trim().startsWith('-');

/** "https://github.com/me/my-app.git" -> "my-app". */
export function repoName(url: string): string {
  const last = url.trim().replace(/[\\/]+$/, '').split(/[\\/:]/).at(-1) ?? '';
  return last.replace(/\.git$/i, '').replace(/[^\w.-]/g, '-').replace(/^[.-]+/, '') || 'project';
}

const validName = (name: string): boolean => /^[\w][\w.-]{0,99}$/.test(name) && name !== '.' && name !== '..';
const validBranch = (name: string): boolean => /^[\w][\w./-]{0,99}$/.test(name) && !name.includes('..') && !name.endsWith('/') && !name.endsWith('.lock');

function run(command: string, args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv, shell = false): Promise<{ code: number | null; output: string }> {
  return new Promise(resolve => {
    let output = '';
    const child = spawn(command, args, { cwd, env, shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (data: Buffer): void => { output = (output + data.toString('utf8')).slice(-4000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => { output += '\n(timed out)'; child.kill('SIGKILL'); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); resolve({ code: null, output: error.message }); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, output: output.trim() }); });
  });
}

export async function cloneProject(input: CloneInput, env: NodeJS.ProcessEnv, limits = { cloneMs: 10 * 60_000, installMs: 15 * 60_000 }): Promise<CloneResult> {
  const url = input.url.trim();
  const fail = (error: string, steps: CloneStep[] = [], at = ''): CloneResult => ({ ok: false, path: at, steps, error });
  if (!isCloneUrl(url)) return fail('the address must start with https://, ssh://, git@ or file://');
  if (!path.isAbsolute(input.parent) || !fs.existsSync(input.parent) || !fs.statSync(input.parent).isDirectory()) return fail('the folder to clone into must be an existing absolute folder');
  const name = (input.name ?? '').trim() || repoName(url);
  if (!validName(name)) return fail('the folder name may use letters, digits, ".", "-" and "_" only');
  const branch = (input.branch ?? '').trim();
  if (branch && !validBranch(branch)) return fail('that branch name is not allowed');
  const target = path.join(input.parent, name);
  if (fs.existsSync(target) && fs.readdirSync(target).length) return fail(`${target} already exists and is not empty`);

  // no terminal prompts: a private repository without a stored login fails with a message instead of waiting forever
  const gitEnv = { ...env, GIT_TERMINAL_PROMPT: '0' };
  const steps: CloneStep[] = [];
  const cloned = await run('git', ['clone', '--', url, target], input.parent, limits.cloneMs, gitEnv);
  steps.push({ step: 'clone', ok: cloned.code === 0, command: `git clone ${url} ${name}`, output: cloned.output });
  if (cloned.code !== 0) return fail(cloned.code === null && /ENOENT/.test(cloned.output) ? 'git is not installed or not on PATH' : 'git clone failed', steps);

  if (branch) {
    const switched = await run('git', ['checkout', '-b', branch], target, 60_000, gitEnv);
    steps.push({ step: 'branch', ok: switched.code === 0, command: `git checkout -b ${branch}`, output: switched.output });
  }

  if (input.install) {
    const has = (file: string): boolean => fs.existsSync(path.join(target, file));
    if (!has('package.json')) steps.push({ step: 'install', ok: true, command: '', output: '', skipped: 'no package.json' });
    else {
      // fixed commands only (no user text), run through the shell so npm.cmd works on Windows
      const command = has('pnpm-lock.yaml') ? 'pnpm install' : has('yarn.lock') ? 'yarn install' : has('package-lock.json') ? 'npm ci' : 'npm install';
      const installed = await run(command, [], target, limits.installMs, env, true);
      steps.push({ step: 'install', ok: installed.code === 0, command, output: installed.output });
    }
  }
  return { ok: steps.every(step => step.ok), path: target, steps, ...(steps.every(step => step.ok) ? {} : { error: 'cloned, but a later step failed' }) };
}
