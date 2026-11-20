import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { HarnessTools, RuntimeEvent, SessionOptions } from '#core';
import { CodexRuntime, eventsFromNotification, findModel, modelsFromList, usageFromCodex, usageTotalOf } from '#runtime-codex';
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
  const update = (total: number) => ({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { last: { inputTokens: 10, outputTokens: 1 }, total: { totalTokens: total } } } });
  assert.equal(usageTotalOf(update(13106)), 13106);
  // The model a thread runs on is reported once Codex applies the thread settings.
  assert.deepEqual(eventsFromNotification({ method: 'thread/settings/updated', params: { threadId: 't', threadSettings: { model: 'gpt-x', cwd: 'D:/p' } } }), [{ type: 'session_info', model: 'gpt-x' }]);
  assert.deepEqual(eventsFromNotification({ method: 'thread/settings/updated', params: { threadId: 't' } }), []);
  assert.equal(findModel({ a: { b: { model: 'deep' } } }), 'deep');
  assert.deepEqual(modelsFromList({ data: [{ id: 'm1', model: 'gpt-a', displayName: 'GPT A', isDefault: true }, { id: 'm2', model: 'gpt-b' }, { nothing: 1 }] }), [{ id: 'gpt-a', label: 'GPT A', isDefault: true }, { id: 'gpt-b', label: 'gpt-b', isDefault: false }]);
  assert.deepEqual(modelsFromList(null), []);
  // Every other item is recorded by name, so each model call can be accounted for.
  assert.deepEqual(eventsFromNotification({ method: 'item/started', params: { item: { type: 'mcpToolCall', server: 'agentdesk', tool: 'submit_report' } } }), [{ type: 'tool', name: 'mcpToolCall:agentdesk/submit_report' }]);
  assert.deepEqual(eventsFromNotification({ method: 'item/started', params: { item: { type: 'reasoning' } } }), [{ type: 'tool', name: 'reasoning' }]);
  assert.deepEqual(eventsFromNotification({ method: 'item/started', params: { item: { type: 'commandExecution' } } }), []);
  assert.deepEqual(eventsFromNotification({ method: 'item/completed', params: { item: { type: 'mcpToolCall' } } }), []);
  assert.equal(usageTotalOf({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { last: { inputTokens: 1 } } } }), null);
  assert.equal(usageTotalOf({ method: 'item/completed', params: {} }), null);
});

test('a turn streams message, usage and completion', async () => {
  const runtime = runtimeWithFake();
  const session = await runtime.startSession(options(noTools(), { model: 'gpt-x' }));
  try {
    // The fake server's own "fake/threadStarted" notice shows up as a tool event; leave it out here.
    const events = (await collect(session.runTurn({ text: 'hello' }, new AbortController().signal))).filter(event => event.type !== 'tool');
    assert.deepEqual(events.map(event => event.type), ['message', 'usage', 'turn_end']);
    assert.deepEqual(events[0], { type: 'message', text: 'echo: hello', final: true });
    const usage = events[1] as Extract<RuntimeEvent, { type: 'usage' }>;
    assert.equal(usage.delta.totalTokens, 101);
    assert.equal(usage.delta.reasoningTokens, 1);
    assert.deepEqual(events[2], { type: 'turn_end', status: 'completed' });
    const second = await collect(session.runTurn({ text: 'again' }, new AbortController().signal));
    assert.equal((second[1] as Extract<RuntimeEvent, { type: 'usage' }>).delta.totalTokens, 102);
    // A repeated update with an unchanged thread total is the same model call, counted once.
    const repeated = await collect(session.runTurn({ text: 'repeat-usage' }, new AbortController().signal));
    assert.equal(repeated.filter(event => event.type === 'usage').length, 1);
    // A notification this runtime does not know is recorded once per turn.
    const noticed = await collect(session.runTurn({ text: 'plan-notice' }, new AbortController().signal));
    assert.deepEqual(noticed.filter(event => event.type === 'tool'), [{ type: 'tool', name: 'notice:turn/plan/updated' }]);
  } finally {
    await session.close();
    await runtime.close();
  }
});

test('commands and file changes become events', async () => {
  const runtime = runtimeWithFake();
  const session = await runtime.startSession(options(noTools()));
  try {
    const events = (await collect(session.runTurn({ text: 'run command' }, new AbortController().signal))).filter(event => event.type !== 'tool');
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

test('readRateLimits asks a short-lived app-server for the account limits', async () => {
  const runtime = runtimeWithFake();
  const raw = await runtime.readRateLimits() as { rateLimitsByLimitId: { codex: { primary: { usedPercent: number } } } };
  assert.equal(raw.rateLimitsByLimitId.codex.primary.usedPercent, 12);
  await runtime.close();
});

test('listModels asks a short-lived app-server for the account models', async () => {
  const runtime = runtimeWithFake();
  assert.deepEqual(await runtime.listModels(), [{ id: 'gpt-fake', label: 'GPT Fake', isDefault: true }, { id: 'gpt-fake-mini', label: 'GPT Fake Mini', isDefault: false }]);
  await runtime.close();
});

test('an older Codex that rejects omit_tools_from still starts, without it', async () => {
  process.env.FAKE_CODEX_REJECT_OMIT = '1';
  const collector = new ReportCollector('classify');
  const runtime = runtimeWithFake();
  try {
    const session = await runtime.startSession(options({ submitReport: collector.submit, requestUserInput: async () => '' }));
    try {
      await collect(session.runTurn({ text: 'send report' }, new AbortController().signal));
      assert.equal(collector.report?.workflow, 'answer');
    } finally {
      await session.close();
    }
  } finally {
    delete process.env.FAKE_CODEX_REJECT_OMIT;
    await runtime.close();
  }
});

test('a usage-limit turn keeps the error kind with the message', async () => {
  const runtime = runtimeWithFake();
  const session = await runtime.startSession(options(noTools()));
  try {
    const events = await collect(session.runTurn({ text: 'limit' }, new AbortController().signal));
    assert.deepEqual(events.at(-1), { type: 'turn_end', status: 'failed', error: "You've hit your usage limit. [usageLimitExceeded]" });
  } finally {
    await session.close();
    await runtime.close();
  }
});
