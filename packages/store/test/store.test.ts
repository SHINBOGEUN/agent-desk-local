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
const classify = { workflow: 'build', requirements: [{ id: 'R1', text: 'make a.txt' }], reason: 'one file' };
const builder = { summary: 's', changedFiles: ['a.txt'], commandsRun: [], requirements: [{ id: 'R1', status: 'done', evidence: 'a.txt' }], unverified: [] };

async function storedRun(store: RunStore, cwd: string, request: string, previousBrief?: string) {
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ usage: { inputTokens: 60, cachedInputTokens: 10, outputTokens: 10 } }, { report: classify }])], builder: [script([write('a.txt'), { usage: { inputTokens: 300, cachedInputTokens: 100, outputTokens: 50 } }, { report: builder }])] } });
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
  assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3);
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
