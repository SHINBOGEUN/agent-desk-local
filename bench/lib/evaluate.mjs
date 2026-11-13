// Workspace preparation and objective grading shared by the runner and the
// task validator. Zero dependencies; works on Windows, macOS and Linux.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const benchDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sampleDirectory = path.join(benchDirectory, 'sample-app');
export const tasksDirectory = path.join(benchDirectory, 'tasks');
const ACCEPTANCE_DIR = '.bench-acceptance';
const IGNORED = new Set(['.git', ACCEPTANCE_DIR, 'node_modules', 'data']);

// Task sets: "standard" (T01-T10, the original benchmark), "hard" (H01-H05,
// multi-file tasks with hidden edge cases) or "all". Defaults to "standard" so
// existing labels keep their meaning.
const SET_PATTERNS = { standard: /^T\d+/, hard: /^H\d+/, all: /^[TH]\d+/ };

export function loadTasks(filter = null, set = 'standard') {
  const pattern = SET_PATTERNS[set];
  if (!pattern) throw new Error(`unknown task set "${set}" (standard, hard, all)`);
  const wanted = filter ? new Set(filter.map(id => id.toUpperCase())) : null;
  return fs.readdirSync(tasksDirectory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && pattern.test(entry.name))
    .map(entry => {
      const directory = path.join(tasksDirectory, entry.name);
      const task = JSON.parse(fs.readFileSync(path.join(directory, 'task.json'), 'utf8'));
      return { ...task, directory };
    })
    .filter(task => !wanted || wanted.has(task.id.toUpperCase()))
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}

export function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

// A fresh copy of the sample app. `git init` makes the workspace its own
// repository root so coding agents do not pick up instructions (AGENTS.md)
// from a parent repository. Git is optional.
export function prepareWorkspace(destination) {
  if (fs.existsSync(destination)) throw new Error(`workspace already exists: ${destination}`);
  copyDirectory(sampleDirectory, destination);
  const git = (...args) => spawnSync('git', args, { cwd: destination, stdio: 'ignore', windowsHide: true });
  const initialized = git('init', '-q').status === 0
    && git('add', '-A').status === 0
    && git('-c', 'user.name=bench', '-c', 'user.email=bench@localhost', 'commit', '-q', '-m', 'baseline').status === 0;
  return { path: destination, git: initialized, snapshot: snapshotTree(destination) };
}

export function snapshotTree(root) {
  const result = {};
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (IGNORED.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) result[path.relative(root, full).split(path.sep).join('/')] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return result;
}

export function changedFiles(before, after) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter(name => before[name] !== after[name]).sort();
}

function runNodeTests(cwd, files) {
  if (!files.length) return { pass: false, passed: 0, failed: 0, output: 'no test files found' };
  const result = spawnSync(process.execPath, ['--test', ...files], { cwd, encoding: 'utf8', timeout: 120_000, windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' } });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const count = name => Number(output.match(new RegExp(`^# ${name} (\\d+)`, 'm'))?.[1] || 0);
  return { pass: result.status === 0, passed: count('pass'), failed: count('fail'), timedOut: result.error?.code === 'ETIMEDOUT', output: output.slice(-4000) };
}

function listTests(directory, root = directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTests(full, root);
    return /\.test\.m?js$/.test(entry.name) ? [path.relative(root, full)] : [];
  }).sort();
}

// Runs the workspace's own tests (regression) and the hidden acceptance test.
export function evaluateCode(task, workspace) {
  const visible = runNodeTests(workspace, listTests(path.join(workspace, 'test'), workspace));
  const hiddenDirectory = path.join(workspace, ACCEPTANCE_DIR);
  fs.rmSync(hiddenDirectory, { recursive: true, force: true });
  fs.mkdirSync(hiddenDirectory);
  try {
    fs.copyFileSync(path.join(tasksDirectory, '_shared', 'harness.mjs'), path.join(hiddenDirectory, 'harness.mjs'));
    fs.copyFileSync(path.join(task.directory, 'acceptance.test.mjs'), path.join(hiddenDirectory, 'acceptance.test.mjs'));
    const acceptance = runNodeTests(workspace, [path.join(ACCEPTANCE_DIR, 'acceptance.test.mjs')]);
    return { success: visible.pass && acceptance.pass, visible, acceptance };
  } finally {
    fs.rmSync(hiddenDirectory, { recursive: true, force: true });
  }
}

export function evaluateAnswer(task, answer, changed) {
  const normalized = String(answer || '').replace(/\\/g, '/');
  const missing = (task.expect?.answerIncludes || []).filter(text => !normalized.includes(text));
  const unexpectedChanges = task.expect?.noFileChanges ? changed : [];
  return { success: !missing.length && !unexpectedChanges.length, missing, unexpectedChanges };
}

export function evaluate(task, workspace, { answer = '', before = {} } = {}) {
  const changed = changedFiles(before, snapshotTree(workspace));
  const result = task.kind === 'answer' ? evaluateAnswer(task, answer, changed) : evaluateCode(task, workspace);
  return { ...result, changedFiles: changed };
}
