// Starts one run the way every front end (CLI, server) needs it: load the
// project, pick runtimes, open the store, assemble the RunConfig, record
// events, finish the run, prune old restore points. Front ends only add how
// questions are answered and how output is shown.

import fs from 'node:fs';
import path from 'node:path';
import type { RoleId, Runtime, UserQuestion } from '#core';
import { planText, runRequest } from '#orchestrator';
import type { ReviewPolicy, RunConfig, RunEvent, RunResult } from '#orchestrator';
import { assignRuntimes, loadMemory, loadProject, newSuggestions, roleSettings, skillsByRole } from '#project';
import type { RuntimeKind } from '#project';
import { RunStore } from '#store';
import { locate } from './discover.ts';
import { startUsageGuard } from './usage-limits.ts';
import type { UsageGuard } from './usage-limits.ts';
import { dataDirectory, readMachineSettings } from './paths.ts';

export interface ExecuteOptions {
  project: string;
  request: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  createRuntime(kind: RuntimeKind, command?: string): Runtime;
  runtime?: RuntimeKind | undefined;
  verify?: string[];
  review?: ReviewPolicy | undefined;
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

export async function executeRun(options: ExecuteOptions): Promise<ExecuteOutcome> {
  const { project } = options;
  if (!options.request.trim()) return { ok: false, code: 64, message: 'the request is empty' };
  if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) return { ok: false, code: 64, message: `project folder not found: ${project}` };
  const loaded = loadProject(project);
  if (loaded.errors.length) return { ok: false, code: 64, message: loaded.errors.join('\n') };
  const config = loaded.config;
  for (const warning of loaded.warnings) options.onNote?.(`note: ${warning}`);
  const settings = roleSettings(loaded);
  const skills = skillsByRole(project, loaded, (id, reason) => options.onNote?.(`note: skill "${id}" is not used: ${reason}`));
  const dir = dataDirectory(options.env, options.platform);
  const assignment = assignRuntimes(config, options.runtime);
  const instances = new Map<RuntimeKind, Runtime>();
  for (const kind of new Set(Object.values(assignment))) {
    let command: string | undefined;
    if (kind !== 'fake') {
      const found = locate(kind, options.env, options.platform, readMachineSettings(dir));
      if (!found) return { ok: false, code: 1, message: `${kind === 'codex' ? 'Codex' : 'Claude'} was not found. Run "agent-desk doctor" for details.` };
      command = found.path;
    }
    instances.set(kind, options.createRuntime(kind, command));
  }
  const runtimeMap = Object.fromEntries(Object.entries(assignment).map(([role, kind]) => [role, instances.get(kind)!])) as Partial<Record<RoleId, Runtime>>;

  fs.mkdirSync(dir, { recursive: true });
  const store = new RunStore(path.join(dir, 'agent-desk.db'));
  try {
    const recovered = store.recoverInterrupted();
    if (recovered.length) options.onNote?.(`marked ${recovered.length} earlier run(s) as interrupted`);
    const runId = store.startRun(project, options.request);
    options.onStarted?.({ runId });
    const record = store.recorder(runId);
    const previousBrief = store.latestBrief(project);
    const verify = options.verify?.length ? options.verify : config.verify ?? [];
    const maxTokens = options.maxTokens ?? config.limits?.tokens;
    const maxMinutes = options.maxMinutes ?? config.limits?.minutes;
    const review = options.review ?? config.review;
    const ask = options.ask;
    const memory = loadMemory(project);
    const started = Date.now();

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
      ...(ask ? { askUser: ask, confirmPlan: async plan => (await ask({ question: `Plan:\n${planText(plan)}\n\nStart building with this plan?`, options: ['proceed', 'stop'] })).trim().toLowerCase() !== 'stop' } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(previousBrief ? { previousBrief } : {}),
      ...(config.ignore ? { ignore: config.ignore } : {}),
      ...(maxTokens || maxMinutes ? { budget: { ...(maxTokens ? { maxTokens } : {}), ...(maxMinutes ? { maxMillis: maxMinutes * 60000 } : {}) } } : {}),
      ...(review ? { review } : {}),
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
    pruneRestorePoints(path.join(dir, 'restore'), 10);
    return { ok: true, runId, result, suggestions: newSuggestions(project, result.memorySuggestions ?? []), durationMs: Date.now() - started, dataDir: dir };
  } finally {
    store.close();
  }
}
