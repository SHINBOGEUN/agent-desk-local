// `agent-desk run` and `agent-desk doctor`. All outside effects (runtime
// creation, output, prompts, data folder) are injected so tests can drive the
// whole command with a FakeRuntime.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { DoctorCheck, RoleId, Runtime, UserQuestion } from '#core';
import { planText, revertToRestorePoint, runRequest } from '#orchestrator';
import type { ReviewPolicy } from '#orchestrator';
import { RunStore } from '#store';
import { loadProjectConfig } from './config.ts';
import type { ProjectConfig } from './config.ts';
import { resolveClaudeExecutable, resolveCodexExecutable, versionWarning } from './discover.ts';
import type { Found } from './discover.ts';
import { EXIT_CODES, describeEvent, summarize } from './format.ts';
import { dataDirectory, readMachineSettings, writeMachineSettings } from './paths.ts';

export type RuntimeKind = 'codex' | 'claude' | 'fake';

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  cwd: string;
  out(text: string): void;
  err(text: string): void;
  /** Interactive answer to an agent question; omitted when stdin is not a terminal. */
  ask?: (question: UserQuestion) => Promise<string>;
  createRuntime(kind: RuntimeKind, command?: string): Runtime;
  signal?: AbortSignal;
  /** Returns the output of `<exe> --version`. */
  readVersion?: (exe: string) => Promise<string>;
}

interface Parsed {
  command: string;
  request: string;
  project?: string | undefined;
  unattended: boolean;
  json: boolean;
  yes: boolean;
  runtime?: RuntimeKind | undefined;
  review?: ReviewPolicy;
  verify: string[];
  maxTokens?: number | undefined;
  maxMinutes?: number | undefined;
  help: boolean;
  errors: string[];
}

export const USAGE = `Usage:
  agent-desk run "<request>" [options]   run one request in a project
  agent-desk revert <run id> [--yes]     undo a run's file changes (shows the plan first; --yes applies it)
  agent-desk doctor [--project <dir>]    check Codex, settings and project config

Options for run:
  --project <dir>       project folder (default: current folder)
  --unattended          never ask questions; a needed answer ends the run as needs_user
  --verify "<command>"  command the harness runs itself (repeatable; overrides config)
  --review <policy>     always | auto | never
  --max-tokens <n>      stop when total tokens exceed n (resumable)
  --max-minutes <n>     stop after n minutes (resumable)
  --json                print the full result as JSON

Exit codes: 0 completed, 1 failed, 2 needs_review, 3 needs_user, 4 interrupted, 64 usage error`;

export function parseArgs(argv: string[]): Parsed {
  const parsed: Parsed = { command: '', request: '', unattended: false, json: false, yes: false, verify: [], help: false, errors: [] };
  const rest: string[] = [];
  const value = (index: number, flag: string): string | undefined => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) { parsed.errors.push(`${flag} needs a value`); return undefined; }
    return next;
  };
  const number = (text: string | undefined, flag: string): number | undefined => {
    if (text === undefined) return undefined;
    const n = Number(text);
    if (!Number.isFinite(n) || n <= 0) { parsed.errors.push(`${flag} expects a positive number`); return undefined; }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--help': case '-h': parsed.help = true; break;
      case '--unattended': parsed.unattended = true; break;
      case '--json': parsed.json = true; break;
      case '--yes': parsed.yes = true; break;
      case '--project': parsed.project = value(i, arg); i++; break;
      case '--verify': { const v = value(i, arg); if (v) parsed.verify.push(v); i++; break; }
      case '--max-tokens': parsed.maxTokens = number(value(i, arg), arg); i++; break;
      case '--max-minutes': parsed.maxMinutes = number(value(i, arg), arg); i++; break;
      case '--runtime': { const v = value(i, arg); if (v === 'codex' || v === 'claude' || v === 'fake') parsed.runtime = v; else if (v) parsed.errors.push('--runtime expects codex, claude or fake'); i++; break; }
      case '--review': { const v = value(i, arg); if (v === 'always' || v === 'auto' || v === 'never') parsed.review = v; else if (v) parsed.errors.push('--review expects always, auto or never'); i++; break; }
      default:
        if (arg.startsWith('--')) parsed.errors.push(`unknown option ${arg}`);
        else rest.push(arg);
    }
  }
  parsed.command = rest[0] ?? '';
  parsed.request = rest.slice(1).join(' ').trim();
  return parsed;
}

const defaultVersion = (exe: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(exe, ['--version'], { timeout: 15000, windowsHide: true }, (error, stdout, stderr) => (error ? reject(error) : resolve(`${stdout}${stderr}`.trim())));
  });

export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.help || parsed.command === '' || parsed.command === 'help') { deps.out(`${USAGE}\n`); return parsed.errors.length ? 64 : 0; }
  if (parsed.errors.length) { deps.err(`${parsed.errors.join('\n')}\n\n${USAGE}\n`); return 64; }
  const project = path.resolve(deps.cwd, parsed.project ?? '.');
  if (parsed.command === 'doctor') return doctor(parsed, project, deps);
  if (parsed.command === 'run') return run(parsed, project, deps);
  if (parsed.command === 'revert') return revert(parsed, deps);
  deps.err(`unknown command "${parsed.command}"\n\n${USAGE}\n`);
  return 64;
}

function locate(kind: 'codex' | 'claude', deps: CliDeps, saved: ReturnType<typeof readMachineSettings>): Found | null {
  const common = { env: deps.env, platform: deps.platform };
  return kind === 'codex'
    ? resolveCodexExecutable({ ...common, ...(saved.codex?.path ? { saved: saved.codex.path } : {}) })
    : resolveClaudeExecutable({ ...common, ...(saved.claude?.path ? { saved: saved.claude.path } : {}) });
}

/** Runtime kind for every role: --runtime wins, then config.runtimes per role, then config.runtime, then codex. */
function assignRuntimes(parsed: Parsed, config: ProjectConfig): Record<RoleId, RuntimeKind> {
  const base: RuntimeKind = parsed.runtime ?? config.runtime ?? 'codex';
  const pick = (role: 'lead' | 'builder' | 'verifier' | 'researcher'): RuntimeKind => (parsed.runtime ? parsed.runtime : config.runtimes?.[role] ?? base);
  return { lead: pick('lead'), builder: pick('builder'), verifier: pick('verifier'), researcher: pick('researcher') };
}

function kindsOf(config: ProjectConfig): RuntimeKind[] {
  return [...new Set(Object.values(assignRuntimes({ runtime: undefined } as Parsed, config)))];
}

async function doctor(parsed: Parsed, project: string, deps: CliDeps): Promise<number> {
  const checks: DoctorCheck[] = [];
  const dir = dataDirectory(deps.env, deps.platform);
  const saved = readMachineSettings(dir);
  const early = loadProjectConfig(project);
  const kinds = parsed.runtime ? [parsed.runtime] : early.ok ? kindsOf(early.config) : (['codex'] as RuntimeKind[]);

  for (const kind of kinds) {
    let command: string | undefined;
    if (kind !== 'fake') {
      const found = locate(kind, deps, saved);
      if (!found) {
        checks.push(kind === 'codex'
          ? { name: 'codex executable', ok: false, detail: 'not found on PATH or in the npm global folder', fix: 'install Codex (npm i -g @openai/codex) or set AGENT_DESK_CODEX to codex.exe' }
          : { name: 'claude executable', ok: false, detail: 'not found on PATH or in ~/.local/bin', fix: 'install Claude Code and sign in, or set AGENT_DESK_CLAUDE to claude.exe' });
        continue;
      }
      command = found.path;
      checks.push({ name: `${kind} executable`, ok: true, detail: `${found.path} (${found.source})` });
      let version = '';
      try {
        version = await (deps.readVersion ?? defaultVersion)(found.path);
        const warning = kind === 'codex' ? versionWarning(version) : null;
        checks.push({ name: `${kind} version`, ok: warning === null, detail: warning ?? version });
      } catch (error) {
        checks.push({ name: `${kind} version`, ok: false, detail: `could not run --version: ${error instanceof Error ? error.message : String(error)}`, fix: 'run the executable by hand and check it starts' });
      }
      try {
        writeMachineSettings(dir, { ...readMachineSettings(dir), [kind]: { path: found.path, ...(version ? { version } : {}), checkedAt: new Date().toISOString() } });
        checks.push({ name: 'machine settings', ok: true, detail: `${kind} saved in ${dir}` });
      } catch (error) {
        checks.push({ name: 'machine settings', ok: false, detail: `could not write ${dir}: ${error instanceof Error ? error.message : String(error)}`, fix: 'set AGENT_DESK_HOME to a writable folder' });
      }
    }
    if (kind === 'fake' || command) {
      try {
        const result = await deps.createRuntime(kind, command).doctor();
        checks.push(...result.checks);
      } catch (error) {
        checks.push({ name: `${kind} runtime`, ok: false, detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  const config = loadProjectConfig(project);
  if (!config.ok) checks.push({ name: 'project config', ok: false, detail: config.errors.join('; '), fix: `fix ${path.join(project, '.agent-desk', 'config.json')}` });
  else {
    checks.push({ name: 'project config', ok: true, detail: config.exists ? 'valid' : 'none (defaults)' });
    const verifyCount = config.config.verify?.length ?? 0;
    checks.push(verifyCount > 0
      ? { name: 'verify commands', ok: true, detail: `${verifyCount} configured` }
      : { name: 'verify commands', ok: false, detail: 'none configured; build runs will end as needs_review', fix: `add "verify": ["<test command>"] to ${path.join(project, '.agent-desk', 'config.json')}${suggestVerify(project)}` });
  }

  for (const check of checks) {
    deps.out(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}\n`);
    if (!check.ok && check.fix) deps.out(`     fix: ${check.fix}\n`);
  }
  return checks.every(check => check.ok) ? 0 : 1;
}

/** Suggests a candidate command from package.json; the user still has to confirm it. */
function suggestVerify(project: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    if (pkg.scripts?.test) return ` (candidate: "npm test")`;
  } catch { /* no package.json */ }
  return '';
}

async function run(parsed: Parsed, project: string, deps: CliDeps): Promise<number> {
  if (!parsed.request) { deps.err(`run needs a request\n\n${USAGE}\n`); return 64; }
  if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) { deps.err(`project folder not found: ${project}\n`); return 64; }
  const loaded = loadProjectConfig(project);
  if (!loaded.ok) { deps.err(`${loaded.errors.join('\n')}\n`); return 64; }
  const config: ProjectConfig = loaded.config;
  const dir = dataDirectory(deps.env, deps.platform);
  const assignment = assignRuntimes(parsed, config);
  const instances = new Map<RuntimeKind, Runtime>();
  for (const kind of new Set(Object.values(assignment))) {
    let command: string | undefined;
    if (kind !== 'fake') {
      const found = locate(kind, deps, readMachineSettings(dir));
      if (!found) { deps.err(`${kind === 'codex' ? 'Codex' : 'Claude'} was not found. Run "agent-desk doctor" for details.\n`); return 1; }
      command = found.path;
    }
    instances.set(kind, deps.createRuntime(kind, command));
  }
  const runtimeMap = Object.fromEntries(Object.entries(assignment).map(([role, kind]) => [role, instances.get(kind)!])) as Partial<Record<RoleId, Runtime>>;

  fs.mkdirSync(dir, { recursive: true });
  const store = new RunStore(path.join(dir, 'agent-desk.db'));
  try {
    const recovered = store.recoverInterrupted();
    if (recovered.length) deps.err(`marked ${recovered.length} earlier run(s) as interrupted\n`);
    const runId = store.startRun(project, parsed.request);
    const record = store.recorder(runId);
    const previousBrief = store.latestBrief(project);
    const verify = parsed.verify.length ? parsed.verify : config.verify ?? [];
    const maxTokens = parsed.maxTokens ?? config.limits?.tokens;
    const maxMinutes = parsed.maxMinutes ?? config.limits?.minutes;
    const interactive = !parsed.unattended ? deps.ask : undefined;
    const started = Date.now();

    const result = await runRequest(parsed.request, {
      cwd: project,
      runtime: runtimeMap,
      ...(config.allowCommands ? { allowCommands: config.allowCommands } : {}),
      ...(interactive ? { askUser: interactive, confirmPlan: async (plan: Parameters<typeof planText>[0]) => (await interactive({ question: `Plan:\n${planText(plan)}\n\nStart building with this plan?`, options: ['proceed', 'stop'] })).trim().toLowerCase() !== 'stop' } : {}),
      onEvent: event => {
        record(event);
        if (!parsed.json) { const line = describeEvent(event); if (line) deps.err(`${line}\n`); }
      },
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(previousBrief ? { previousBrief } : {}),
      verify,
      restorePointDir: path.join(dir, 'restore', String(runId)),
      ...(config.ignore ? { ignore: config.ignore } : {}),
      ...(maxTokens || maxMinutes ? { budget: { ...(maxTokens ? { maxTokens } : {}), ...(maxMinutes ? { maxMillis: maxMinutes * 60000 } : {}) } } : {}),
      ...((parsed.review ?? config.review) ? { review: (parsed.review ?? config.review)! } : {}),
      ...(config.limits?.redo !== undefined ? { redoLimit: config.limits.redo } : {}),
    });
    store.finishRun(runId, parsed.request, result);
    pruneRestorePoints(path.join(dir, 'restore'), 10);
    if (parsed.json) deps.out(`${JSON.stringify(result, null, 2)}\n`);
    else deps.out(`${summarize(result, Date.now() - started)}\n`);
    if (result.restorePoint && (result.status === 'needs_review' || result.status === 'failed')) deps.err(`To undo this run's file changes: agent-desk revert ${runId}\n`);
    if (result.resume) deps.err(`resumable: ${JSON.stringify(result.resume)}\n`);
    return EXIT_CODES[result.status] ?? 1;
  } finally {
    store.close();
  }
}

/** Keeps only the newest `keep` restore points. Run ids grow, so the highest numbers are the newest. */
function pruneRestorePoints(root: string, keep: number): void {
  try {
    const ids = fs.readdirSync(root).filter(name => /^\d+$/.test(name)).map(Number).sort((a, b) => b - a);
    for (const id of ids.slice(keep)) fs.rmSync(path.join(root, String(id)), { recursive: true, force: true });
  } catch { /* nothing to prune */ }
}

async function revert(parsed: Parsed, deps: CliDeps): Promise<number> {
  const runId = Number(parsed.request);
  if (!Number.isInteger(runId) || runId < 1) { deps.err(`revert needs a run id\n\n${USAGE}\n`); return 64; }
  const dir = dataDirectory(deps.env, deps.platform);
  const dbFile = path.join(dir, 'agent-desk.db');
  if (!fs.existsSync(dbFile)) { deps.err('no runs recorded yet\n'); return 64; }
  const store = new RunStore(dbFile);
  try {
    const row = store.getRun(runId);
    if (!row) { deps.err(`run ${runId} not found\n`); return 64; }
    if (row.status === 'running') { deps.err(`run ${runId} is still running\n`); return 64; }
    const loaded = loadProjectConfig(row.project);
    const ignore = loaded.ok ? loaded.config.ignore : undefined;
    const point = path.join(dir, 'restore', String(runId));
    const plan = revertToRestorePoint(row.project, point, { ...(ignore ? { ignore } : {}), dryRun: true });
    if (!plan.ok) { deps.err(`${plan.error}\n(restore points are kept for the 10 newest runs, and only for runs that reached the build step)\n`); return 1; }
    const later = store.listRuns(row.project, 200).filter(other => other.id > runId);
    deps.out(`Run ${runId} in ${row.project}\n  restore: ${plan.restore.length} file(s)${plan.restore.length ? ` - ${plan.restore.join(', ')}` : ''}\n  remove:  ${plan.remove.length} file(s)${plan.remove.length ? ` - ${plan.remove.join(', ')}` : ''}\n`);
    if (later.length) deps.out(`  note: ${later.length} later run(s) in this project (${later.map(other => other.id).join(', ')}); their changes are undone too.\n`);
    if (!plan.restore.length && !plan.remove.length) { deps.out('Nothing to undo.\n'); return 0; }
    if (!parsed.yes) { deps.out(`Not applied. Re-run with --yes to apply: agent-desk revert ${runId} --yes\n`); return 0; }
    const done = revertToRestorePoint(row.project, point, { ...(ignore ? { ignore } : {}) });
    if (!done.ok) { deps.err(`revert failed: ${done.error}\n`); return 1; }
    deps.out('Reverted.\n');
    return 0;
  } finally {
    store.close();
  }
}

export function terminalAsk(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): (question: UserQuestion) => Promise<string> {
  return question => new Promise(resolve => {
    const rl = readline.createInterface({ input, output });
    const options = question.options?.length ? `\n${question.options.map((o, i) => `  ${i + 1}) ${o}`).join('\n')}\n(number or text)` : '';
    rl.question(`\n? ${question.question}${options}\n> `, answer => {
      rl.close();
      const index = Number(answer);
      resolve(question.options && Number.isInteger(index) && index >= 1 && index <= question.options.length ? question.options[index - 1]! : answer);
    });
  });
}
