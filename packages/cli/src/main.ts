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
import { addMemory, assignRuntimes, checkSkills, loadMemory, memoryFacts, memoryPath, newSuggestions, draftFromInspection, inspectProject, loadProject, roleSettings, writeDraft } from '#project';
import type { LoadedProject, RuntimeKind } from '#project';
import { dataDirectory, executeRun, locate as locateExecutable, readMachineSettings, resolveClaudeExecutable, resolveCodexExecutable, versionWarning, writeMachineSettings } from '#service';
import type { Found } from '#service';
import { EXIT_CODES, describeEvent, summarize } from './format.ts';

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
  agent-desk init [--project <dir>] [--yes]  look at a project and draft .agent-desk/ settings (writes only with --yes, never overwrites)
  agent-desk skills check [--project <dir>]  check .agent-desk/skills/*/SKILL.md structure and descriptions
  agent-desk memory [add "<fact>"]          show project memory, or add a fact to .agent-desk/memory.md
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
  if (parsed.command === 'init') return init(parsed, project, deps);
  if (parsed.command === 'skills') return skills(parsed, project, deps);
  if (parsed.command === 'memory') return memory(parsed, project, deps);
  deps.err(`unknown command "${parsed.command}"\n\n${USAGE}\n`);
  return 64;
}

function locate(kind: 'codex' | 'claude', deps: CliDeps, saved: ReturnType<typeof readMachineSettings>): Found | null {
  return locateExecutable(kind, deps.env, deps.platform, saved);
}

async function doctor(parsed: Parsed, project: string, deps: CliDeps): Promise<number> {
  const checks: DoctorCheck[] = [];
  const dir = dataDirectory(deps.env, deps.platform);
  const saved = readMachineSettings(dir);
  const loaded = loadProject(project);
  const kinds = [...new Set(Object.values(assignRuntimes(loaded.config, parsed.runtime)))];

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

  checks.push(loaded.errors.length
    ? { name: 'project config', ok: false, detail: loaded.errors.join('; '), fix: `fix the files under ${path.join(project, '.agent-desk')}` }
    : { name: 'project config', ok: true, detail: loaded.configExists ? 'valid' : 'none (defaults)' });
  const inspection = inspectProject(project);
  if (inspection.instructionFilesDiffer) checks.push({ name: 'instruction files', ok: false, detail: 'AGENTS.md and CLAUDE.md differ, so Codex and Claude would follow different rules', fix: 'make them say the same (for example CLAUDE.md containing "@AGENTS.md")' });
  checks.push(loaded.missingRoles.length
    ? { name: 'role files', ok: false, detail: `missing: ${loaded.missingRoles.join(', ')} (built-in defaults are used)`, fix: 'run "agent-desk init" to create .agent-desk/agents/*.md' }
    : { name: 'role files', ok: true, detail: 'all 4 present' });
  if (!loaded.errors.length) {
    const verifyCount = loaded.config.verify?.length ?? 0;
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
  const interactive = !parsed.unattended ? deps.ask : undefined;
  const outcome = await executeRun({
    project,
    request: parsed.request,
    env: deps.env,
    platform: deps.platform,
    createRuntime: deps.createRuntime,
    runtime: parsed.runtime,
    verify: parsed.verify,
    review: parsed.review,
    maxTokens: parsed.maxTokens,
    maxMinutes: parsed.maxMinutes,
    ask: interactive,
    signal: deps.signal,
    onNote: text => deps.err(`${text}\n`),
    onEvent: event => { if (!parsed.json) { const line = describeEvent(event); if (line) deps.err(`${line}\n`); } },
  });
  if (!outcome.ok) { deps.err(`${outcome.message}\n`); return outcome.code; }
  const { result, runId, suggestions } = outcome;
  if (parsed.json) deps.out(`${JSON.stringify(result, null, 2)}\n`);
  else deps.out(`${summarize(result, outcome.durationMs)}\n`);
  if (suggestions.length && !parsed.json) {
    deps.out(`\nMemory suggestions (nothing was saved):\n${suggestions.map(fact => `  - ${fact}`).join('\n')}\n`);
    if (interactive) {
      for (const fact of suggestions) {
        const choice = await interactive({ question: `Add to project memory?\n  ${fact}`, options: ['add', 'skip'] });
        if (choice.trim().toLowerCase() === 'add') { const added = addMemory(project, fact); deps.out(added.ok ? 'Added.\n' : `Not added: ${added.error}\n`); }
      }
    } else deps.out('Add one with: agent-desk memory add "<fact>"\n');
  }
  if (result.restorePoint && (result.status === 'needs_review' || result.status === 'failed')) deps.err(`To undo this run's file changes: agent-desk revert ${runId}\n`);
  if (result.resume) deps.err(`resumable: ${JSON.stringify(result.resume)}\n`);
  return EXIT_CODES[result.status] ?? 1;
}

async function memory(parsed: Parsed, project: string, deps: CliDeps): Promise<number> {
  const [action, ...factWords] = parsed.request.split(/\s+/).filter(Boolean);
  if (!action) {
    const facts = memoryFacts(loadMemory(project));
    deps.out(facts.length ? `${memoryPath(project)}\n${facts.map(fact => `- ${fact}`).join('\n')}\n` : `No project memory yet (${memoryPath(project)}). Add a fact with: agent-desk memory add "<fact>"\n`);
    return 0;
  }
  if (action !== 'add') { deps.err('usage: agent-desk memory [add "<fact>"]\n'); return 64; }
  const added = addMemory(project, factWords.join(' '));
  if (!added.ok) { deps.err(`${added.error}\n`); return 1; }
  deps.out(`Added. Memory is now ${added.chars} characters.\n`);
  return 0;
}

async function skills(parsed: Parsed, project: string, deps: CliDeps): Promise<number> {
  if (parsed.request !== 'check') { deps.err(`usage: agent-desk skills check [--project <dir>]\n`); return 64; }
  const loaded = loadProject(project);
  if (loaded.errors.length) { deps.err(`${loaded.errors.join('\n')}\n`); return 64; }
  const report = checkSkills(project, loaded.config, loaded.roles);
  deps.out(`${report.skills.length} skill(s) in ${path.join(project, '.agent-desk', 'skills')}\n`);
  for (const finding of report.findings) deps.out(`${finding.level.toUpperCase().padEnd(5)} ${finding.skill}: ${finding.message}\n`);
  const errors = report.findings.filter(finding => finding.level === 'error').length;
  const warnings = report.findings.filter(finding => finding.level === 'warn').length;
  deps.out(errors || warnings ? `\n${errors} error(s), ${warnings} warning(s)\n` : report.skills.length ? '\nNo problems found.\n' : '\nNo skills yet. A skill is a folder .agent-desk/skills/<id>/ with a SKILL.md.\n');
  return errors ? 1 : 0;
}

async function init(parsed: Parsed, project: string, deps: CliDeps): Promise<number> {
  if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) { deps.err(`project folder not found: ${project}\n`); return 64; }
  const saved = readMachineSettings(dataDirectory(deps.env, deps.platform));
  const available = (['codex', 'claude'] as const).filter(kind => locate(kind, deps, saved) !== null);
  const inspection = inspectProject(project);
  const draft = draftFromInspection(inspection, available);
  deps.out(`Project: ${project}\nStack: ${inspection.stack.join(', ') || 'unknown'}\nTests: ${inspection.hasTests ? 'yes' : 'none found'}, CI: ${inspection.hasCi ? 'yes' : 'none found'}${inspection.gitCommits !== null ? `, commits: ${inspection.gitCommits}` : ''}\n`);
  for (const note of inspection.notes) deps.out(`Note: ${note}\n`);
  deps.out('\nDraft:\n');
  for (const line of draft.rationale) deps.out(`  - ${line}\n`);
  deps.out('\nFiles:\n');
  for (const file of draft.files) deps.out(`  ${file.willWrite ? 'create' : 'keep  '} ${file.path} (${file.reason})\n`);
  const config = draft.files.find(file => file.path === '.agent-desk/config.json');
  if (config?.willWrite) deps.out(`\n.agent-desk/config.json would contain:\n${config.content}`);
  if (!draft.files.some(file => file.willWrite)) { deps.out('\nNothing to create.\n'); return 0; }
  if (!parsed.yes) { deps.out('\nNot written. Review the draft, then run again with --yes to create the files.\n'); return 0; }
  const written = writeDraft(project, draft);
  deps.out(`\nCreated ${written.length} file(s): ${written.join(', ')}\n`);
  return 0;
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
    const ignore = loadProject(row.project).config.ignore;
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
