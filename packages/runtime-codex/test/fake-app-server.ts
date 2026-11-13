// A stand-in for `codex app-server --stdio`, driven by the prompt text of each
// turn. For "report" it starts the real MCP server from the thread config and
// calls it over stdio, exactly like Codex would.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method: string, params: unknown) => send({ method, params });
let config: Record<string, unknown> = {};
let turnCounter = 0;
let nextServerRequest = 1000;
const serverRequests = new Map<number, (result: unknown) => void>();
let interruptTurn: (() => void) | null = null;

function usage(total: number) {
  notify('thread/tokenUsage/updated', { threadId: 't1', tokenUsage: { last: { inputTokens: total - 5, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 1, totalTokens: total }, total: { totalTokens: total } } });
}

async function callMcp(report: unknown): Promise<string> {
  const command = config['mcp_servers.agentdesk.command'] as string;
  const args = config['mcp_servers.agentdesk.args'] as string[];
  const env = config['mcp_servers.agentdesk.env'] as Record<string, string>;
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const rpc = async (id: number, method: string, params?: unknown) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return JSON.parse((await lines.next()).value as string);
  };
  await rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
  const called = await rpc(2, 'tools/call', { name: 'submit_report', arguments: report });
  child.stdin.end();
  return called.result.content[0].text as string;
}

async function playTurn(turnId: string, text: string) {
  notify('turn/started', { threadId: 't1', turn: { id: turnId } });
  const done = (status: string, error?: string) => notify('turn/completed', { threadId: 't1', turn: { id: turnId, status, ...(error ? { error: { message: error } } : {}) } });
  if (text.includes('hang')) {
    await new Promise<void>(resolve => { interruptTurn = resolve; });
    return done('interrupted');
  }
  if (text.includes('crash')) process.exit(3);
  if (text.includes('fail')) return done('failed', 'model refused');
  if (text.includes('report')) {
    const bad = await callMcp({ workflow: 'nope' });
    const good = await callMcp({ workflow: 'answer', requirements: [], reason: 'q' });
    notify('item/completed', { threadId: 't1', turnId, item: { type: 'agentMessage', text: `tool results: ${bad.slice(0, 15)} | ${good}`, phase: 'final_answer' } });
  } else if (text.includes('command')) {
    notify('item/completed', { threadId: 't1', turnId, item: { type: 'commandExecution', command: 'npm test', exitCode: 1, aggregatedOutput: 'boom', status: 'completed' } });
    notify('item/completed', { threadId: 't1', turnId, item: { type: 'fileChange', status: 'completed', changes: [{ path: 'a.txt', kind: { type: 'add' } }, { path: 'b.txt', kind: { type: 'update' } }, { path: 'c.txt', kind: { type: 'delete' } }] } });
  } else if (text.includes('approve')) {
    const id = nextServerRequest++;
    const answer = await new Promise<unknown>(resolve => { serverRequests.set(id, resolve); send({ id, method: 'item/commandExecution/requestApproval', params: { itemId: 'i1', command: 'rm -rf /' } }); });
    notify('item/completed', { threadId: 't1', turnId, item: { type: 'agentMessage', text: `decision ${JSON.stringify(answer)}`, phase: 'final_answer' } });
  } else {
    notify('item/completed', { threadId: 't1', turnId, item: { type: 'agentMessage', text: `echo: ${text}`, phase: 'final_answer' } });
  }
  usage(100 + turnCounter);
  done('completed');
}

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === undefined && message.id !== undefined) { serverRequests.get(message.id)?.(message.result); return; }
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake-codex/0' } });
  else if (message.method === 'account/rateLimits/read') send({ id: message.id, result: { rateLimitsByLimitId: { codex: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1800000000 } } } } });
  else if (message.method === 'thread/start') {
    config = message.params.config;
    send({ id: message.id, result: { thread: { id: 't1' }, echo: { sandbox: message.params.sandbox, approvalPolicy: message.params.approvalPolicy, developerInstructions: message.params.developerInstructions, model: message.params.model } } });
    notify('fake/threadStarted', message.params);
  } else if (message.method === 'turn/start') {
    const turnId = `turn${++turnCounter}`;
    send({ id: message.id, result: { turn: { id: turnId } } });
    const text = (message.params.input as { text?: string }[]).map(part => part.text ?? '').join(' ');
    void playTurn(turnId, text);
  } else if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    interruptTurn?.();
  }
});
process.stdin.on('end', () => process.exit(0));
