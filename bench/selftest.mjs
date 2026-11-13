#!/usr/bin/env node
// End-to-end check of the benchmark runner and report against a fake Agent Desk
// server (no Codex usage). The fake team solves tasks with the reference
// solutions, except T02 where it claims completion without changing anything,
// which must be graded as a false completion.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadTasks } from './lib/evaluate.mjs';
import { main as runBenchmark } from './run.mjs';
import { loadResults, summarize, toMarkdown } from './report.mjs';

const tasks = loadTasks();
const csrf = 'test-token';
const state = { settings: { concurrency: 2, maxDelegations: 6, timeoutMinutes: 15, usagePercentLimit: 5 }, agents: [{ id: 'main', name: 'main', enabled: true, model: 'fake', effort: 'low', access: 'read-only' }, { id: 'worker', name: 'worker', enabled: true }, { id: 'verifier', name: 'verifier', enabled: true }], skills: [], projects: [], runs: [] };
let activeRunId = null;
let approvals = [];
let blockRuns = false;

async function simulate(run, project) {
  const task = tasks.find(item => item.prompt === run.message);
  await new Promise(resolve => setTimeout(resolve, 30));
  if (task.id === 'T01') {
    approvals = [{ id: 'a1', method: 'item/commandExecution/requestApproval' }];
    while (approvals.length) await new Promise(resolve => setTimeout(resolve, 10));
  }
  const solve = task.kind === 'code' && task.id !== 'T02';
  if (solve) (await import(pathToFileURL(path.join(task.directory, 'solution.mjs')).href)).apply(project.path);
  const usage = tokens => ({ totalTokens: tokens, inputTokens: tokens * 0.9, cachedInputTokens: tokens * 0.6, outputTokens: tokens * 0.1 });
  run.tasks = [
    { agentId: 'main', title: '요청 분석', status: 'completed', usage: usage(1000) },
    ...(task.kind === 'code' ? [
      { agentId: 'worker', title: '구현', status: 'completed', usage: usage(5000) },
      { agentId: 'verifier', title: '검증', status: 'completed', usage: usage(2000), output: '[검증 결과: PASS]\n확인했습니다.' },
    ] : []),
  ];
  run.usage = run.tasks.reduce((total, item) => Object.fromEntries(Object.keys(item.usage).map(key => [key, (total[key] || 0) + item.usage[key]])), {});
  run.answer = task.kind === 'answer' ? '기본 포트는 3100이고 데이터 파일은 data\\todos.json 입니다.' : '완료했습니다.';
  run.accountUsage = { consumedPercent: task.kind === 'code' ? 1 : 0 };
  run.status = 'completed';
  run.qualityGate = { status: task.kind === 'code' ? 'passed' : 'not_required' };
  run.finishedAt = new Date().toISOString();
  activeRunId = null;
}

const server = http.createServer(async (request, response) => {
  const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
  const url = new URL(request.url, 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/api/health') return send(200, { ok: true, connection: 'connected' });
  if (request.method === 'GET' && url.pathname === '/api/state') return send(200, { ...state, activeRunId, approvals, csrf });
  if (request.method !== 'POST' || request.headers['x-agent-desk-token'] !== csrf) return send(403, { error: 'forbidden' });
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (url.pathname === '/api/settings') { Object.assign(state.settings, input); return send(200, { ok: true }); }
  if (url.pathname === '/api/projects') { const project = { id: randomUUID(), ...input }; state.projects.push(project); return send(200, project); }
  if (url.pathname === '/api/approvals/allow-all') { const approved = approvals.length; approvals = []; return send(200, { enabled: true, approved }); }
  if (url.pathname === '/api/cancel') return send(200, { ok: true });
  if (url.pathname === '/api/runs') {
    if (activeRunId) return send(400, { error: 'busy' });
    if (blockRuns) return send(400, { error: '5시간 한도 사용률을 확인할 수 없어 요청을 시작하지 않았습니다.' });
    const project = state.projects.find(item => item.id === input.projectId);
    const run = { id: randomUUID(), projectId: project.id, message: input.message, status: 'running', startedAt: new Date().toISOString(), tasks: [] };
    state.runs.unshift(run); activeRunId = run.id;
    simulate(run, project).catch(error => { run.status = 'failed'; run.error = error.message; activeRunId = null; });
    return send(202, { id: run.id });
  }
  return send(404, { error: 'not found' });
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desk-bench-selftest-'));
try {
  const common = ['--url', `http://127.0.0.1:${server.address().port}`, '--work-dir', path.join(scratch, 'work'), '--results-dir', path.join(scratch, 'results'), '--poll-ms', '50', '--usage-limit', '15'];
  const quiet = () => {};
  const first = await runBenchmark(['--label', 'selftest', ...common], quiet);
  assert.equal(first.length, tasks.length);
  assert.equal(state.settings.usagePercentLimit, 15, 'usage limit is applied');
  const byTask = Object.fromEntries(first.map(result => [result.taskId, result]));
  for (const task of tasks) {
    const result = byTask[task.id];
    if (task.id === 'T02') {
      assert.equal(result.grade.success, false);
      assert.equal(result.falseCompletion, true, 'claimed completion without changes is a false completion');
      assert.equal(result.falseVerifierPass, true);
    } else {
      assert.equal(result.grade.success, true, `${task.id} should pass: ${JSON.stringify(result.grade)}`);
      assert.equal(result.falseCompletion, false);
    }
  }
  assert.ok(byTask.T01.grade.changedFiles.includes('src/app.mjs'));
  assert.deepEqual(byTask.T09.grade.changedFiles, []);
  assert.equal(byTask.T01.metrics.agentCount, 2);
  assert.equal(byTask.T01.metrics.usage.uncachedInputTokens, 2400);
  assert.equal(byTask.T01.adapter, 'v1');

  const again = await runBenchmark(['--label', 'selftest', ...common], quiet);
  assert.equal(again.length, 0, 'recorded tasks are skipped on re-run');
  await runBenchmark(['--label', 'selftest-subset', '--tasks', 'T01,T09', ...common], quiet);

  blockRuns = true;
  const blocked = await runBenchmark(['--label', 'selftest-blocked', '--tasks', 'T01', ...common], quiet);
  assert.equal(blocked.length, 0, 'a usage-limit refusal stops the batch without recording a result');
  assert.equal(process.exitCode, 2);
  process.exitCode = 0;
  blockRuns = false;
  assert.ok(!fs.existsSync(path.join(scratch, 'results', 'selftest-blocked', 'T01-r1.json')));

  const summaries = loadResults(path.join(scratch, 'results'), ['selftest', 'selftest-subset']).map(summarize);
  assert.equal(summaries[0].runs, tasks.length);
  assert.equal(summaries[0].falseCompletions, 1);
  assert.equal(summaries[0].successRate, (tasks.length - 1) / tasks.length);
  assert.equal(summaries[1].runs, 2);
  const markdown = toMarkdown(summaries);
  assert.match(markdown, /거짓 완료 비율/);
  assert.match(markdown, /selftest 대비 변화/);
  console.log(markdown);
  console.log('Benchmark self-test passed.');
} finally {
  server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
