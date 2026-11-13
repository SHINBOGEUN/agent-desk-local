import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import type { HarnessTools } from '#core';
import { ReportCollector, TOOL_DEFINITIONS, ToolEndpoint, dispatchTool, handleMcpLine, mcpServerCommand } from '#tools-mcp';
import type { ToolBridge } from '#tools-mcp';

const goodClassify = { workflow: 'answer', requirements: [], reason: '질문' };

test('collector accepts a valid report once and rejects a second', async () => {
  const collector = new ReportCollector('classify');
  assert.equal((await collector.submit(goodClassify)).ok, true);
  assert.equal(collector.report?.workflow, 'answer');
  const again = await collector.submit(goodClassify);
  assert.equal(again.ok, false);
  assert.match(again.message, /already accepted/);
});

test('collector rejects invalid reports with field paths and counts attempts', async () => {
  const collector = new ReportCollector('classify');
  const result = await collector.submit({ workflow: 'nonsense' });
  assert.equal(result.ok, false);
  assert.match(result.message, /Report rejected/);
  assert.equal(collector.report, null);
  assert.equal(collector.invalidAttempts, 1);
  assert.ok(collector.lastErrors.length > 0);
  assert.equal((await collector.submit(goodClassify)).ok, true);
});

test('collector applies consistency rules (build workflow needs requirements)', async () => {
  const collector = new ReportCollector('classify');
  const result = await collector.submit({ workflow: 'build', requirements: [], reason: 'x' });
  assert.equal(result.ok, false);
});

const bridgeStub: ToolBridge = { call: async (name, args) => ({ text: `${name}:${JSON.stringify(args)}`, isError: false }) };
const options = { name: 't', version: '1', tools: TOOL_DEFINITIONS, bridge: bridgeStub };

test('mcp handler: initialize, list, call, notification, errors', async () => {
  const init = JSON.parse((await handleMcpLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }), options))!);
  assert.equal(init.result.protocolVersion, '2024-11-05');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(await handleMcpLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), options), null);
  const list = JSON.parse((await handleMcpLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), options))!);
  assert.deepEqual(list.result.tools.map((tool: { name: string }) => tool.name), ['submit_report', 'request_user_input', 'approve']);
  const call = JSON.parse((await handleMcpLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'submit_report', arguments: { a: 1 } } }), options))!);
  assert.equal(call.result.isError, false);
  assert.equal(call.result.content[0].text, 'submit_report:{"a":1}');
  const unknown = JSON.parse((await handleMcpLine(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } }), options))!);
  assert.equal(unknown.result.isError, true);
  assert.equal(JSON.parse((await handleMcpLine('{bad', options))!).error.code, -32700);
  assert.equal(JSON.parse((await handleMcpLine(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'x/y' }), options))!).error.code, -32601);
});

function fakeTools(overrides: Partial<HarnessTools> = {}): HarnessTools {
  return { submitReport: async () => ({ ok: true, message: 'ok' }), requestUserInput: async question => `answer to ${question.question}`, ...overrides };
}

test('dispatchTool routes the three tools', async () => {
  const seen: unknown[] = [];
  const tools = fakeTools({
    submitReport: async report => { seen.push(report); return { ok: false, message: 'bad' }; },
    approve: async request => (request.toolName === 'Bash' ? { behavior: 'allow' } : { behavior: 'deny', message: 'no' }),
  });
  assert.deepEqual(await dispatchTool(tools, 'submit_report', { x: 1 }), { text: 'bad', isError: true });
  assert.deepEqual(seen, [{ x: 1 }]);
  assert.deepEqual(await dispatchTool(tools, 'request_user_input', { question: 'which?', options: ['a', 7] }), { text: 'answer to which?', isError: false });
  assert.equal((await dispatchTool(tools, 'request_user_input', {})).isError, true);
  const allow = await dispatchTool(tools, 'approve', { tool_name: 'Bash', input: { command: 'ls' } });
  assert.deepEqual(JSON.parse(allow.text), { behavior: 'allow', updatedInput: { command: 'ls' } });
  const deny = await dispatchTool(tools, 'approve', { tool_name: 'Write', input: {} });
  assert.deepEqual(JSON.parse(deny.text), { behavior: 'deny', message: 'no' });
  const noHandler = await dispatchTool(fakeTools(), 'approve', { tool_name: 'Bash', input: {} });
  assert.equal(JSON.parse(noHandler.text).behavior, 'deny');
});

async function post(url: string, token: string | null, body: unknown) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
}

test('endpoint isolates sessions by token and stops serving after dispose', async () => {
  const endpoint = await ToolEndpoint.start();
  try {
    const collectorA = new ReportCollector('classify');
    const collectorB = new ReportCollector('classify');
    const a = endpoint.register({ submitReport: collectorA.submit, requestUserInput: async () => '' });
    const b = endpoint.register({ submitReport: collectorB.submit, requestUserInput: async () => '' });
    assert.equal(endpoint.sessionCount, 2);
    assert.equal((await post(a.url, null, { tool: 'submit_report', arguments: goodClassify })).status, 401);
    assert.equal((await post(a.url, 'wrong', { tool: 'submit_report', arguments: goodClassify })).status, 401);
    const ok = await post(a.url, a.token, { tool: 'submit_report', arguments: goodClassify });
    assert.deepEqual(await ok.json(), { text: 'Report accepted.', isError: false });
    assert.ok(collectorA.report);
    assert.equal(collectorB.report, null);
    assert.equal((await post(a.url, a.token, 'not-an-object')).status, 400);
    assert.equal((await fetch(a.url)).status, 404);
    a.dispose();
    assert.equal((await post(a.url, a.token, { tool: 'submit_report', arguments: goodClassify })).status, 401);
    assert.equal((await post(b.url, b.token, { tool: 'submit_report', arguments: {} })).status, 200);
    assert.equal(endpoint.sessionCount, 1);
  } finally {
    await endpoint.close();
  }
});

test('end to end: real stdio MCP process reaches the harness', async () => {
  const endpoint = await ToolEndpoint.start();
  const collector = new ReportCollector('classify');
  const registration = endpoint.register({ submitReport: collector.submit, requestUserInput: async question => `echo:${question.question}` });
  const command = mcpServerCommand(registration);
  const child = spawn(command.command, command.args, { env: { ...process.env, ...command.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const rpc = async (id: number, method: string, params?: unknown) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const next = await lines.next();
    return JSON.parse(next.value as string);
  };
  try {
    assert.equal((await rpc(1, 'initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.name, 'agent-desk-tools');
    assert.equal((await rpc(2, 'tools/list')).result.tools.length, 3);
    const rejected = await rpc(3, 'tools/call', { name: 'submit_report', arguments: { workflow: 'zzz' } });
    assert.equal(rejected.result.isError, true);
    assert.match(rejected.result.content[0].text, /rejected/);
    const accepted = await rpc(4, 'tools/call', { name: 'submit_report', arguments: goodClassify });
    assert.equal(accepted.result.isError, false);
    assert.ok(collector.report);
    const asked = await rpc(5, 'tools/call', { name: 'request_user_input', arguments: { question: 'hi' } });
    assert.equal(asked.result.content[0].text, 'echo:hi');
    registration.dispose();
    const gone = await rpc(6, 'tools/call', { name: 'submit_report', arguments: goodClassify });
    assert.equal(gone.result.isError, true);
    child.stdin.end();
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
  } finally {
    child.kill();
    await endpoint.close();
  }
});

test('bin exits with an error when the environment is missing', async () => {
  const command = mcpServerCommand({ url: '', token: '', env: {}, dispose() {} });
  const env = { ...process.env };
  delete env.AGENT_DESK_TOOLS_URL;
  delete env.AGENT_DESK_TOOLS_TOKEN;
  const child = spawn(command.command, command.args, { env, stdio: ['ignore', 'ignore', 'ignore'] });
  const [code] = await once(child, 'exit');
  assert.equal(code, 2);
});
