import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeRuntime } from '#runtime-fake';
import type { HarnessTools, RuntimeEvent, Session, SessionOptions } from '#core';

const workspace = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fake-runtime-'));

function toolsRecorder() {
  const reports: unknown[] = [];
  const questions: string[] = [];
  const tools: HarnessTools = {
    async submitReport(report) { reports.push(report); return { ok: true, message: 'accepted' }; },
    async requestUserInput(question) { questions.push(question.question); return '예'; },
  };
  return { tools, reports, questions };
}

const options = (cwd: string, tools: HarnessTools, role: SessionOptions['role'] = 'builder'): SessionOptions => ({ role, cwd, access: 'workspace-write', instructions: 'test', skills: [], tools });

async function collect(session: Session, signal = new AbortController().signal): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of session.runTurn({ text: 'go' }, signal)) events.push(event);
  return events;
}

test('plays a scripted turn: messages, commands, file changes, usage and a report', async () => {
  const cwd = workspace();
  const recorder = toolsRecorder();
  const runtime = new FakeRuntime({ scripts: { builder: [{ turns: [[
    { message: '수정합니다' },
    { writeFile: { path: 'src/app.mjs', content: 'fixed' } },
    { command: 'npm test', exitCode: 0, output: 'pass' },
    { usage: { inputTokens: 900, cachedInputTokens: 600, outputTokens: 100 } },
    { report: { summary: 'done' } },
    { message: '완료', final: true },
  ]] }] } });
  const session = await runtime.startSession(options(cwd, recorder.tools));
  const events = await collect(session);
  assert.deepEqual(events.map(event => event.type), ['message', 'file_change', 'command', 'usage', 'message', 'turn_end']);
  assert.equal(fs.readFileSync(path.join(cwd, 'src/app.mjs'), 'utf8'), 'fixed');
  const usage = events.find(event => event.type === 'usage');
  assert.equal(usage?.type === 'usage' && usage.delta.totalTokens, 1_000);
  assert.deepEqual(recorder.reports, [{ summary: 'done' }]);
  assert.deepEqual(events.at(-1), { type: 'turn_end', status: 'completed' });
  assert.equal(runtime.turns[0]?.role, 'builder');
  assert.equal(runtime.remaining('builder'), 0);
});

test('can claim success without changing anything (the v1 false-completion case)', async () => {
  const cwd = workspace();
  const recorder = toolsRecorder();
  const runtime = new FakeRuntime({ scripts: { builder: [{ turns: [[{ report: { summary: '고쳤습니다', changedFiles: ['src/app.mjs'] } }]] }] } });
  const events = await collect(await runtime.startSession(options(cwd, recorder.tools)));
  assert.equal(events.some(event => event.type === 'file_change'), false);
  assert.equal(fs.readdirSync(cwd).length, 0);
  assert.equal(recorder.reports.length, 1);
});

test('a hanging turn ends as interrupted when aborted', async () => {
  const runtime = new FakeRuntime({ scripts: { builder: [{ turns: [[{ message: '시작' }, { hang: true }]] }] } });
  const session = await runtime.startSession(options(workspace(), toolsRecorder().tools));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const events = await collect(session, controller.signal);
  assert.deepEqual(events.at(-1), { type: 'turn_end', status: 'interrupted' });
});

test('sessions take scripts per role, turns in order, and fail loudly when scripts run out', async () => {
  const recorder = toolsRecorder();
  const runtime = new FakeRuntime({ scripts: { builder: [{ turns: [[{ message: 'turn 1' }], [{ fail: 'tests failed' }]] }], verifier: [{ turns: [[{ ask: { question: '진행할까요?' } }]] }] } });
  const builder = await runtime.startSession(options(workspace(), recorder.tools));
  assert.equal((await collect(builder))[0]?.type, 'message');
  assert.deepEqual((await collect(builder)).at(-1), { type: 'turn_end', status: 'failed', error: 'tests failed' });
  await assert.rejects(collect(builder), /has no turn 3/);
  const verifier = await runtime.startSession(options(workspace(), recorder.tools, 'verifier'));
  await collect(verifier);
  assert.deepEqual(recorder.questions, ['진행할까요?']);
  await assert.rejects(runtime.startSession(options(workspace(), recorder.tools)), /no script left for role "builder"/);
  await builder.close();
  await assert.rejects(collect(builder), /is closed/);
});

test('refuses to touch files outside the workspace', async () => {
  const runtime = new FakeRuntime({ scripts: { builder: [{ turns: [[{ writeFile: { path: '../escape.txt', content: 'x' } }]] }] } });
  const session = await runtime.startSession(options(workspace(), toolsRecorder().tools));
  await assert.rejects(collect(session), /outside the workspace/);
});

test('doctor reports a simulated broken runtime with a fix', async () => {
  const result = await new FakeRuntime({ scripts: {}, healthy: false }).doctor();
  assert.equal(result.ok, false);
  assert.ok(result.checks[0]?.fix);
});
