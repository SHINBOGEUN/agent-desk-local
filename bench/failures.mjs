#!/usr/bin/env node
// Failure analysis report (roadmap 6-5, the book's improvement loop): every run
// that did not succeed, or claimed success wrongly, is sorted into the place
// that should change:
//   skill         the result's quality was wrong (hidden tests failed although the run said done)
//   role file     a role did something outside its job (answer task changed files, missing answer, review passed wrong work)
//   workflow      the order or routing was wrong (wrong workflow, stuck on a question, REDO limit)
//   environment   not the team's fault (timeouts, missing tools, usage limits)
// The rules are simple on purpose; read the run before acting on a line.
//
//   node bench/failures.mjs --label v2-mixed [--label ...] [--md bench/results/failures.md]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchDirectory } from './lib/evaluate.mjs';
import { loadResults } from './report.mjs';

export const FIX_PLACE = { skill: '스킬 (결과물 품질)', role: '역할 파일 (역할 혼동)', workflow: '워크플로 (순서·분기)', environment: '환경 (팀 책임 아님)' };

/** One cause per run, or null when the run succeeded honestly. */
export function classifyRun(result) {
  const metrics = result.metrics ?? {};
  const grade = result.grade ?? {};
  if (grade.success && !result.falseCompletion) {
    if (metrics.workflow && result.expectedWorkflows && !result.expectedWorkflows.includes(metrics.workflow)) return { cause: 'workflow', why: `succeeded, but lead chose "${metrics.workflow}" (expected ${result.expectedWorkflows.join(' or ')})` };
    return null;
  }
  const end = String(metrics.endReason ?? result.cancelReason ?? '');
  if (/timeout|environment|usage|limit|blocked_on_approval|server_restarted/.test(end)) return { cause: 'environment', why: `ended by ${end}` };
  if (grade.unexpectedChanges?.length) return { cause: 'role', why: `a read-only task changed files: ${grade.unexpectedChanges.join(', ')}` };
  if (grade.missing?.length) return { cause: 'role', why: `the answer did not contain: ${grade.missing.join(', ')}` };
  if (result.falseVerifierPass) return { cause: 'role', why: 'the reviewer passed work that fails the hidden tests' };
  const skillMiss = Array.isArray(result.expectedSkills) && Array.isArray(metrics.skillsRead) ? [...result.expectedSkills.filter(id => !metrics.skillsRead.includes(id)).map(id => `missed ${id}`), ...metrics.skillsRead.filter(id => !result.expectedSkills.includes(id)).map(id => `read ${id} without need`)] : [];
  if (skillMiss.length && !grade.success) return { cause: 'skill', why: `skill trigger: ${skillMiss.join(', ')}` };
  if (metrics.workflow && result.expectedWorkflows && !result.expectedWorkflows.includes(metrics.workflow)) return { cause: 'workflow', why: `lead chose "${metrics.workflow}" (expected ${result.expectedWorkflows.join(' or ')})` };
  if (metrics.status === 'needs_user') return { cause: 'workflow', why: 'stopped to ask the user in an unattended run' };
  if (metrics.status === 'needs_review' && (metrics.redo ?? 0) >= 2) return { cause: 'workflow', why: 'REDO limit reached without passing the gates' };
  if (grade.visible && !grade.visible.pass) return { cause: 'skill', why: 'the project\'s own tests fail after the change' };
  if (grade.acceptance && !grade.acceptance.pass) return { cause: 'skill', why: result.claimedSuccess ? 'reported done, but the hidden acceptance test fails' : 'the hidden acceptance test fails' };
  return { cause: 'workflow', why: `ended as ${metrics.status ?? 'unknown'} without a clearer cause` };
}

export function failureReport(sets) {
  const lines = ['# 실패 분석 보고서', '', '실패하거나 거짓으로 완료를 보고한 실행을 "고칠 곳"별로 나눴습니다. 규칙은 단순하므로 조치 전에 해당 실행을 직접 확인하세요.', ''];
  for (const { label, results } of sets) {
    const rows = results.map(result => ({ result, verdict: classifyRun(result) })).filter(row => row.verdict);
    lines.push(`## ${label}`, '', `실행 ${results.length}개 중 확인할 것 ${rows.length}개`, '');
    if (!rows.length) { lines.push('문제가 된 실행이 없습니다.', ''); continue; }
    const counts = Object.fromEntries(Object.keys(FIX_PLACE).map(key => [key, rows.filter(row => row.verdict.cause === key).length]));
    lines.push('| 고칠 곳 | 건수 |', '|---|---|', ...Object.entries(FIX_PLACE).map(([key, name]) => `| ${name} | ${counts[key]} |`), '');
    lines.push('| 과제 | 회차 | 고칠 곳 | 근거 |', '|---|---|---|---|');
    for (const { result, verdict } of rows) lines.push(`| ${result.taskId} | r${result.attempt} | ${FIX_PLACE[verdict.cause]} | ${verdict.why.replace(/\|/g, '\\|')} |`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export function main(argv = process.argv.slice(2)) {
  const labels = [];
  let mdFile = path.join(benchDirectory, 'results', 'failures.md');
  let resultsDir = path.join(benchDirectory, 'results', 'runs');
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--label') labels.push(argv[++index]);
    else if (argv[index] === '--md') mdFile = path.resolve(argv[++index]);
    else if (argv[index] === '--results-dir') resultsDir = path.resolve(argv[++index]);
    else labels.push(argv[index]);
  }
  const markdown = failureReport(loadResults(resultsDir, labels));
  fs.mkdirSync(path.dirname(mdFile), { recursive: true });
  fs.writeFileSync(mdFile, markdown);
  process.stdout.write(markdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
