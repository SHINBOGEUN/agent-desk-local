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
import { fileURLToPath, pathToFileURL } from 'node:url';
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

  // ---- v2 adapter: a fake CLI stands in for `agent-desk run` (no Codex usage) ----
  const evaluateUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'evaluate.mjs')).href;
  const fakeCli = path.join(scratch, 'fake-cli.mjs');
  const argsLog = path.join(scratch, 'v2-args.jsonl');
  fs.writeFileSync(fakeCli, `
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { loadTasks } = await import(${JSON.stringify(evaluateUrl)});
const argv = process.argv.slice(2);
if (argv[0] === 'doctor') { console.log('ok   fake runtime: ready\\nFAIL verify commands: none configured'); process.exit(1); }
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(argv) + '\\n');
const prompt = argv[1];
const project = argv[argv.indexOf('--project') + 1];
const task = loadTasks().find(item => item.prompt === prompt);
if (task.kind === 'code' && task.id !== 'T02') (await import(pathToFileURL(path.join(task.directory, 'solution.mjs')).href)).apply(project);
const usage = total => ({ inputTokens: total * 0.9, cachedInputTokens: total * 0.6, outputTokens: total * 0.1, reasoningTokens: 0, totalTokens: total });
const code = task.kind === 'code';
const entries = [{ stepId: 'classify', turn: 1, delta: usage(1000) }, ...(code ? [{ stepId: 'build', turn: 1, delta: usage(5000) }, { stepId: 'review', turn: 1, delta: usage(2000) }] : [])];
const total = entries.reduce((sum, entry) => sum + entry.delta.totalTokens, 0);
console.log(JSON.stringify({ status: 'completed', reason: 'ok', gates: code ? [{ gate: 'G3', ok: true, attempt: 0, detail: '', problems: [] }] : [], redo: 0, warnings: [], unverified: [], usage: usage(total), usageEntries: entries, review: code ? { verdict: 'PASS', blocking: [], optional: [] } : undefined, answer: task.kind === 'answer' ? { answer: '기본 포트는 3100이고 데이터 파일은 data\\\\todos.json 입니다.', sources: [] } : undefined, events: [] }));
`);
  const v2common = ['--adapter', 'v2', '--cli', JSON.stringify([process.execPath, fakeCli]), '--work-dir', path.join(scratch, 'work2'), '--results-dir', path.join(scratch, 'results2'), '--review', 'auto'];
  const second = await runBenchmark(['--label', 'selftest-v2', ...v2common], quiet);
  assert.equal(second.length, tasks.length);
  const v2ByTask = Object.fromEntries(second.map(result => [result.taskId, result]));
  for (const task of tasks) {
    const result = v2ByTask[task.id];
    assert.equal(result.adapter, 'v2');
    if (task.id === 'T02') { assert.equal(result.falseCompletion, true); assert.equal(result.falseVerifierPass, true); }
    else assert.equal(result.grade.success, true, `v2 ${task.id} should pass: ${JSON.stringify(result.grade)}`);
  }
  assert.equal(v2ByTask.T01.metrics.agentCount, 2);
  assert.deepEqual(v2ByTask.T01.metrics.agents, ['builder', 'verifier']);
  assert.equal(v2ByTask.T01.metrics.usage.totalTokens, 8000);
  assert.equal(v2ByTask.T01.metrics.usage.uncachedInputTokens, 8000 * 0.9 - 8000 * 0.6);
  assert.equal(v2ByTask.T09.metrics.agentCount, 0);
  assert.deepEqual(v2ByTask.T09.grade.changedFiles, []);
  const logged = fs.readFileSync(argsLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(logged.length, tasks.length);
  for (const argv of logged) {
    assert.ok(argv.includes('--unattended') && argv.includes('--json'));
    assert.equal(argv[argv.indexOf('--verify') + 1], 'npm test');
    assert.equal(argv[argv.indexOf('--review') + 1], 'auto');
  }
  const config = JSON.parse(fs.readFileSync(path.join(scratch, 'results2', 'selftest-v2', '_config.json'), 'utf8'));
  assert.equal(config.adapter, 'v2');
  assert.equal(loadResults(path.join(scratch, 'results2'), ['selftest-v2']).map(summarize)[0].falseCompletions, 1);
  console.log('Benchmark self-test passed.');
} finally {
  server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
