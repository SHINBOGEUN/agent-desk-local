// Deterministic gates. They run in code, never through a model, so a step's
// result is judged by what happened rather than by what was said.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

type Language = 'en' | 'ko' | undefined;
const pick = (language: Language, english: string, korean: string): string => (language === 'ko' ? korean : english);

export const isTestPath = (rel: string): boolean => TEST_PATH.some(pattern => pattern.test(rel));

export function normalizeReportedPath(raw: string, cwd: string): string {
  let value = raw.trim().replaceAll('\\', '/');
  const root = cwd.replaceAll('\\', '/').replace(/\/+$/, '');
  if (value.toLowerCase().startsWith(`${root.toLowerCase()}/`)) value = value.slice(root.length + 1);
  return value.replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

/** G2: what the builder reported must equal what actually changed. */
export function checkChangeReport(input: { attempt: number; cwd: string; reported: readonly string[]; diff: Diff; ignore: readonly string[]; language?: Language }): GateResult {
  const reported = new Set(input.reported.map(file => normalizeReportedPath(file, input.cwd)).filter(file => file && !matchesIgnore(file, false, input.ignore)));
  const actual = new Set(input.diff.all);
  const unreported = [...actual].filter(file => !reported.has(file)).sort();
  const falseClaims = [...reported].filter(file => !actual.has(file)).sort();
  const problems: string[] = [];
  if (unreported.length) problems.push(pick(input.language, `These files changed but were not in changedFiles: ${unreported.join(', ')}`, `다음 파일이 바뀌었지만 changedFiles에 없습니다: ${unreported.join(', ')}`));
  if (falseClaims.length) problems.push(pick(input.language, `These files were listed in changedFiles but did not change: ${falseClaims.join(', ')}`, `다음 파일은 changedFiles에 있지만 실제로는 바뀌지 않았습니다: ${falseClaims.join(', ')}`));
  // only tests that existed before can be weakened; a new test file is not a warning
  const testFilesChanged = [...input.diff.modified, ...input.diff.deleted].filter(isTestPath).sort();
  return {
    gate: 'G2', ok: problems.length === 0, attempt: input.attempt,
    detail: problems.length ? pick(input.language, `report and real changes differ (${unreported.length} unreported, ${falseClaims.length} not changed)`, `보고와 실제 변경이 다릅니다 (보고 누락 ${unreported.length}개, 변경 없음 ${falseClaims.length}개)`) : pick(input.language, `${actual.size} changed file(s) match the report`, `변경된 파일 ${actual.size}개가 보고와 일치합니다`),
    problems, data: { changed: [...actual].sort(), unreported, falseClaims, testFilesChanged },
  };
}

/** G2 for read-only steps: no file may change. */
export function checkNoChanges(input: { attempt: number; step: string; diff: Diff; language?: Language }): GateResult {
  const problems = input.diff.all.length ? [pick(input.language, `The ${input.step} step is read-only but these files changed: ${input.diff.all.join(', ')}`, `${input.step} 단계는 읽기 전용인데 다음 파일이 바뀌었습니다: ${input.diff.all.join(', ')}`)] : [];
  return { gate: 'G2', ok: problems.length === 0, attempt: input.attempt, detail: problems.length ? pick(input.language, `${input.diff.all.length} file(s) changed in a read-only step`, `읽기 전용 단계에서 파일 ${input.diff.all.length}개가 바뀌었습니다`) : pick(input.language, 'no files changed', '변경된 파일 없음'), problems, data: { changed: input.diff.all } };
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

/**
 * Verify commands to use when none are configured: the project's own `npm test`, when package.json has a real
 * test script (not npm's "no test specified" placeholder). Read after the build, so tests the builder just added count.
 */
export function detectVerify(cwd: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
    const real = (name: string): boolean => { const script = pkg.scripts?.[name]; return typeof script === 'string' && script.trim() !== '' && !/no test specified/i.test(script); };
    // npm test first; projects without one often keep their whole check under "check" or "verify" (tsc + tests).
    if (real('test')) return ['npm test'];
    for (const name of ['check', 'verify']) if (real(name)) return [`npm run ${name}`];
    return [];
  } catch {
    return [];
  }
}

/** G3: run the project's verify commands. All must exit 0. */
export async function runVerify(input: { attempt: number; cwd: string; commands: readonly string[]; timeoutMs: number; language?: Language }): Promise<{ result: GateResult; outcomes: VerifyOutcome[] }> {
  if (!input.commands.length) {
    return { result: { gate: 'G3', ok: true, skipped: true, attempt: input.attempt, detail: pick(input.language, 'no verify commands configured', '검증 명령이 설정되어 있지 않음'), problems: [] }, outcomes: [] };
  }
  const outcomes: VerifyOutcome[] = [];
  const problems: string[] = [];
  for (const command of input.commands) {
    const outcome = await runCommand(command, input.cwd, input.timeoutMs);
    outcomes.push(outcome);
    if (outcome.exitCode === 0) continue;
    const tail = outcome.output.trim().slice(-TAIL_CHARS);
    const what = outcome.timedOut ? pick(input.language, `timed out after ${input.timeoutMs} ms`, `${input.timeoutMs}ms 후 시간 초과`) : outcome.unavailable ? pick(input.language, 'could not be run', '실행할 수 없음') : pick(input.language, `exited with code ${String(outcome.exitCode)}`, `종료 코드 ${String(outcome.exitCode)}로 끝남`);
    problems.push(pick(input.language, `Verify command \`${command}\` ${what}.${tail ? `\nOutput (last part):\n${tail}` : ''}`, `검증 명령 \`${command}\`: ${what}.${tail ? `\n출력(끝부분):\n${tail}` : ''}`));
  }
  const unavailable = outcomes.some(outcome => outcome.unavailable);
  return {
    result: {
      gate: 'G3', ok: problems.length === 0, attempt: input.attempt,
      detail: problems.length ? pick(input.language, `${problems.length} of ${input.commands.length} verify command(s) failed`, `검증 명령 ${input.commands.length}개 중 ${problems.length}개 실패`) : pick(input.language, `${input.commands.length} verify command(s) passed`, `검증 명령 ${input.commands.length}개 통과`),
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
export function checkBudget(input: { attempt: number; budget: Budget | undefined; usage: TokenUsage; elapsedMs: number; language?: Language }): GateResult {
  const { budget, usage, elapsedMs } = input;
  const problems: string[] = [];
  if (budget?.maxTokens !== undefined && usage.totalTokens > budget.maxTokens) problems.push(pick(input.language, `Token budget exceeded: ${usage.totalTokens} used, limit ${budget.maxTokens}.`, `토큰 예산을 넘었습니다: ${usage.totalTokens} 사용, 한도 ${budget.maxTokens}.`));
  if (budget?.maxMillis !== undefined && elapsedMs > budget.maxMillis) problems.push(pick(input.language, `Time budget exceeded: ${Math.round(elapsedMs / 1000)} s used, limit ${Math.round(budget.maxMillis / 1000)} s.`, `시간 예산을 넘었습니다: ${Math.round(elapsedMs / 1000)}초 사용, 한도 ${Math.round(budget.maxMillis / 1000)}초.`));
  return {
    gate: 'G5', ok: problems.length === 0, skipped: !budget, attempt: input.attempt,
    detail: problems[0] ?? (budget ? pick(input.language, 'within budget', '예산 안') : pick(input.language, 'no budget configured', '예산이 설정되어 있지 않음')), problems,
    data: { totalTokens: usage.totalTokens, elapsedMs },
  };
}
