import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { FakeRuntime } from '#runtime-fake';
import type { FakeScript } from '#runtime-fake';
import { BRIEF_MAX_CHARS, buildRunBrief, runRequest } from '#orchestrator';
import type { RunEvent, RunResult } from '#orchestrator';
import { RunStore, redactSecrets } from '#store';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
const script = (...turns: FakeScript['turns']): FakeScript => ({ turns });
const write = (file: string) => ({ writeFile: { path: file, content: 'x' } });
const classify = { workflow: 'build', requirements: [{ id: 'R1', text: 'make a.txt', quote: 'a.txt' }], reason: 'one file' };
const builder = { summary: 's', changedFiles: ['a.txt'], commandsRun: [], requirements: [{ id: 'R1', status: 'done', evidence: 'a.txt' }], unverified: [] };

async function storedRun(store: RunStore, cwd: string, request: string, previousBrief?: string) {
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ usage: { inputTokens: 60, cachedInputTokens: 10, outputTokens: 10 } }, { report: { ...classify, requirements: [{ id: 'R1', text: 'make a.txt', quote: request }] } }])], builder: [script([write('a.txt'), { usage: { inputTokens: 300, cachedInputTokens: 100, outputTokens: 50 } }, { report: builder }])] } });
  const runId = store.startRun(cwd, request);
  const result = await runRequest(request, { cwd, runtime, review: 'never', onEvent: store.recorder(runId), ...(previousBrief ? { previousBrief } : {}) });
  const brief = store.finishRun(runId, request, result);
  return { runId, result, brief, runtime };
}

test('a run is stored with events, steps, usage and a brief', async () => {
  const store = new RunStore(':memory:');
  const cwd = tmp();
  const { runId, result, brief } = await storedRun(store, cwd, 'make a.txt');
  const row = store.getRun(runId)!;
  assert.equal(row.status, 'completed');
  assert.equal(row.workflow, 'build');
  assert.equal(row.brief, brief);
  const events = store.events(runId);
  assert.equal(events.length, result.events.length);
  assert.deepEqual(events.map(event => event.seq), result.events.map(event => event.seq));
  assert.deepEqual(store.steps(runId).map(step => [step.step, step.role, step.ok]), [['classify', 'lead', true], ['build', 'builder', true], ['report', 'lead', true]]);
  assert.equal(store.events(runId, events.length - 1).length, 1);
  store.close();
});

test('the report the agents submitted is stored with the run and secrets are masked', async () => {
  const store = new RunStore(':memory:');
  const { runId } = await storedRun(store, tmp(), 'make a.txt');
  const report = store.getReport(runId) as { builder: { changedFiles: string[]; summary: string }; redo: number };
  assert.deepEqual(report.builder.changedFiles, ['a.txt']);
  assert.equal(report.builder.summary, 's');
  assert.equal(report.redo, 0);
  assert.equal(store.getReport(9999), null);
  const open = store.startRun(tmp(), 'still running');
  assert.equal(store.getReport(open), null);
  store.close();
});

test('stored usage equals the sum of the per-turn increments in the event log', async () => {
  const store = new RunStore(':memory:');
  const { runId, result } = await storedRun(store, tmp(), 'make a.txt');
  assert.equal(store.usageTotal(runId), result.usage.totalTokens);
  assert.equal(store.usageTotal(runId), 70 + 350);
  const fromEvents = store.events(runId).reduce((sum, stored) => sum + (stored.data.type === 'runtime' && stored.data.event.type === 'usage' ? stored.data.event.delta.totalTokens : 0), 0);
  assert.equal(fromEvents, store.usageTotal(runId));
  assert.deepEqual(store.usage(runId).map(row => [row.stepId, row.turn]), [['classify', 1], ['build', 1]]);
  store.close();
});

test('secrets are masked and long output is cut before storage', () => {
  const store = new RunStore(':memory:');
  const runId = store.startRun('/p', 'x');
  const record = store.recorder(runId);
  const secretEvent: RunEvent = { seq: 1, at: new Date().toISOString(), type: 'runtime', step: 'build', role: 'builder', event: { type: 'command', command: 'cat .env', exitCode: 0, output: `API_KEY=supersecret123\nkey sk-abcdefghijklmnop1234\n${'x'.repeat(9000)}` } };
  record(secretEvent);
  const stored = JSON.stringify(store.events(runId)[0]);
  assert.doesNotMatch(stored, /supersecret123/);
  assert.doesNotMatch(stored, /sk-abcdefghijklmnop1234/);
  assert.match(stored, /\[redacted\]/);
  assert.match(stored, /cut \d+ chars/);
  assert.ok(stored.length < 6000);
  assert.equal(redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwx'), 'Authorization: [redacted]');
  assert.equal(redactSecrets('nothing secret here'), 'nothing secret here');
  store.close();
});

test('after a crash the run is marked interrupted on restart and never re-run', async () => {
  const dir = tmp();
  const file = path.join(dir, 'data', 'agent-desk.sqlite');
  const project = tmp();
  const first = new RunStore(file);
  const finished = await storedRun(first, project, 'earlier request');
  const crashedId = first.startRun(project, 'in flight');
  const record = first.recorder(crashedId);
  record({ seq: 1, at: new Date().toISOString(), type: 'run_started', request: 'in flight' });
  record({ seq: 2, at: new Date().toISOString(), type: 'step_started', step: 'build', role: 'builder' });
  first.close();

  const second = new RunStore(file);
  assert.equal(second.getRun(crashedId)?.status, 'running');
  assert.deepEqual(second.recoverInterrupted(), [crashedId]);
  const recovered = second.getRun(crashedId)!;
  assert.equal(recovered.status, 'interrupted');
  assert.match(recovered.reason ?? '', /Nothing was re-run/);
  assert.equal(second.events(crashedId).at(-1)?.type, 'run_finished');
  assert.deepEqual(second.steps(crashedId).map(step => [step.step, step.ok]), [['build', false]]);
  assert.equal(second.getRun(finished.runId)?.status, 'completed');
  assert.deepEqual(second.recoverInterrupted(), []);
  assert.equal(second.listRuns(project)[0]?.id, crashedId);
  second.close();
});

test('the latest brief of a project reaches the next run, and only that one', async () => {
  const store = new RunStore(':memory:');
  const p1 = tmp();
  const first = await storedRun(store, p1, 'make a.txt');
  assert.equal(store.latestBrief(p1), first.brief);
  assert.equal(store.latestBrief('/other'), null);
  store.startRun(p1, 'still running');
  assert.equal(store.latestBrief(p1), first.brief);
  const second = await storedRun(store, tmp(), 'now also b.txt', store.latestBrief(p1)!);
  assert.match(second.runtime.turns[0]?.input.text ?? '', /Summary of the previous run/);
  assert.match(second.runtime.turns[0]?.input.text ?? '', /요청: make a\.txt/);
  store.close();
});

test('run briefs are short, deterministic and capped', () => {
  const base: RunResult = { status: 'needs_review', reason: 'r'.repeat(2000), requirements: [], gates: [], redo: 2, warnings: ['w'.repeat(500)], unverified: ['u'.repeat(500), 'v', 'w', 'x', 'y'], usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 }, usageEntries: [], events: [], workflow: 'build', builder: { summary: 's', changedFiles: Array.from({ length: 30 }, (_, index) => `src/file${index}.ts`), commandsRun: [], requirements: [{ id: 'R1', status: 'not_done', evidence: '' }], unverified: [] } };
  const brief = buildRunBrief('q'.repeat(5000), base);
  assert.ok(brief.length <= BRIEF_MAX_CHARS);
  assert.match(brief, /외 20개/);
  assert.match(brief, /남은 요구사항: R1\(not_done\)/);
  assert.equal(brief, buildRunBrief('q'.repeat(5000), base));
  const answer = buildRunBrief('which port?', { ...base, status: 'completed', reason: 'ok', redo: 0, unverified: [], warnings: [], workflow: 'answer', builder: undefined as never, answer: { answer: 'Port 3000', sources: [] } });
  assert.match(answer, /답변 요지: Port 3000/);
});

test('an empty database is created with the schema and a newer schema is refused', () => {
  const file = path.join(tmp(), 'a.sqlite');
  new RunStore(file).close();
  const raw = new DatabaseSync(file);
  assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 4);
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  assert.throws(() => new RunStore(file), /newer than this program supports/);
});

test('deleting runs removes their events, steps and usage, and skips running runs', () => {
  const store = new RunStore(':memory:');
  const done = store.startRun('/bench/T01-r1', 'a');
  store.recorder(done)({ type: 'step_started', step: 'build', role: 'builder', seq: 1, at: 'now' } as RunEvent);
  store.finishRun(done, 'a', { status: 'completed', reason: 'ok', requirements: [], gates: [], redo: 0, warnings: [], unverified: [], usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 }, usageEntries: [], events: [] } as RunResult);
  const running = store.startRun('/bench/T01-r1', 'b');
  assert.deepEqual(store.runIdsForProject('/bench/T01-r1').sort(), [done, running].sort());
  assert.deepEqual(store.deleteRuns([done, running, 999]), [done]);
  assert.equal(store.getRun(done), null);
  assert.equal(store.events(done).length, 0);
  assert.equal(store.steps(done).length, 0);
  assert.ok(store.getRun(running));
  assert.deepEqual(store.projects(), [{ project: '/bench/T01-r1', runs: 1 }]);
  store.close();
});

test('feedback: a rating sits next to what the harness measured, and goes with the run', async () => {
  const store = new RunStore(':memory:');
  const cwd = tmp();
  const first = await storedRun(store, cwd, 'make a.txt');
  const second = await storedRun(store, cwd, 'make a.txt again');
  const other = await storedRun(store, tmp(), 'make a.txt');
  store.setFeedback({ runId: first.runId, rating: 1, cause: 'skill', target: 'x', note: 'good' });
  assert.deepEqual({ ...store.getFeedback(first.runId), at: '' }, { runId: first.runId, rating: 1, cause: null, target: null, note: 'good', at: '' });
  store.setFeedback({ runId: second.runId, rating: -1, cause: 'role', target: '.agent-desk/agents/builder.md', note: 'changed unrelated files' });
  assert.throws(() => store.setFeedback({ runId: 999, rating: 1, cause: null, target: null, note: null }), /not found/);
  assert.throws(() => store.setFeedback({ runId: first.runId, rating: 1, cause: 'mood' as never, target: null, note: null }), /cause must be/);
  const rows = store.qualityRows(cwd);
  assert.deepEqual(rows.map(row => [row.runId, row.rating, row.cause, row.target]), [[second.runId, -1, 'role', '.agent-desk/agents/builder.md'], [first.runId, 1, null, null]]);
  assert.equal(rows[0]!.tokens, store.usageTotal(second.runId));
  assert.ok(rows[0]!.tokens > 0);
  // The second run's builder "changed" a.txt to the content it already had, so the change gate sent it back once.
  assert.equal(rows[0]!.redo, second.result.redo);
  assert.equal(rows[1]!.redo, 0);
  assert.equal(rows[1]!.rejectedReports, 0);
  assert.equal(store.qualityRows().length, 3);
  store.clearFeedback(first.runId);
  assert.equal(store.getFeedback(first.runId), null);
  store.deleteRuns([second.runId]);
  assert.equal(store.getFeedback(second.runId), null);
  assert.equal(store.qualityRows().length, 2);
  assert.ok(store.qualityRows(cwd).every(row => row.runId !== other.runId));
  store.close();
});

import { historyLookup } from '#service';

test('history lookup: by run id (same project only) or by words, with what the report adds', async () => {
  const store = new RunStore(':memory:');
  const cwd = tmp();
  const login = await storedRun(store, cwd, 'make a.txt for the login page');
  await storedRun(store, tmp(), 'make a.txt somewhere else');
  const other = store.listRuns().find(run => run.project !== cwd)!;
  assert.deepEqual(store.recentBriefs(cwd).map(run => run.id), [login.runId]);
  assert.deepEqual(store.searchRuns(cwd, ['LOGIN', 'page']), [login.runId]);
  assert.deepEqual(store.searchRuns(cwd, ['login', 'nothing']), []);
  assert.deepEqual(store.searchRuns(cwd, ['100%']), []);
  const detail = historyLookup(store, cwd, { runId: login.runId });
  assert.match(detail, new RegExp(`^#${login.runId} `));
  assert.match(detail, /요청: make a\.txt for the login page/);
  assert.match(detail, /작업 요약: s/);
  assert.match(detail, /요구사항 결과: R1 done/);
  assert.match(historyLookup(store, cwd, { runId: other.id }), /not a finished run of this project/);
  assert.match(historyLookup(store, cwd, { search: 'login' }), /login page/);
  assert.match(historyLookup(store, cwd, { search: 'payment' }), /No earlier run matches "payment"\. The search matches plain text: try the other language[\s\S]*Recent runs:\n- #/);
  // Words that only appear in the stored report (the work summary "s") are found too, and a partial match falls back to "any".
  assert.deepEqual(store.searchRuns(cwd, ['R1']), [login.runId]);
  assert.match(historyLookup(store, cwd, { search: '로그인 login' }), /No run contains all of "로그인 login"; these contain some of the words:[\s\S]*login page/);
  assert.deepEqual(store.searchRuns(cwd, ['로그인', 'login', 'page'], 5, 'any'), [login.runId]);
  store.close();
});

test('last models: the model each runtime last ran on, through the role to runtime mapping', async () => {
  const store = new RunStore(':memory:');
  const cwd = tmp();
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ model: 'gpt-lead' }, { report: { ...classify, requirements: [{ id: 'R1', text: 'make a.txt', quote: 'make a.txt' }] } }])], builder: [script([{ model: 'gpt-build' }, write('a.txt'), { report: builder }])] } });
  const runId = store.startRun(cwd, 'make a.txt');
  const result = await runRequest('make a.txt', { cwd, runtime, review: 'never', onEvent: store.recorder(runId) });
  store.finishRun(runId, 'make a.txt', result);
  store.setSettings(runId, { runtimes: { lead: 'codex', builder: 'claude' } });
  assert.deepEqual(store.lastModels(), { codex: 'gpt-lead', claude: 'gpt-build' });
  store.close();
});
