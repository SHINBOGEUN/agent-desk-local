import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { HarnessTools, RuntimeEvent, SessionOptions } from '#core';
import { ClaudeRuntime, TurnTranslator, buildArgs, usageFromClaude } from '#runtime-claude';
import { ReportCollector } from '#tools-mcp';

const fake = fileURLToPath(new URL('./fake-claude.ts', import.meta.url));
const runtimeWithFake = (graceMs = 10_000) => new ClaudeRuntime({ command: process.execPath, prefixArgs: [fake], interruptGraceMs: graceMs });
const options = (tools: HarnessTools, extra: Partial<SessionOptions> = {}): SessionOptions => ({ role: 'builder', cwd: process.cwd(), access: 'workspace-write', instructions: 'be brief', skills: [], tools, ...extra });
const noTools = (): HarnessTools => ({ submitReport: async () => ({ ok: true, message: '' }), requestUserInput: async () => '' });
async function collect(iterable: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
const sumUsage = (events: RuntimeEvent[]) => events.reduce((total, event) => (event.type === 'usage' ? total + event.delta.totalTokens : total), 0);

test('usage counts cache reads and writes as input', () => {
  assert.deepEqual(usageFromClaude({ input_tokens: 8, cache_creation_input_tokens: 9553, cache_read_input_tokens: 44585, output_tokens: 182, output_tokens_details: { thinking_tokens: 7 } }), { inputTokens: 54146, cachedInputTokens: 44585, outputTokens: 182, reasoningTokens: 7, totalTokens: 54328 });
  assert.equal(usageFromClaude(undefined).totalTokens, 0);
});

test('read-only sessions get only read tools; the permission prompt tool is always set', () => {
  const read = buildArgs(options(noTools(), { access: 'read-only', model: 'claude-x' }), '/tmp/mcp.json');
  assert.equal(read[read.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.equal(read[read.indexOf('--permission-prompt-tool') + 1], 'mcp__agentdesk__approve');
  assert.equal(read[read.indexOf('--model') + 1], 'claude-x');
  assert.ok(read.includes('--strict-mcp-config'));
  const write = buildArgs(options(noTools()), '/tmp/mcp.json');
  assert.match(write[write.indexOf('--tools') + 1] ?? '', /Edit,Write,Bash/);
  assert.ok(!read.includes('--model') || !write.includes('--model'));
});

test('translator: the init message reports the model once', () => {
  const translator = new TurnTranslator();
  assert.deepEqual(translator.handle({ type: 'system', subtype: 'init', model: 'claude-sonnet-x' }), [{ type: 'session_info', model: 'claude-sonnet-x' }]);
  assert.deepEqual(translator.handle({ type: 'system', subtype: 'init', model: 'claude-sonnet-x' }), []);
});

test('translator: usage is not double counted and sums to the result total', () => {
  const t = new TurnTranslator();
  const u = (output: number) => ({ input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: output });
  const events = [
    ...t.handle({ type: 'assistant', message: { id: 'a', content: [{ type: 'text', text: 'hi' }], usage: u(2) } }),
    ...t.handle({ type: 'assistant', message: { id: 'a', content: [{ type: 'text', text: 'hi again' }], usage: u(5) } }),
    ...t.finish({ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 9 } }, false),
  ];
  assert.equal(sumUsage(events), 19);
  const messages = events.filter(event => event.type === 'message') as Array<Extract<RuntimeEvent, { type: 'message' }>>;
  assert.deepEqual(messages.map(event => [event.text, event.final]), [['hi', false], ['hi again', true]]);
});

test('a normal turn: messages, final marker, usage and two turns in one process', async () => {
  const runtime = runtimeWithFake();
  const session = await runtime.startSession(options(noTools()));
  try {
    const first = await collect(session.runTurn({ text: 'hello' }, new AbortController().signal));
    assert.deepEqual(first.filter(event => event.type === 'message'), [{ type: 'message', text: 'first', final: false }, { type: 'message', text: 'second turn 1', final: true }]);
    assert.equal(sumUsage(first), 16);
    assert.deepEqual(first.at(-1), { type: 'turn_end', status: 'completed' });
    const second = await collect(session.runTurn({ text: 'again' }, new AbortController().signal));
    assert.equal((second.filter(event => event.type === 'message').at(-1) as { text: string }).text, 'second turn 2');
  } finally { await session.close(); await runtime.close(); }
});

test('tool results become command and file_change events; usage matches the result', async () => {
  const runtime = runtimeWithFake();
  const session = await runtime.startSession(options(noTools()));
  try {
    const events = await collect(session.runTurn({ text: 'run tools' }, new AbortController().signal));
    assert.deepEqual(events.filter(event => event.type === 'command'), [{ type: 'command', command: 'npm test', exitCode: 1, output: 'boom' }]);
    assert.deepEqual(events.filter(event => event.type === 'file_change'), [{ type: 'file_change', path: 'src/a.ts', kind: 'update' }]);
    assert.equal(sumUsage(events), 22 + 220 + 20 + 15);
  } finally { await session.close(); await runtime.close(); }
});

test('the model reaches report and approval tools through the real MCP server', async () => {
  const collector = new ReportCollector('classify');
  const approvals: string[] = [];
  const runtime = runtimeWithFake();
  const session = await runtime.startSession(options({ submitReport: collector.submit, requestUserInput: async () => '', approve: async request => { approvals.push(request.toolName); return { behavior: 'deny', message: 'no deletes' }; } }));
  try {
    const events = await collect(session.runTurn({ text: 'send report' }, new AbortController().signal));
    const text = (events.find(event => event.type === 'message') as { text: string }).text;
    assert.match(text, /Report rejected/);
    assert.match(text, /Report accepted/);
    assert.match(text, /deny/);
    assert.equal(collector.report?.workflow, 'answer');
    assert.deepEqual(approvals, ['Bash']);
  } finally { await session.close(); await runtime.close(); }
});

test('the CLI is started with the restricted tool list and the harness MCP config', async () => {
  const runtime = runtimeWithFake();
  const session = await runtime.startSession(options(noTools(), { access: 'read-only' }));
  try {
    const events = await collect(session.runTurn({ text: 'show args' }, new AbortController().signal));
    const argv = JSON.parse((events.find(event => event.type === 'message') as { text: string }).text) as string[];
    assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Glob,Grep');
    assert.ok(argv.includes('--permission-prompt-tool'));
  } finally { await session.close(); await runtime.close(); }
});

test('failed result, crash and abort are reported', async () => {
  const runtime = runtimeWithFake(500);
  const failed = await runtime.startSession(options(noTools()));
  const failEvents = await collect(failed.runTurn({ text: 'please fail' }, new AbortController().signal));
  assert.deepEqual(failEvents.at(-1), { type: 'turn_end', status: 'failed', error: 'Credit balance is too low' });
  await failed.close();

  const crashing = await runtime.startSession(options(noTools()));
  const crashEvents = await collect(crashing.runTurn({ text: 'crash now' }, new AbortController().signal));
  const end = crashEvents.at(-1) as Extract<RuntimeEvent, { type: 'turn_end' }>;
  assert.equal(end.status, 'failed');
  assert.match(end.error ?? '', /exited/);
  assert.equal((await collect(crashing.runTurn({ text: 'again' }, new AbortController().signal))).at(-1)?.type, 'turn_end');
  await crashing.close();

  const hanging = await runtime.startSession(options(noTools()));
  const controller = new AbortController();
  setTimeout(() => { controller.abort(); }, 150);
  assert.deepEqual((await collect(hanging.runTurn({ text: 'hang' }, controller.signal))).at(-1), { type: 'turn_end', status: 'interrupted' });
  // The harness interrupts a turn right after an accepted report and may play the next turn (same-session REDO,
  // self review) in the same session: the process must still answer.
  assert.deepEqual((await collect(hanging.runTurn({ text: 'hello again' }, new AbortController().signal))).at(-1), { type: 'turn_end', status: 'completed' });
  await hanging.close();
  await runtime.close();
});

test('doctor reports the executable version or a fix', async () => {
  const ok = await runtimeWithFake().doctor();
  assert.equal(ok.ok, true);
  assert.match(ok.checks[0]?.detail ?? '', /2\.1\.322/);
  const missing = await new ClaudeRuntime({ command: 'definitely-not-claude-xyz' }).doctor();
  assert.equal(missing.ok, false);
  assert.match(missing.checks[0]?.fix ?? '', /AGENT_DESK_CLAUDE/);
});

test('a rejected rate_limit_event marks the failed turn as a usage limit', () => {
  const t = new TurnTranslator();
  t.handle({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1790578200, rateLimitType: 'five_hour' } });
  const out = t.finish({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your session limit · resets 3:45pm" }, false);
  assert.deepEqual(out.at(-1), { type: 'turn_end', status: 'failed', error: "You've hit your session limit · resets 3:45pm [usage limit exceeded: five_hour, resets 2026-09-28T06:50:00.000Z]" });
  const fine = new TurnTranslator();
  fine.handle({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1790578200, rateLimitType: 'five_hour' } });
  assert.deepEqual(fine.finish({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' }, false).at(-1), { type: 'turn_end', status: 'failed', error: 'boom' });
});
