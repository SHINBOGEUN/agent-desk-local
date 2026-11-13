import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { HarnessTools, RuntimeEvent, SessionOptions } from '#core';
import { CodexRuntime, eventsFromNotification, usageFromCodex } from '#runtime-codex';
import { ReportCollector } from '#tools-mcp';

const fakeServer = fileURLToPath(new URL('./fake-app-server.ts', import.meta.url));

function runtimeWithFake(): CodexRuntime {
  return new CodexRuntime({ command: process.execPath, serverArgs: [fakeServer] });
}

function options(tools: HarnessTools, extra: Partial<SessionOptions> = {}): SessionOptions {
  return { role: 'builder', cwd: process.cwd(), access: 'workspace-write', instructions: 'be brief', skills: [], tools, ...extra };
}

async function collect(iterable: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const noTools = (): HarnessTools => ({ submitReport: async () => ({ ok: true, message: '' }), requestUserInput: async () => '' });

test('usage and notification translation', () => {
  assert.deepEqual(usageFromCodex({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 3, reasoningOutputTokens: 2, totalTokens: 13 }), { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3, reasoningTokens: 2, totalTokens: 13 });
  assert.equal(usageFromCodex({ inputTokens: 5, outputTokens: 1 }).totalTokens, 6);
  assert.deepEqual(eventsFromNotification({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { totalTokens: 9 } } } }), []);
  assert.deepEqual(eventsFromNotification({ method: 'item/started', params: { item: { type: 'agentMessage' } } }), []);
});

test('a turn streams message, usage and completion', async () => {
  const runtime = runtimeWithFake();
  const session = await runtime.startSession(options(noTools(), { model: 'gpt-x' }));
  try {
    const events = await collect(session.runTurn({ text: 'hello' }, new AbortController().signal));
    assert.deepEqual(events.map(event => event.type), ['message', 'usage', 'turn_end']);
    assert.deepEqual(events[0], { type: 'message', text: 'echo: hello', final: true });
    const usage = events[1] as Extract<RuntimeEvent, { type: 'usage' }>;
    assert.equal(usage.delta.totalTokens, 101);
    assert.equal(usage.delta.reasoningTokens, 1);
    assert.deepEqual(events[2], { type: 'turn_end', status: 'completed' });
    const second = await collect(session.runTurn({ text: 'again' }, new AbortController().signal));
    assert.equal((second[1] as Extract<RuntimeEvent, { type: 'usage' }>).delta.totalTokens, 102);
  } finally {
    await session.close();
    await runtime.close();
  }
});

test('commands and file changes become events', async () => {
  const runtime = runtimeWithFake();
  const session = await runtime.startSession(options(noTools()));
  try {
    const events = await collect(session.runTurn({ text: 'run command' }, new AbortController().signal));
    assert.deepEqual(events.slice(0, 4), [
      { type: 'command', command: 'npm test', exitCode: 1, output: 'boom' },
      { type: 'file_change', path: 'a.txt', kind: 'add' },
      { type: 'file_change', path: 'b.txt', kind: 'update' },
      { type: 'file_change', path: 'c.txt', kind: 'delete' },
    ]);
  } finally {
    await session.close();
    await runtime.close();
  }
});

test('the model reaches harness tools through the real MCP server', async () => {
  const collector = new ReportCollector('classify');
  const runtime = runtimeWithFake();
  const session = await runtime.startSession(options({ submitReport: collector.submit, requestUserInput: async () => '' }));
  try {
    const events = await collect(session.runTurn({ text: 'send report' }, new AbortController().signal));
    const message = events.find(event => event.type === 'message') as Extract<RuntimeEvent, { type: 'message' }>;
    assert.match(message.text, /Report rejected/);
    assert.match(message.text, /Report accepted/);
    assert.equal(collector.invalidAttempts, 1);
    assert.equal(collector.report?.workflow, 'answer');
  } finally {
    await session.close();
    await runtime.close();
  }
});

test('server approval requests are surfaced and declined', async () => {
  const runtime = runtimeWithFake();
  const session = await runtime.startSession(options(noTools()));
  try {
    const events = await collect(session.runTurn({ text: 'please approve' }, new AbortController().signal));
    const approval = events.find(event => event.type === 'approval_request') as Extract<RuntimeEvent, { type: 'approval_request' }>;
    assert.equal(approval.kind, 'item/commandExecution/requestApproval');
    const message = events.find(event => event.type === 'message') as Extract<RuntimeEvent, { type: 'message' }>;
    assert.equal(message.text, 'decision {"decision":"decline"}');
  } finally {
    await session.close();
    await runtime.close();
  }
});

test('abort interrupts a hanging turn', async () => {
  const runtime = runtimeWithFake();
  const session = await runtime.startSession(options(noTools()));
  try {
    const controller = new AbortController();
    setTimeout(() => { controller.abort(); }, 150);
    const events = await collect(session.runTurn({ text: 'hang' }, controller.signal));
    assert.deepEqual(events.at(-1), { type: 'turn_end', status: 'interrupted' });
  } finally {
    await session.close();
    await runtime.close();
  }
});

test('failed turns and a crashed server end as failed', async () => {
  const runtime = runtimeWithFake();
  const failing = await runtime.startSession(options(noTools()));
  try {
    const events = await collect(failing.runTurn({ text: 'fail' }, new AbortController().signal));
    assert.deepEqual(events.at(-1), { type: 'turn_end', status: 'failed', error: 'model refused' });
  } finally { await failing.close(); }
  const crashing = await runtime.startSession(options(noTools()));
  try {
    const events = await collect(crashing.runTurn({ text: 'crash' }, new AbortController().signal));
    const end = events.at(-1) as Extract<RuntimeEvent, { type: 'turn_end' }>;
    assert.equal(end.status, 'failed');
    assert.match(end.error ?? '', /exited/);
    const after = await collect(crashing.runTurn({ text: 'hello' }, new AbortController().signal));
    assert.equal((after.at(-1) as Extract<RuntimeEvent, { type: 'turn_end' }>).status, 'failed');
  } finally { await crashing.close(); await runtime.close(); }
});

test('doctor reports a missing executable with a fix', async () => {
  const missing = await new CodexRuntime({ command: 'definitely-not-codex-xyz' }).doctor();
  assert.equal(missing.ok, false);
  assert.ok(missing.checks[0]?.fix);
  const present = await new CodexRuntime({ command: process.execPath }).doctor();
  assert.equal(present.ok, true);
});

test('startSession fails cleanly when the executable is missing', async () => {
  const runtime = new CodexRuntime({ command: 'definitely-not-codex-xyz' });
  await assert.rejects(runtime.startSession(options(noTools())), /cannot start Codex|not running/);
  await runtime.close();
});
