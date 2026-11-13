// Deterministic gates. They run in code, never through a model, so a step's
// result is judged by what happened rather than by what was said.

import { spawn } from 'node:child_process';
import type { TokenUsage } from '#core';
import { matchesIgnore } from './snapshot.ts';
import type { Diff } from './snapshot.ts';

export type GateId = 'G1' | 'G2' | 'G3' | 'G4' | 'G5';

export interface GateResult {
  gate: GateId;
  ok: boolean;
  /** True when the gate had nothing to check (for example no verify commands). */
  skipped?: boolean;
  attempt: number;
  detail: string;
  problems: string[];
  data?: Record<string, unknown>;
}

const TEST_PATH = [/(^|\/)(tests?|__tests__|spec|specs)\//i, /\.(test|spec)\.[a-z0-9]+$/i, /(^|\/)(jest|vitest|playwright|karma|mocha)\.config\.[a-z]+$/i, /(^|\/)\.mocharc/i];

export const isTestPath = (rel: string): boolean => TEST_PATH.some(pattern => pattern.test(rel));

export function normalizeReportedPath(raw: string, cwd: string): string {
  let value = raw.trim().replaceAll('\\', '/');
  const root = cwd.replaceAll('\\', '/').replace(/\/+$/, '');
  if (value.toLowerCase().startsWith(`${root.toLowerCase()}/`)) value = value.slice(root.length + 1);
  return value.replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

/** G2: what the builder reported must equal what actually changed. */
export function checkChangeReport(input: { attempt: number; cwd: string; reported: readonly string[]; diff: Diff; ignore: readonly string[] }): GateResult {
  const reported = new Set(input.reported.map(file => normalizeReportedPath(file, input.cwd)).filter(file => file && !matchesIgnore(file, false, input.ignore)));
  const actual = new Set(input.diff.all);
  const unreported = [...actual].filter(file => !reported.has(file)).sort();
  const falseClaims = [...reported].filter(file => !actual.has(file)).sort();
  const problems: string[] = [];
  if (unreported.length) problems.push(`These files changed but were not in changedFiles: ${unreported.join(', ')}`);
  if (falseClaims.length) problems.push(`These files were listed in changedFiles but did not change: ${falseClaims.join(', ')}`);
  const testFilesChanged = [...actual].filter(isTestPath).sort();
  return {
    gate: 'G2', ok: problems.length === 0, attempt: input.attempt,
    detail: problems.length ? `report and real changes differ (${unreported.length} unreported, ${falseClaims.length} not changed)` : `${actual.size} changed file(s) match the report`,
    problems, data: { changed: [...actual].sort(), unreported, falseClaims, testFilesChanged },
  };
}

/** G2 for read-only steps: no file may change. */
export function checkNoChanges(input: { attempt: number; step: string; diff: Diff }): GateResult {
  const problems = input.diff.all.length ? [`The ${input.step} step is read-only but these files changed: ${input.diff.all.join(', ')}`] : [];
  return { gate: 'G2', ok: problems.length === 0, attempt: input.attempt, detail: problems.length ? `${input.diff.all.length} file(s) changed in a read-only step` : 'no files changed', problems, data: { changed: input.diff.all } };
}

export interface VerifyOutcome {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  /** The command could not be started or was not found: an environment problem, not a code problem. */
  unavailable: boolean;
}

const OUTPUT_LIMIT = 64 * 1024;
const TAIL_CHARS = 1500;

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<VerifyOutcome> {
  return new Promise(resolve => {
    let output = '';
    let timedOut = false;
    let settled = false;
    const done = (outcome: VerifyOutcome) => { if (!settled) { settled = true; clearTimeout(timer); resolve(outcome); } };
    const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (data: Buffer) => { output = (output + data.toString('utf8')).slice(-OUTPUT_LIMIT); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.once('error', error => { done({ command, exitCode: null, timedOut: false, output: error.message, unavailable: true }); });
    child.once('close', code => {
      const missing = code === 127 || /is not recognized as an internal or external command|command not found/i.test(output);
      done({ command, exitCode: timedOut ? null : code, timedOut, output, unavailable: missing && !timedOut });
    });
  });
}

/** G3: run the project's verify commands. All must exit 0. */
export async function runVerify(input: { attempt: number; cwd: string; commands: readonly string[]; timeoutMs: number }): Promise<{ result: GateResult; outcomes: VerifyOutcome[] }> {
  if (!input.commands.length) {
    return { result: { gate: 'G3', ok: true, skipped: true, attempt: input.attempt, detail: 'no verify commands configured', problems: [] }, outcomes: [] };
  }
  const outcomes: VerifyOutcome[] = [];
  const problems: string[] = [];
  for (const command of input.commands) {
    const outcome = await runCommand(command, input.cwd, input.timeoutMs);
    outcomes.push(outcome);
    if (outcome.exitCode === 0) continue;
    const tail = outcome.output.trim().slice(-TAIL_CHARS);
    const what = outcome.timedOut ? `timed out after ${input.timeoutMs} ms` : outcome.unavailable ? 'could not be run' : `exited with code ${String(outcome.exitCode)}`;
    problems.push(`Verify command \`${command}\` ${what}.${tail ? `\nOutput (last part):\n${tail}` : ''}`);
  }
  const unavailable = outcomes.some(outcome => outcome.unavailable);
  return {
    result: {
      gate: 'G3', ok: problems.length === 0, attempt: input.attempt,
      detail: problems.length ? `${problems.length} of ${input.commands.length} verify command(s) failed` : `${input.commands.length} verify command(s) passed`,
      problems, data: { commands: input.commands, exitCodes: outcomes.map(outcome => outcome.exitCode), unavailable },
    },
    outcomes,
  };
}

export interface Budget {
  /** Total tokens (sum of totalTokens, cached input included). */
  maxTokens?: number;
  maxMillis?: number;
}

/** G5: stays inside the token and time limits. */
export function checkBudget(input: { attempt: number; budget: Budget | undefined; usage: TokenUsage; elapsedMs: number }): GateResult {
  const { budget, usage, elapsedMs } = input;
  const problems: string[] = [];
  if (budget?.maxTokens !== undefined && usage.totalTokens > budget.maxTokens) problems.push(`Token budget exceeded: ${usage.totalTokens} used, limit ${budget.maxTokens}.`);
  if (budget?.maxMillis !== undefined && elapsedMs > budget.maxMillis) problems.push(`Time budget exceeded: ${Math.round(elapsedMs / 1000)} s used, limit ${Math.round(budget.maxMillis / 1000)} s.`);
  return {
    gate: 'G5', ok: problems.length === 0, skipped: !budget, attempt: input.attempt,
    detail: problems[0] ?? (budget ? 'within budget' : 'no budget configured'), problems,
    data: { totalTokens: usage.totalTokens, elapsedMs },
  };
}
