#!/usr/bin/env node
// Analyze Agent Desk run history (data/state.json) and print a Markdown report.
//
//   node bench/analyze-history.mjs <state.json> [more state.json...] [--json out.json] [--md out.md]
//
// Token correction: Agent Desk resumes one main-AI thread per project and stored
// Codex's thread-cumulative `tokenUsage.total` as the run's usage. The main task's
// usage therefore includes every earlier request in that thread. This script
// converts it to a per-request delta (current cumulative - previous cumulative in
// the same thread; a drop means a new thread started). Team tasks run on fresh
// ephemeral threads, so their usage is already per task.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIELDS = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens'];
const COMPLAINT = /안\s?되|안\s?돼|안\s?보|안\s?떠|실패|에러|오류|뜨는데|사라지|왜 그|그대로|여전히|아니 내가|적용이 안|not work|doesn'?t work|broken/i;

function parseArgs(argv) {
  const files = [];
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--json' || value === '--md') options[value.slice(2)] = argv[++index];
    else files.push(value);
  }
  if (!files.length) throw new Error('usage: node bench/analyze-history.mjs <state.json> [...] [--json out.json] [--md out.md]');
  return { files, options };
}

const sum = values => values.reduce((total, value) => total + value, 0);
const mean = values => (values.length ? sum(values) / values.length : 0);
const median = values => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const pct = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : '-');
const kTokens = value => `${(value / 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })}k`;
const usageOf = task => Object.fromEntries(FIELDS.map(field => [field, Number(task?.usage?.[field]) || 0]));
const verdictOf = task => task.output?.match(/^\s*\[검증 결과:\s*(PASS|FAIL|NOT_VERIFIED)\]/im)?.[1] || 'NONE';

export function loadRuns(files) {
  const seen = new Map();
  const agentNames = {};
  for (const file of files) {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const agent of state.agents || []) agentNames[agent.id] ||= agent.name;
    for (const run of state.runs || []) if (!seen.has(run.id)) seen.set(run.id, { ...run, sourceFile: file });
  }
  const runs = [...seen.values()].filter(run => run.startedAt).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return { runs, agentNames };
}

export function correctRuns(runs) {
  const previousMain = new Map(); // projectId -> cumulative usage of the resumed main thread
  return runs.map(run => {
    const tasks = run.tasks || [];
    const mainTasks = tasks.filter(task => task.agentId === 'main');
    const teamTasks = tasks.filter(task => task.agentId !== 'main');
    const mainCumulative = Object.fromEntries(FIELDS.map(field => [field, Math.max(0, ...mainTasks.map(task => usageOf(task)[field]))]));
    const prior = previousMain.get(run.projectId);
    const sameThread = prior && mainCumulative.totalTokens >= prior.totalTokens;
    const mainDelta = Object.fromEntries(FIELDS.map(field => [field, sameThread ? Math.max(0, mainCumulative[field] - prior[field]) : mainCumulative[field]]));
    if (mainCumulative.totalTokens > 0) previousMain.set(run.projectId, mainCumulative);
    const team = Object.fromEntries(FIELDS.map(field => [field, sum(teamTasks.map(task => usageOf(task)[field]))]));
    const corrected = Object.fromEntries(FIELDS.map(field => [field, mainDelta[field] + team[field]]));
    const reported = Object.fromEntries(FIELDS.map(field => [field, Number(run.usage?.[field]) || 0]));
    const workTasks = teamTasks.filter(task => !task.consultation && !/^협의 응답/.test(task.title || ''));
    const consultations = teamTasks.length - workTasks.length;
    const specialists = new Set(workTasks.map(task => task.agentId));
    const verifierTasks = workTasks.filter(task => task.agentId === 'verifier');
    return {
      id: run.id,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      message: run.message || '',
      status: run.status,
      qualityGate: run.qualityGate?.status || 'none',
      reported,
      corrected,
      mainDelta,
      team,
      accountPercent: Number.isFinite(run.accountUsage?.consumedPercent) ? run.accountUsage.consumedPercent : null,
      durationSec: run.finishedAt ? Math.max(0, (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000) : null,
      agentCount: specialists.size,
      agents: [...specialists],
      workTasks: workTasks.length,
      consultations,
      discussions: (run.discussions || []).length,
      retries: workTasks.filter(task => task.retryOfTaskId || task.retryAttempt).length,
      failedTasks: workTasks.filter(task => task.status !== 'completed').length,
      verifierVerdicts: verifierTasks.map(verdictOf),
      wroteFiles: workTasks.some(task => task.writable === true),
      tasks: workTasks.map(task => ({ agentId: task.agentId, status: task.status, tokens: usageOf(task).totalTokens, writable: task.writable === true, verdict: task.agentId === 'verifier' ? verdictOf(task) : null })),
    };
  });
}

function bucketOf(count) {
  if (count === 0) return '0 (메인 단독)';
  if (count === 1) return '1명';
  if (count <= 3) return '2~3명';
  return '4명 이상';
}

export function analyze(runs, agentNames) {
  const corrected = correctRuns(runs);
  const followUps = corrected.map((run, index) => {
    const next = corrected[index + 1];
    return { run, complaint: !!next && COMPLAINT.test(next.message) && (Date.parse(next.startedAt) - Date.parse(run.finishedAt || run.startedAt)) < 6 * 3600 * 1000 };
  });

  const buckets = {};
  for (const run of corrected) (buckets[bucketOf(run.agentCount)] ||= []).push(run);
  const bucketRows = ['0 (메인 단독)', '1명', '2~3명', '4명 이상'].filter(key => buckets[key]).map(key => {
    const group = buckets[key];
    const complaints = followUps.filter(item => group.includes(item.run) && item.run.status === 'completed' && item.complaint).length;
    const completed = group.filter(run => run.status === 'completed').length;
    return {
      bucket: key,
      runs: group.length,
      meanTokens: mean(group.map(run => run.corrected.totalTokens)),
      medianTokens: median(group.map(run => run.corrected.totalTokens)),
      meanUncachedInput: mean(group.map(run => run.corrected.inputTokens - run.corrected.cachedInputTokens)),
      meanAccountPercent: mean(group.filter(run => run.accountPercent != null).map(run => run.accountPercent)),
      meanWorkTasks: mean(group.map(run => run.workTasks)),
      meanConsultations: mean(group.map(run => run.consultations)),
      needsReviewRate: group.filter(run => run.status !== 'completed').length / group.length,
      complaintAfterCompleted: completed ? complaints / completed : null,
      meanDurationMin: mean(group.filter(run => run.durationSec != null).map(run => run.durationSec / 60)),
    };
  });

  const perAgent = {};
  for (const run of corrected) {
    perAgent.main ||= { calls: 0, tokens: 0, failed: 0 };
    perAgent.main.calls++; perAgent.main.tokens += run.mainDelta.totalTokens;
    for (const task of run.tasks) {
      const entry = (perAgent[task.agentId] ||= { calls: 0, tokens: 0, failed: 0 });
      entry.calls++; entry.tokens += task.tokens; if (task.status !== 'completed') entry.failed++;
    }
  }
  const totalCorrected = sum(corrected.map(run => run.corrected.totalTokens));
  const agentRows = Object.entries(perAgent).map(([id, entry]) => ({ id, name: agentNames[id] || id, ...entry, share: totalCorrected ? entry.tokens / totalCorrected : 0 })).sort((a, b) => b.tokens - a.tokens);

  const verdicts = corrected.flatMap(run => run.verifierVerdicts);
  const verdictCounts = Object.fromEntries(['PASS', 'FAIL', 'NOT_VERIFIED', 'NONE'].map(key => [key, verdicts.filter(value => value === key).length]));
  const writeRuns = corrected.filter(run => run.wroteFiles);
  const firstVerdicts = writeRuns.map(run => run.verifierVerdicts[0]).filter(Boolean);

  const chains = [];
  for (let index = 0; index < corrected.length;) {
    let end = index;
    while (end + 1 < corrected.length && corrected[end + 1].message.trim() === corrected[index].message.trim() && corrected[index].message.trim()) end++;
    if (end > index) {
      const group = corrected.slice(index, end + 1);
      chains.push({ message: group[0].message.replace(/\s+/g, ' ').trim().slice(0, 60), runs: group.length, finalStatus: group.at(-1).status, tokens: sum(group.map(run => run.corrected.totalTokens)), accountPercent: sum(group.map(run => run.accountPercent || 0)) });
    }
    index = end + 1;
  }

  const delegated = corrected.filter(run => run.agentCount > 0);
  const half = Math.floor(corrected.length / 2);
  const directRuns = corrected.filter(run => run.agentCount === 0);
  return {
    period: { from: corrected[0]?.startedAt, to: corrected.at(-1)?.startedAt },
    runs: corrected.length,
    statusCounts: corrected.reduce((counts, run) => ({ ...counts, [run.status]: (counts[run.status] || 0) + 1 }), {}),
    tokens: {
      reportedSum: sum(corrected.map(run => run.reported.totalTokens)),
      correctedSum: totalCorrected,
      correctedUncachedInput: sum(corrected.map(run => run.corrected.inputTokens - run.corrected.cachedInputTokens)),
      correctedOutput: sum(corrected.map(run => run.corrected.outputTokens)),
      mainContextGrowth: {
        firstHalfDirectMean: mean(directRuns.filter(run => corrected.indexOf(run) < half).map(run => run.mainDelta.totalTokens)),
        secondHalfDirectMean: mean(directRuns.filter(run => corrected.indexOf(run) >= half).map(run => run.mainDelta.totalTokens)),
      },
    },
    buckets: bucketRows,
    agents: agentRows,
    verification: { verdictCounts, writeRuns: writeRuns.length, firstVerdictPassRate: firstVerdicts.length ? firstVerdicts.filter(value => value === 'PASS').length / firstVerdicts.length : null, firstVerdicts: firstVerdicts.length, firstVerdictCounts: Object.fromEntries(['PASS', 'FAIL', 'NOT_VERIFIED', 'NONE'].map(key => [key, firstVerdicts.filter(value => value === key).length])) },
    delegation: {
      delegatedRuns: delegated.length,
      meanAgentsWhenDelegated: mean(delegated.map(run => run.agentCount)),
      runsWithConsultations: corrected.filter(run => run.consultations > 0).length,
      consultationTurns: sum(corrected.map(run => run.consultations)),
      retryTasks: sum(corrected.map(run => run.retries)),
      failedTasks: sum(corrected.map(run => run.failedTasks)),
      totalWorkTasks: sum(corrected.map(run => run.workTasks)),
    },
    repeatChains: chains,
    complaintsAfterCompleted: { completed: corrected.filter(run => run.status === 'completed').length, complaints: followUps.filter(item => item.run.status === 'completed' && item.complaint).length },
    perRun: corrected.map(({ tasks, message, ...run }) => run), // request text omitted: results may be committed to a public repo
  };
}

export function toMarkdown(result) {
  const lines = [];
  const t = result.tokens;
  lines.push('# Agent Desk 실행 기록 분석', '');
  lines.push(`- 기간: ${result.period.from?.slice(0, 16)} ~ ${result.period.to?.slice(0, 16)} (UTC)`);
  lines.push(`- 요청 ${result.runs}건 · 상태 ${Object.entries(result.statusCounts).map(([key, value]) => `${key} ${value}`).join(', ')}`);
  lines.push('', '## 토큰 측정 보정', '');
  lines.push(`- 대시보드 기록 합계: ${kTokens(t.reportedSum)} (메인 스레드 누적값이 요청마다 중복 합산됨)`);
  lines.push(`- 보정 합계(요청별 증분): **${kTokens(t.correctedSum)}** · 과대 계상 ${t.correctedSum ? (t.reportedSum / t.correctedSum).toFixed(1) : '-'}배`);
  lines.push(`- 보정 합계 중 캐시 미적용 입력 ${kTokens(t.correctedUncachedInput)}, 출력 ${kTokens(t.correctedOutput)}`);
  lines.push(`- 메인 단독 답변의 메인 토큰 평균: 전반부 ${kTokens(t.mainContextGrowth.firstHalfDirectMean)} → 후반부 ${kTokens(t.mainContextGrowth.secondHalfDirectMean)} (이어 쓰는 메인 스레드 맥락 증가)`);
  lines.push('', '## 위임한 전문 에이전트 수별 비교', '');
  lines.push('| 투입 에이전트 | 요청 | 평균 토큰 | 중앙값 | 평균 캐시 미적용 입력 | 평균 5h 사용률 | 작업 수 | 협의 턴 | 검토 필요 비율 | 완료 후 사용자 재신고 | 평균 소요(분) |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const row of result.buckets) lines.push(`| ${row.bucket} | ${row.runs} | ${kTokens(row.meanTokens)} | ${kTokens(row.medianTokens)} | ${kTokens(row.meanUncachedInput)} | ${row.meanAccountPercent.toFixed(1)}%p | ${row.meanWorkTasks.toFixed(1)} | ${row.meanConsultations.toFixed(1)} | ${(row.needsReviewRate * 100).toFixed(0)}% | ${row.complaintAfterCompleted == null ? '-' : `${(row.complaintAfterCompleted * 100).toFixed(0)}%`} | ${row.meanDurationMin.toFixed(1)} |`);
  lines.push('', '## 에이전트별 사용량', '');
  lines.push('| 에이전트 | 호출 | 토큰(보정) | 비중 | 미완료 |', '|---|---|---|---|---|');
  for (const row of result.agents) lines.push(`| ${row.name} | ${row.calls} | ${kTokens(row.tokens)} | ${(row.share * 100).toFixed(1)}% | ${row.failed} |`);
  const v = result.verification;
  const totalVerdicts = Object.values(v.verdictCounts).reduce((a, b) => a + b, 0);
  lines.push('', '## 검증(체커) 결과', '');
  lines.push(`- 체커 실행 ${totalVerdicts}회: PASS ${v.verdictCounts.PASS} (${pct(v.verdictCounts.PASS, totalVerdicts)}), FAIL ${v.verdictCounts.FAIL} (${pct(v.verdictCounts.FAIL, totalVerdicts)}), NOT_VERIFIED ${v.verdictCounts.NOT_VERIFIED} (${pct(v.verdictCounts.NOT_VERIFIED, totalVerdicts)}), 판정 없음 ${v.verdictCounts.NONE}`);
  lines.push(`- 파일 수정이 있었던 요청 ${v.writeRuns}건 중 첫 검증 PASS 비율: ${v.firstVerdictPassRate == null ? '-' : `${(v.firstVerdictPassRate * 100).toFixed(0)}%`} (${v.firstVerdicts}건 기준: PASS ${v.firstVerdictCounts.PASS}, FAIL ${v.firstVerdictCounts.FAIL}, NOT_VERIFIED ${v.firstVerdictCounts.NOT_VERIFIED}, 판정 없음 ${v.firstVerdictCounts.NONE})`);
  lines.push('  - FAIL은 구현 담당이 완료로 보고했지만 독립 검증에서 결함이 발견된 경우입니다.');
  const d = result.delegation;
  lines.push('', '## 위임·협의', '');
  lines.push(`- 위임 요청 ${d.delegatedRuns}건, 요청당 평균 전문 에이전트 ${d.meanAgentsWhenDelegated.toFixed(1)}명`);
  lines.push(`- 팀원 작업 ${d.totalWorkTasks}개 중 미완료 ${d.failedTasks}개, 재시도 ${d.retryTasks}개`);
  lines.push(`- 팀원 간 협의 턴 ${d.consultationTurns}회 (${d.runsWithConsultations}개 요청)`);
  const c = result.complaintsAfterCompleted;
  lines.push(`- '완료'로 끝난 요청 ${c.completed}건 중 다음 메시지에서 사용자가 문제를 다시 신고한 경우 ${c.complaints}건 (${pct(c.complaints, c.completed)}, 키워드 기반 추정)`);
  if (result.repeatChains.length) {
    lines.push('', '## 같은 요청 반복 실행', '');
    lines.push('| 요청 | 실행 횟수 | 최종 상태 | 토큰(보정) | 5h 사용률 합 |', '|---|---|---|---|---|');
    for (const chain of result.repeatChains) lines.push(`| ${chain.message.replace(/\|/g, '/')} | ${chain.runs} | ${chain.finalStatus} | ${kTokens(chain.tokens)} | ${chain.accountPercent}%p |`);
  }
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { files, options } = parseArgs(process.argv.slice(2));
  const { runs, agentNames } = loadRuns(files);
  const result = analyze(runs, agentNames);
  const markdown = toMarkdown(result);
  if (options.json) fs.writeFileSync(options.json, JSON.stringify(result, null, 2));
  if (options.md) fs.writeFileSync(options.md, markdown);
  process.stdout.write(markdown);
}
