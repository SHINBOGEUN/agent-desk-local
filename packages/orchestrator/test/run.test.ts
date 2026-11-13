import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FakeRuntime } from '#runtime-fake';
import type { FakeScript } from '#runtime-fake';
import { runRequest } from '#orchestrator';
import type { RunEvent } from '#orchestrator';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orch-'));
const script = (...turns: FakeScript['turns']): FakeScript => ({ turns });
const usage = (total: number) => ({ usage: { inputTokens: total - 10, outputTokens: 10 } });

const answerReport = { workflow: 'answer', requirements: [], reason: 'plain question', answer: 'It listens on 3000.', sources: ['server.js'] };
const buildClassify = { workflow: 'build', requirements: [{ id: 'R1', text: 'add GET /api/ping returning {ok:true}' }, { id: 'R2', text: 'cover it with a test' }], reason: 'one change' };
const doneReport = { summary: 'added ping', changedFiles: ['ping.js', 'ping.test.js'], commandsRun: [{ command: 'node --test', exitCode: 0 }], requirements: [{ id: 'R1', status: 'done', evidence: 'ping.js' }, { id: 'R2', status: 'done', evidence: 'ping.test.js' }], unverified: [] };
const write = (file: string) => ({ writeFile: { path: file, content: 'x' } });

test('answer fast path: one lead session, no builder, files untouched', async () => {
  const cwd = tmp();
  const runtime = new FakeRuntime({ scripts: { lead: [script([usage(100), { report: answerReport }])], builder: [] } });
  const result = await runRequest('Which port does the server use?', { cwd, runtime });
  assert.equal(result.status, 'completed');
  assert.equal(result.workflow, 'answer');
  assert.equal(result.answer?.answer, 'It listens on 3000.');
  assert.equal(runtime.turns.length, 1);
  assert.equal(runtime.turns[0]?.options.access, 'read-only');
  assert.equal(runtime.turns[0]?.options.effort, 'low');
  assert.equal(result.usage.totalTokens, 100);
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('build workflow follows classify -> build -> report and records usage per step', async () => {
  const cwd = tmp();
  const runtime = new FakeRuntime({ scripts: { lead: [script([usage(50), { report: buildClassify }])], builder: [script([write('ping.js'), write('ping.test.js'), usage(400), { report: doneReport }])] } });
  const events: RunEvent[] = [];
  const result = await runRequest('Add a ping endpoint with a test', { cwd, runtime, onEvent: event => events.push(event) });
  assert.equal(result.status, 'completed');
  assert.equal(result.builder?.changedFiles.length, 2);
  assert.deepEqual(result.requirements.map(requirement => requirement.id), ['R1', 'R2']);
  assert.ok(fs.existsSync(path.join(cwd, 'ping.js')));
  const steps = events.filter(event => event.type === 'step_started').map(event => (event as Extract<RunEvent, { type: 'step_started' }>).step);
  assert.deepEqual(steps, ['classify', 'build', 'report']);
  assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index + 1));
  assert.equal(events.at(-1)?.type, 'run_finished');
  assert.deepEqual([...new Set(result.usageEntries.map(entry => entry.stepId))], ['classify', 'build']);
  assert.equal(result.usage.totalTokens, 450);
  assert.equal(runtime.turns[1]?.options.access, 'workspace-write');
  assert.match(runtime.turns[1]?.input.text ?? '', /R1: add GET \/api\/ping/);
  assert.equal(runtime.remaining('lead') + runtime.remaining('builder'), 0);
});

test('a rejected report is corrected inside the same turn', async () => {
  const cwd = tmp();
  const missingR2 = { ...doneReport, requirements: [doneReport.requirements[0]] };
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ report: { workflow: 'answer', requirements: [], reason: 'q' } }, { report: answerReport }])], builder: [] } });
  const result = await runRequest('q', { cwd, runtime });
  assert.equal(result.status, 'completed');
  assert.deepEqual(runtime.turns[0]?.toolResults.map(item => item.ok), [false, true]);
  assert.match(runtime.turns[0]?.toolResults[0]?.message ?? '', /report\.answer/);

  const second = new FakeRuntime({ scripts: { lead: [script([{ report: buildClassify }])], builder: [script([{ report: missingR2 }, { report: doneReport }])] } });
  const built = await runRequest('x', { cwd: tmp(), runtime: second });
  assert.equal(built.status, 'completed');
  assert.match(second.turns[1]?.toolResults[0]?.message ?? '', /missing an entry for R2/);
});

test('builder reporting open requirements ends as needs_review', async () => {
  const partial = { ...doneReport, requirements: [doneReport.requirements[0], { id: 'R2', status: 'unverified', evidence: '' }], unverified: ['test not run'] };
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ report: buildClassify }])], builder: [script([{ report: partial }])] } });
  const result = await runRequest('x', { cwd: tmp(), runtime });
  assert.equal(result.status, 'needs_review');
  assert.match(result.reason, /R2 \(unverified\)/);
});

test('a turn without a report gets one reminder, then fails', async () => {
  const reminded = new FakeRuntime({ scripts: { lead: [script([{ message: 'thinking' }], [{ report: answerReport }])], builder: [] } });
  const ok = await runRequest('q', { cwd: tmp(), runtime: reminded });
  assert.equal(ok.status, 'completed');
  assert.match(reminded.turns[1]?.input.text ?? '', /without an accepted report/);

  const silent = new FakeRuntime({ scripts: { lead: [script([{ message: 'a' }], [{ message: 'b' }])], builder: [] } });
  const failed = await runRequest('q', { cwd: tmp(), runtime: silent });
  assert.equal(failed.status, 'failed');
  assert.match(failed.reason, /twice without an accepted report/);
});

test('runtime failure, missing runtime script and unsupported workflow end as failed', async () => {
  const crash = new FakeRuntime({ scripts: { lead: [script([{ fail: 'spawn EPERM' }])], builder: [] } });
  const crashed = await runRequest('q', { cwd: tmp(), runtime: crash });
  assert.equal(crashed.status, 'failed');
  assert.equal(crashed.reason, 'spawn EPERM');

  const none = await runRequest('q', { cwd: tmp(), runtime: new FakeRuntime({ scripts: {} }) });
  assert.equal(none.status, 'failed');
  assert.match(none.reason, /no script left/);

  const plan = new FakeRuntime({ scripts: { lead: [script([{ report: { workflow: 'plan-build', requirements: [{ id: 'R1', text: 't' }], reason: 'big' } }])], builder: [] } });
  const unsupported = await runRequest('q', { cwd: tmp(), runtime: plan });
  assert.equal(unsupported.status, 'failed');
  assert.match(unsupported.reason, /plan-build/);
});

test('abort ends the run as interrupted', async () => {
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ hang: true }])], builder: [] } });
  const controller = new AbortController();
  setTimeout(() => { controller.abort(); }, 50);
  const result = await runRequest('q', { cwd: tmp(), runtime, signal: controller.signal });
  assert.equal(result.status, 'interrupted');
});

test('questions go to askUser; without it the run waits for the user', async () => {
  const asked = new FakeRuntime({ scripts: { lead: [script([{ ask: { question: 'Which database?' } }, { report: answerReport }])], builder: [] } });
  const seen: string[] = [];
  const ok = await runRequest('q', { cwd: tmp(), runtime: asked, askUser: async question => { seen.push(question.question); return 'sqlite'; } });
  assert.equal(ok.status, 'completed');
  assert.deepEqual(seen, ['Which database?']);
  assert.deepEqual(asked.turns[0]?.answers, ['sqlite']);

  const unattended = new FakeRuntime({ scripts: { lead: [script([{ ask: { question: 'Which database?' } }])], builder: [] } });
  const waiting = await runRequest('q', { cwd: tmp(), runtime: unattended });
  assert.equal(waiting.status, 'needs_user');
  assert.match(waiting.reason, /Which database\?/);
});

test('roles can use different runtimes', async () => {
  const lead = new FakeRuntime({ scripts: { lead: [script([{ report: buildClassify }])] } });
  const builder = new FakeRuntime({ scripts: { builder: [script([{ report: doneReport }])] } });
  const result = await runRequest('x', { cwd: tmp(), runtime: { lead, builder } });
  assert.equal(result.status, 'completed');
  assert.equal(lead.turns.length, 1);
  assert.equal(builder.turns.length, 1);
  const missing = await runRequest('x', { cwd: tmp(), runtime: { lead: new FakeRuntime({ scripts: { lead: [script([{ report: buildClassify }])] } }) } });
  assert.equal(missing.status, 'failed');
  assert.match(missing.reason, /no runtime configured for role "builder"/);
});
