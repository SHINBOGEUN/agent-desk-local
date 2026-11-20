// Starts one run the way every front end (CLI, server) needs it: load the
// project, pick runtimes, open the store, assemble the RunConfig, record
// events, finish the run, prune old restore points. Front ends only add how
// questions are answered and how output is shown.

import fs from 'node:fs';
import path from 'node:path';
import type { RoleId, Runtime, UserQuestion } from '#core';
import { planText, projectHistory, runRequest } from '#orchestrator';
import { historyLookup } from './history.ts';
import type { ReviewPolicy, RunConfig, RunEvent, RunResult } from '#orchestrator';
import { initVault, syncApprovals, vaultRoot, loadMemory, planRuntimes, withoutReviewRuntime, loadProject, newSuggestions, roleSettings, skillsByRole } from '#project';
import { findRunNote, notesLookup, noteTextOf, vaultIndexText, writeRunNotes } from './vault-notes.ts';
import type { RuntimeKind, RuntimeMode } from '#project';
import { RunStore } from '#store';
import { locate } from './discover.ts';
import { normalizeRateLimits, startUsageGuard } from './usage-limits.ts';
import type { UsageGuard } from './usage-limits.ts';
import { dataDirectory, readMachineSettings } from './paths.ts';

export interface ExecuteOptions {
  project: string;
  request: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  createRuntime(kind: RuntimeKind, command?: string): Runtime;
  runtime?: RuntimeKind | undefined;
  /** Builder/reviewer runtimes ("codex+claude" ...); --runtime wins over it. */
  mode?: RuntimeMode | undefined;
  verify?: string[];
  /** Image files the user attached (absolute paths). */
  images?: string[] | undefined;
  /** Continue run N: its brief and unfinished requirements are handed to the new run. */
  resumeOf?: number | undefined;
  /** Run without skills (for the skill on/off comparison, roadmap 6-4). */
  noSkills?: boolean | undefined;
  review?: ReviewPolicy | undefined;
  /** Language for answers and harness messages; default: config.language, then English. */
  language?: 'en' | 'ko' | undefined;
  maxTokens?: number | undefined;
  maxMinutes?: number | undefined;
  /** Stop when the 5-hour Codex limit grows by this many percentage points during the run (default: config.limits.codexUsagePercent). */
  maxUsagePercent?: number | undefined;
  /** Test hook: replaces reading `account/rateLimits/read` from the Codex runtime. */
  readRateLimits?: () => Promise<unknown>;
  pollUsageMs?: number;
  /** Answers agent questions and confirms plans. Omitted: unattended, a question ends the run as needs_user. */
  ask?: ((question: UserQuestion) => Promise<string>) | undefined;
  onEvent?: (event: RunEvent) => void;
  /** Called once the run has an id, before the first step. */
  onStarted?: (info: { runId: number }) => void;
  /** Messages for the user that are not part of the result (warnings, recovered runs). */
  onNote?: (text: string) => void;
  signal?: AbortSignal | undefined;
}

export type ExecuteOutcome =
  | { ok: false; code: 64 | 1; message: string }
  | { ok: true; runId: number; result: RunResult; suggestions: string[]; durationMs: number; dataDir: string };

/** Keeps only the newest `keep` restore points. Run ids grow, so the highest numbers are the newest. */
export function pruneRestorePoints(root: string, keep: number): void {
  try {
    const ids = fs.readdirSync(root).filter(name => /^\d+$/.test(name)).map(Number).sort((a, b) => b - a);
    for (const id of ids.slice(keep)) fs.rmSync(path.join(root, String(id)), { recursive: true, force: true });
  } catch { /* nothing to prune */ }
}

/** Default for config.limits.switchAtCodexPercent: switch to Claude when Codex's 5-hour window is this full. 0 turns it off. */
export const DEFAULT_SWITCH_AT_PERCENT = 95;

/** What a resumed run is told about the run it continues: where it stopped and what is left. */
export function resumeBrief(run: { id: number; status: string; reason: string | null; brief: string | null }, report: Record<string, unknown> | null): string {
  const requirements = (report?.requirements as { id: string; text: string }[] | undefined) ?? [];
  const builder = report?.builder as { requirements?: { id: string; status: string }[] } | undefined;
  const done = new Set((builder?.requirements ?? []).filter(entry => entry.status === 'done').map(entry => entry.id));
  const left = requirements.filter(requirement => !done.has(requirement.id));
  const resume = report?.resume as { step?: string; note?: string } | undefined;
  return [
    `This run continues run ${run.id}, which ended as ${run.status}${run.reason ? `: ${run.reason}` : ''}.`,
    resume?.step ? `It stopped at the ${resume.step} step.${resume.note ? ` ${resume.note}` : ''}` : '',
    left.length ? `Requirements not finished yet:\n${left.map(requirement => `- ${requirement.id}: ${requirement.text}`).join('\n')}` : '',
    'Files it already changed are still in the project; check them before redoing work.',
    run.brief ? `Its summary:\n${run.brief}` : '',
  ].filter(Boolean).join('\n');
}

export async function executeRun(options: ExecuteOptions): Promise<ExecuteOutcome> {
  const { project } = options;
  if (!options.request.trim()) return { ok: false, code: 64, message: 'the request is empty' };
  if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) return { ok: false, code: 64, message: `project folder not found: ${project}` };
  const loaded = loadProject(project);
  if (loaded.errors.length) return { ok: false, code: 64, message: loaded.errors.join('\n') };
  const config = loaded.config;
  for (const warning of loaded.warnings) options.onNote?.(`note: ${warning}`);
  const skills = options.noSkills ? {} : skillsByRole(project, loaded, (id, reason) => options.onNote?.(`note: skill "${id}" is not used: ${reason}`));
  const notes: string[] = [];
  const note = (text: string): void => { notes.push(text); options.onNote?.(`note: ${text}`); };
  const dir = dataDirectory(options.env, options.platform);
  let plan = planRuntimes(config, { override: options.runtime, mode: options.mode });
  if (plan.reviewIsDefault && plan.review !== 'fake' && !locate(plan.review, options.env, options.platform, readMachineSettings(dir))) {
    note(`${plan.review === 'claude' ? 'Claude' : 'Codex'} is not installed, so ${plan.primary === 'codex' ? 'Codex' : 'Claude'} also reviews. Set "mode" in .agent-desk/config.json to choose explicitly.`);
    plan = withoutReviewRuntime(plan);
  }
  let assignment = plan.assignment;
  const instances = new Map<RuntimeKind, Runtime>();
  const instance = (kind: RuntimeKind): Runtime | string => {
    const existing = instances.get(kind);
    if (existing) return existing;
    let command: string | undefined;
    if (kind !== 'fake') {
      const found = locate(kind, options.env, options.platform, readMachineSettings(dir));
      if (!found) return `${kind === 'codex' ? 'Codex' : 'Claude'} was not found. Run "agent-desk doctor" for details.`;
      command = found.path;
    }
    const created = options.createRuntime(kind, command);
    instances.set(kind, created);
    return created;
  };
  for (const kind of new Set(Object.values(assignment))) {
    const made = instance(kind);
    if (typeof made === 'string') return { ok: false, code: 1, message: made };
  }
  // Runtime fallback: when the team was not forced (--runtime / --mode / dashboard choice) and Codex's
  // 5-hour or weekly window is nearly used up, Claude takes over Codex's roles for this run.
  let fallback: string | null = null;
  const switchAt = config.limits?.switchAtCodexPercent ?? DEFAULT_SWITCH_AT_PERCENT;
  if (!options.runtime && !options.mode && switchAt > 0 && Object.values(assignment).includes('codex') && locate('claude', options.env, options.platform, readMachineSettings(dir))) {
    const codexRuntime = instances.get('codex') as (Runtime & { readRateLimits?: () => Promise<unknown> }) | undefined;
    const read = options.readRateLimits ?? (codexRuntime?.readRateLimits ? () => codexRuntime.readRateLimits!() : undefined);
    if (read) {
      try {
        // Either window counts: an empty weekly window stops Codex as surely as the 5-hour one.
        const window = normalizeRateLimits(await read()).windows.filter(entry => entry.usedPercent >= switchAt).sort((a, b) => b.usedPercent - a.usedPercent)[0];
        if (window) {
          const made = instance('claude');
          if (typeof made !== 'string') {
            assignment = Object.fromEntries(Object.entries(assignment).map(([role, kind]) => [role, kind === 'codex' ? 'claude' : kind])) as typeof assignment;
            fallback = `Codex ${window.kind === 'primary' ? '5-hour' : 'weekly'} usage is ${Math.round(window.usedPercent)}% (switch at ${switchAt}%), so Claude does Codex's roles in this run.`;
            note(fallback);
          }
        }
      } catch { /* usage unreadable: keep the planned team */ }
    }
  }
  const settings = roleSettings(loaded, assignment);
  const runtimeMap = Object.fromEntries(Object.entries(assignment).map(([role, kind]) => [role, instances.get(kind)!])) as Partial<Record<RoleId, Runtime>>;

  fs.mkdirSync(dir, { recursive: true });
  const store = new RunStore(path.join(dir, 'agent-desk.db'));
  try {
    const recovered = store.recoverInterrupted();
    if (recovered.length) options.onNote?.(`marked ${recovered.length} earlier run(s) as interrupted`);
    const resumed = options.resumeOf ? store.getRun(options.resumeOf) : null;
    if (options.resumeOf && !resumed) return { ok: false, code: 64, message: `run ${options.resumeOf} not found` };
    const runId = store.startRun(project, options.request);
    options.onStarted?.({ runId });
    const record = store.recorder(runId);
    // Resuming passes what the stopped run left; otherwise the project's history (latest briefs, older runs one line each).
    const previousBrief = resumed ? resumeBrief(resumed, store.getReport(resumed.id)) : null;
    const history = projectHistory(store.recentBriefs(project).filter(run => run.id !== runId));
    const verify = options.verify?.length ? options.verify : config.verify ?? [];
    const maxTokens = options.maxTokens ?? config.limits?.tokens;
    const maxMinutes = options.maxMinutes ?? config.limits?.minutes;
    const review = options.review ?? config.review;
    const language = options.language ?? config.language;
    const ask = options.ask;
    // The notes vault: approvals the user made in Obsidian reach memory.md before this run reads it.
    const vault = vaultRoot(project, config.vault);
    let vaultReady = true;
    try {
      initVault(vault);
      const synced = syncApprovals(project, vault);
      if (synced.approved.length) options.onNote?.(`added to memory from approved notes: ${synced.approved.join('; ')}`);
      for (const problem of synced.errors) options.onNote?.(`notes: ${problem}`);
    } catch (error) {
      vaultReady = false;
      options.onNote?.(`notes folder unavailable (${vault}): ${error instanceof Error ? error.message : String(error)}`);
    }
    // A vault inside the project is the user's (edited in Obsidian at any time): not a change of this run, not protected.
    const vaultRel = path.relative(project, vault).split(path.sep).join('/');
    const vaultInside = vaultRel !== '' && !vaultRel.startsWith('..') && !path.isAbsolute(vaultRel);
    const ignore = [...(config.ignore ?? []), ...(vaultInside ? [vaultRel] : [])];
    const memory = loadMemory(project);
    const vaultIndex = vaultReady ? vaultIndexText(vault) : '';
    const started = Date.now();
    store.setSettings(runId, {
      mode: options.mode ?? config.mode ?? (config.runtimes ? null : 'default'),
      runtimes: assignment, ...(fallback ? { fallback } : {}),
      review: review ?? 'always', language: language ?? 'en', verify,
      skills: Object.fromEntries(Object.entries(skills).map(([role, list]) => [role, (list ?? []).map(skill => skill.id)])), ...(options.noSkills ? { noSkills: true } : {}),
      models: settings.models, effort: settings.effort, roleFiles: loaded.missingRoles.length ? `missing: ${loaded.missingRoles.join(', ')}` : 'all',
      limits: { tokens: maxTokens ?? null, minutes: maxMinutes ?? null, redo: config.limits?.redo ?? null, codexUsagePercent: options.maxUsagePercent ?? config.limits?.codexUsagePercent ?? null },
      images: options.images?.length ?? 0, ...(resumed ? { resumeOf: resumed.id } : {}), notes,
    });

    const runConfig: RunConfig = {
      cwd: project,
      runtime: runtimeMap,
      access: settings.access,
      effort: settings.effort,
      models: settings.models,
      roleNotes: settings.roleNotes,
      skills,
      verify,
      restorePointDir: path.join(dir, 'restore', String(runId)),
      onEvent: event => { record(event); options.onEvent?.(event); },
      ...(config.allowCommands ? { allowCommands: config.allowCommands } : {}),
      ...(memory ? { projectMemory: memory } : {}),
      ...(history ? { projectHistory: history } : {}),
      readHistory: query => historyLookup(store, project, query),
      ...(vaultReady ? { readNotes: query => notesLookup(vault, query), noteText: (rel: string) => noteTextOf(vault, rel) } : {}),
      ...(vaultIndex ? { vaultIndex } : {}),
      ...(ask ? { askUser: ask, confirmPlan: async plan => !['stop', '중지'].includes((await ask(language === 'ko' ? { question: `계획:\n${planText(plan, 'ko')}\n\n이 계획으로 구현을 시작할까요?`, options: ['진행', '중지'] } : { question: `Plan:\n${planText(plan)}\n\nStart building with this plan?`, options: ['proceed', 'stop'] })).trim().toLowerCase()) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(previousBrief ? { previousBrief } : {}),
      ...(ignore.length ? { ignore } : {}),
      ...(maxTokens || maxMinutes ? { budget: { ...(maxTokens ? { maxTokens } : {}), ...(maxMinutes ? { maxMillis: maxMinutes * 60000 } : {}) } } : {}),
      ...(review ? { review } : {}),
      ...(language ? { language } : {}),
      ...(options.images?.length ? { images: options.images } : {}),
      ...(config.limits?.redo !== undefined ? { redoLimit: config.limits.redo } : {}),
    };
    const usageLimit = options.maxUsagePercent ?? config.limits?.codexUsagePercent;
    const codex = instances.get('codex') as (Runtime & { readRateLimits?: () => Promise<unknown> }) | undefined;
    const reader = options.readRateLimits ?? (codex?.readRateLimits ? () => codex.readRateLimits!() : undefined);
    let guard: UsageGuard | undefined;
    let usageStop: string | null = null;
    if (usageLimit && reader) {
      const usageController = new AbortController();
      runConfig.signal = runConfig.signal ? AbortSignal.any([runConfig.signal, usageController.signal]) : usageController.signal;
      guard = await startUsageGuard({ read: reader, limitPercent: usageLimit, ...(options.pollUsageMs ? { intervalMs: options.pollUsageMs } : {}), onTrip: reason => { usageStop = reason; usageController.abort(); } });
    } else if (usageLimit) options.onNote?.('note: limits.codexUsagePercent is set but no Codex runtime is in use, so it is ignored');
    let result: RunResult;
    try {
      result = await runRequest(options.request, runConfig);
    } catch (error) {
      // runRequest turns errors into a failed result; this only guards against a bug leaving the run "running".
      const message = error instanceof Error ? error.message : String(error);
      result = { status: 'failed', reason: message, requirements: [], gates: [], redo: 0, warnings: [], unverified: [], usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 }, usageEntries: [], events: [] };
    }
    guard?.stop();
    if (usageStop) result = { ...result, status: 'interrupted', reason: usageStop };
    store.finishRun(runId, options.request, result);
    if (vaultReady) {
      const notes = writeRunNotes(project, vault, { id: runId, request: options.request, result, lang: language === 'ko' ? 'ko' : 'en', resumedNote: resumed ? findRunNote(vault, resumed.id) : null });
      if (notes.error) options.onNote?.(`run note not written: ${notes.error}`);
    }
    pruneRestorePoints(path.join(dir, 'restore'), 10);
    return { ok: true, runId, result, suggestions: newSuggestions(project, result.memorySuggestions ?? []), durationMs: Date.now() - started, dataDir: dir };
  } finally {
    store.close();
  }
}

export interface DryRunReport {
  project: string;
  mode: string;
  runtimes: Record<string, string>;
  installed: { codex: boolean; claude: boolean };
  review: string;
  language: string;
  verify: string[];
  skills: Record<string, { id: string; description: string }[]>;
  models: Record<string, string>;
  roleFiles: string;
  memoryChars: number;
  problems: string[];
  notes: string[];
}

/**
 * `run --dry-run`: everything a run would start with, without opening a model
 * session, so a new project's setup can be checked for free (book: dry-run test
 * for broken links and wrong order before the real thing).
 */
export function dryRun(options: Pick<ExecuteOptions, 'project' | 'env' | 'platform' | 'runtime' | 'mode' | 'review' | 'language' | 'verify' | 'noSkills'>): DryRunReport {
  const loaded = loadProject(options.project);
  const config = loaded.config;
  const problems = [...loaded.errors];
  const notes = [...loaded.warnings];
  const dir = dataDirectory(options.env, options.platform);
  const saved = readMachineSettings(dir);
  const installed = { codex: !!locate('codex', options.env, options.platform, saved), claude: !!locate('claude', options.env, options.platform, saved) };
  let plan = planRuntimes(config, { override: options.runtime, mode: options.mode });
  if (plan.reviewIsDefault && plan.review !== 'fake' && !installed[plan.review]) { notes.push(`${plan.review} is not installed, so ${plan.primary} also reviews.`); plan = withoutReviewRuntime(plan); }
  for (const kind of new Set(Object.values(plan.assignment))) if (kind !== 'fake' && !installed[kind]) problems.push(`${kind} is needed by this team but was not found (run "agent-desk doctor").`);
  const skills = options.noSkills ? {} : skillsByRole(options.project, loaded, (id, reason) => problems.push(`skill "${id}" would be left out: ${reason}`));
  const verify = options.verify?.length ? options.verify : config.verify ?? [];
  if (!verify.length) notes.push('No verify commands: builds will end as needs_review.');
  const settings = roleSettings(loaded, plan.assignment);
  return {
    project: options.project,
    mode: options.mode ?? config.mode ?? (config.runtimes ? 'runtimes (custom)' : 'codex+claude (default)'),
    runtimes: plan.assignment,
    installed,
    review: options.review ?? config.review ?? 'always',
    language: options.language ?? config.language ?? 'en',
    verify,
    skills: Object.fromEntries(Object.entries(skills).map(([role, list]) => [role, (list ?? []).map(skill => ({ id: skill.id, description: skill.description }))])),
    models: settings.models as Record<string, string>,
    roleFiles: loaded.missingRoles.length ? `missing ${loaded.missingRoles.join(', ')} (built-in defaults)` : 'all 4 present',
    memoryChars: loadMemory(options.project).length,
    problems,
    notes,
  };
}
