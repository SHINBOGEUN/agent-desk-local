#!/usr/bin/env node
// Summarizes benchmark results for one or more labels and compares them.
//
//   node bench/report.mjs [label ...] [--results-dir <dir>] [--md <out.md>]
//
// With no labels, every label under bench/results/runs is included. The first
// label is treated as the baseline when computing changes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchDirectory } from './lib/evaluate.mjs';

const mean = values => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const rate = (part, whole) => (whole ? part / whole : null);
const fmtPct = value => (value == null ? '-' : `${(value * 100).toFixed(0)}%`);
const fmtK = value => (value == null ? '-' : `${Math.round(value / 1000).toLocaleString('en-US')}k`);
const fmtNum = (value, digits = 1) => (value == null ? '-' : value.toFixed(digits));

export function loadResults(resultsDir, labels) {
  const available = fs.existsSync(resultsDir) ? fs.readdirSync(resultsDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort() : [];
  const chosen = labels.length ? labels : available;
  return chosen.map(label => {
    const directory = path.join(resultsDir, label);
    if (!fs.existsSync(directory)) throw new Error(`no results for label "${label}" in ${resultsDir}`);
    const files = fs.readdirSync(directory).filter(name => /^T\d+.*-r\d+\.json$/.test(name));
    const results = files.map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
    const configFile = path.join(directory, '_config.json');
    const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : null;
    return { label, config, results };
  });
}

export function summarize({ label, config, results }) {
  const valid = results.filter(result => !['blocked_on_approval', 'server_restarted'].includes(result.cancelReason)); // harness or environment failures, not the team's result
  const claimed = valid.filter(result => result.claimedSuccess);
  const tokens = valid.map(result => result.metrics.usage.totalTokens);
  const successful = valid.filter(result => result.grade.success);
  return {
    label,
    enabledAgents: config ? config.agents.filter(agent => agent.enabled).length : null,
    runs: valid.length,
    excluded: results.length - valid.length,
    successRate: rate(successful.length, valid.length),
    claimedRate: rate(claimed.length, valid.length),
    falseCompletionRate: rate(claimed.filter(result => !result.grade.success).length, claimed.length),
    falseCompletions: valid.filter(result => result.falseCompletion).length,
    falseVerifierPasses: valid.filter(result => result.falseVerifierPass).length,
    meanTokens: mean(tokens),
    medianTokens: median(tokens),
    tokensPerSuccess: successful.length ? tokens.reduce((a, b) => a + b, 0) / successful.length : null,
    meanUncachedInput: mean(valid.map(result => result.metrics.usage.uncachedInputTokens)),
    meanOutput: mean(valid.map(result => result.metrics.usage.outputTokens)),
    meanAccountPercent: mean(valid.filter(result => result.metrics.accountPercent != null).map(result => result.metrics.accountPercent)),
    meanAgents: mean(valid.map(result => result.metrics.agentCount)),
    meanWorkTasks: mean(valid.map(result => result.metrics.workTasks)),
    meanConsultations: mean(valid.map(result => result.metrics.consultations)),
    meanDurationMin: mean(valid.filter(result => result.metrics.durationSec != null).map(result => result.metrics.durationSec / 60)),
    perTask: Object.fromEntries([...new Set(valid.map(result => result.taskId))].sort().map(taskId => {
      const group = valid.filter(result => result.taskId === taskId);
      return [taskId, { runs: group.length, success: group.filter(result => result.grade.success).length, meanTokens: mean(group.map(result => result.metrics.usage.totalTokens)), meanAgents: mean(group.map(result => result.metrics.agentCount)), falseCompletions: group.filter(result => result.falseCompletion).length }];
    })),
  };
}

const change = (before, after) => (before && after != null ? `${after >= before ? '+' : ''}${(((after - before) / before) * 100).toFixed(0)}%` : '-');

export function toMarkdown(summaries) {
  const lines = ['# Agent Desk 벤치마크 결과', ''];
  const rows = [
    ['활성 에이전트 수', s => (s.enabledAgents ?? '-')],
    ['실행 수 (제외)', s => `${s.runs}${s.excluded ? ` (${s.excluded})` : ''}`],
    ['실제 성공률 (숨은 테스트 통과)', s => fmtPct(s.successRate)],
    ['완료 보고 비율', s => fmtPct(s.claimedRate)],
    ['거짓 완료 비율 (완료 보고 중 실제 실패)', s => fmtPct(s.falseCompletionRate)],
    ['체커 PASS인데 실제 실패', s => s.falseVerifierPasses],
    ['평균 토큰', s => fmtK(s.meanTokens)],
    ['토큰 중앙값', s => fmtK(s.medianTokens)],
    ['성공 1건당 토큰', s => fmtK(s.tokensPerSuccess)],
    ['평균 캐시 미적용 입력', s => fmtK(s.meanUncachedInput)],
    ['평균 출력 토큰', s => fmtK(s.meanOutput)],
    ['평균 5시간 한도 사용률', s => (s.meanAccountPercent == null ? '-' : `${fmtNum(s.meanAccountPercent)}%p`)],
    ['평균 투입 에이전트', s => fmtNum(s.meanAgents)],
    ['평균 팀원 작업 수', s => fmtNum(s.meanWorkTasks)],
    ['평균 협의 턴', s => fmtNum(s.meanConsultations)],
    ['평균 소요 시간(분)', s => fmtNum(s.meanDurationMin)],
  ];
  lines.push(`| 지표 | ${summaries.map(s => s.label).join(' | ')} |`, `|---|${summaries.map(() => '---').join('|')}|`);
  for (const [name, format] of rows) lines.push(`| ${name} | ${summaries.map(format).join(' | ')} |`);
  if (summaries.length >= 2) {
    const [base, ...others] = summaries;
    lines.push('', `## ${base.label} 대비 변화`, '');
    const taskSet = summary => Object.entries(summary.perTask).map(([id, task]) => `${id}x${task.runs}`).join(',');
    if (others.some(other => taskSet(other) !== taskSet(base))) lines.push('> 주의: 라벨마다 실행한 과제나 반복 횟수가 달라 직접 비교하면 왜곡될 수 있습니다. 같은 과제 세트로 비교하세요.', '');
    for (const other of others) {
      lines.push(`- **${other.label}**: 평균 토큰 ${change(base.meanTokens, other.meanTokens)}, 성공 1건당 토큰 ${change(base.tokensPerSuccess, other.tokensPerSuccess)}, 평균 5시간 사용률 ${change(base.meanAccountPercent, other.meanAccountPercent)}, 소요 시간 ${change(base.meanDurationMin, other.meanDurationMin)}, 실제 성공률 ${fmtPct(base.successRate)} → ${fmtPct(other.successRate)}, 거짓 완료 비율 ${fmtPct(base.falseCompletionRate)} → ${fmtPct(other.falseCompletionRate)}`);
    }
  }
  const taskIds = [...new Set(summaries.flatMap(s => Object.keys(s.perTask)))].sort();
  lines.push('', '## 과제별 (성공/실행 · 평균 토큰 · 평균 에이전트)', '');
  lines.push(`| 과제 | ${summaries.map(s => s.label).join(' | ')} |`, `|---|${summaries.map(() => '---').join('|')}|`);
  for (const taskId of taskIds) lines.push(`| ${taskId} | ${summaries.map(s => { const t = s.perTask[taskId]; return t ? `${t.success}/${t.runs} · ${fmtK(t.meanTokens)} · ${fmtNum(t.meanAgents)}${t.falseCompletions ? ` · 거짓완료 ${t.falseCompletions}` : ''}` : '-'; }).join(' | ')} |`);
  return `${lines.join('\n')}\n`;
}

export function main(argv = process.argv.slice(2)) {
  let resultsDir = path.join(benchDirectory, 'results', 'runs');
  let mdFile = path.join(benchDirectory, 'results', 'benchmark-report.md');
  const labels = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--results-dir') resultsDir = path.resolve(argv[++index]);
    else if (argv[index] === '--md') mdFile = path.resolve(argv[++index]);
    else labels.push(argv[index]);
  }
  const summaries = loadResults(resultsDir, labels).map(summarize);
  if (!summaries.length) throw new Error(`no benchmark results in ${resultsDir}`);
  const markdown = toMarkdown(summaries);
  fs.mkdirSync(path.dirname(mdFile), { recursive: true });
  fs.writeFileSync(mdFile, markdown);
  process.stdout.write(markdown);
  return summaries;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
