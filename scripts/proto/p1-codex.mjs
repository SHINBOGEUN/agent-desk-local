#!/usr/bin/env node
// Prototype P1 + P3 (Codex). Answers the open questions in the v2 design before
// runtime-codex is written:
//   P1-a  a thread can attach a local stdio MCP server through thread config
//   P1-b  the model can call that MCP tool from a read-only sandbox
//   P1-c  thread/tokenUsage/updated carries a per-turn `last` that sums to `total`
//   P3-a  turn/interrupt stops a long turn
//   P3-b  closing the app-server leaves no MCP server process behind
//
//   node scripts/proto/p1-codex.mjs [--codex <path to codex.exe>] [--model <id>]
//
// Uses a few Codex requests (small prompts, low effort). Run it when no
// benchmark is measuring account usage.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { Checks, makeWorkspace, mcpServerPath, readLog, isAlive, waitFor, sleep, protoDirectory } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []));
const codexCommand = args.codex || process.env.AGENT_DESK_CODEX || 'codex';
const workspace = makeWorkspace('p1');
const logFile = path.join(workspace, 'mcp-log.jsonl');
const transcriptFile = path.join(workspace, 'transcript.jsonl');
const checks = new Checks('P1 codex');
console.log(`workspace: ${workspace}`);

const child = spawn(codexCommand, ['app-server', '--stdio', '-c', 'agents.enabled=false'], { cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
const spawnFailed = new Promise((_, reject) => child.once('error', error => reject(new Error(`cannot start ${codexCommand}: ${error.message}. Pass --codex <path to codex.exe> or set AGENT_DESK_CODEX.`))));
spawnFailed.catch(() => {});
child.stdin.on('error', () => {});
child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
const pending = new Map();
const notifications = [];
const waiters = [];
let nextId = 1;
const transcript = entry => fs.appendFileSync(transcriptFile, `${JSON.stringify(entry)}\n`);
const write = message => { transcript({ dir: 'out', ...message }); child.stdin.write(`${JSON.stringify(message)}\n`); };

createInterface({ input: child.stdout }).on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  transcript({ dir: 'in', ...message });
  if ('id' in message && message.method) {
    // Server -> client request: approvals and elicitations. Accept for the prototype, but record them.
    notifications.push({ serverRequest: message.method, params: message.params });
    if (message.method === 'mcpServer/elicitation/request') write({ id: message.id, result: { action: 'accept', content: {} } });
    else if (message.method === 'item/permissions/requestApproval') write({ id: message.id, result: { permissions: message.params?.permissions || {}, scope: 'turn' } });
    else write({ id: message.id, result: { decision: 'accept' } });
  } else if ('id' in message) {
    const waiter = pending.get(message.id); pending.delete(message.id);
    if (waiter) message.error ? waiter.reject(new Error(message.error.message || JSON.stringify(message.error))) : waiter.resolve(message.result);
  } else if (message.method) {
    notifications.push(message);
    for (const waiter of [...waiters]) if (waiter.match(message)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
  }
});
const request = (method, params, timeoutMs = 60_000) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
  pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
  write({ id, method, params });
});
const waitNotification = (match, timeoutMs) => new Promise((resolve, reject) => {
  const existing = notifications.find(item => item.method && match(item));
  if (existing) { resolve(existing); return; }
  const waiter = { match, resolve: value => { clearTimeout(timer); resolve(value); } };
  const timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('timed out waiting for notification')); }, timeoutMs);
  waiters.push(waiter);
});

async function runTurn(threadId, text, { effort = 'low', timeoutMs = 240_000 } = {}) {
  const started = await request('turn/start', { threadId, input: [{ type: 'text', text }], effort });
  const turnId = started?.turn?.id;
  const completed = await waitNotification(item => item.method === 'turn/completed' && item.params?.threadId === threadId && (!turnId || item.params?.turn?.id === turnId), timeoutMs);
  return { turnId, completed };
}

try {
  const info = await Promise.race([spawnFailed, request('initialize', { clientInfo: { name: 'agent_desk_proto', title: 'Agent Desk prototype', version: '0.0.1' }, capabilities: { experimentalApi: true } })]);
  write({ method: 'initialized', params: {} });
  checks.add('connect', true, `app-server ${info?.userAgent || 'connected'}`);

  const config = {
    'agents.enabled': false,
    'features.apps': false,
    'features.plugins': false,
    'features.memories': false,
    'mcp_servers.agentdesk.command': process.execPath,
    'mcp_servers.agentdesk.args': [mcpServerPath],
    'mcp_servers.agentdesk.env': { AGENT_DESK_PROTO_LOG: logFile },
  };
  const thread = await request('thread/start', { cwd: workspace, ...(args.model ? { model: args.model } : {}), ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', developerInstructions: 'You are testing a tool integration. Follow the user instruction exactly and keep answers short.', config });
  const threadId = thread.thread.id;

  const first = await runTurn(threadId, 'Call the submit_report tool exactly once with summary "prototype ok" and changedFiles []. Then reply with the single word DONE.');
  checks.add('turn completes', first.completed.params?.turn?.status === 'completed', `turn status ${first.completed.params?.turn?.status}`);

  const log = readLog(logFile);
  const toolCalls = log.filter(entry => entry.event === 'tool_call');
  checks.add('P1-a MCP server attached via thread config', log.some(entry => entry.event === 'initialize'), `MCP server initialize seen: ${log.some(entry => entry.event === 'initialize')}`);
  checks.add('P1-b MCP tool called from read-only sandbox', toolCalls.length >= 1 && toolCalls[0].arguments?.summary === 'prototype ok', `tool calls: ${JSON.stringify(toolCalls.map(call => call.arguments))}`);
  const approvalRequests = notifications.filter(item => item.serverRequest).map(item => item.serverRequest);
  checks.add('P1-b approvals needed for MCP', true, approvalRequests.length ? `server requests: ${approvalRequests.join(', ')} (harness must answer these)` : 'none');

  await runTurn(threadId, 'Reply with the single word SECOND.');
  const usage = notifications.filter(item => item.method === 'thread/tokenUsage/updated' && item.params?.threadId === threadId).map(item => item.params.tokenUsage);
  const lastSum = usage.reduce((sum, entry) => sum + (entry.last?.totalTokens || 0), 0);
  const finalTotal = usage.at(-1)?.total?.totalTokens ?? 0;
  checks.add('P1-c per-turn usage (last) present', usage.length >= 2 && usage.every(entry => entry.last), `${usage.length} usage updates, last present: ${usage.every(entry => entry.last)}`);
  checks.add('P1-c sum(last) == total', usage.length && lastSum === finalTotal, `sum(last)=${lastSum}, total=${finalTotal}${lastSum !== finalTotal ? ' (record per-turn deltas from total instead)' : ''}`);

  const long = await request('turn/start', { threadId, input: [{ type: 'text', text: 'Count slowly from 1 to 400, one number per line, with a short comment on each number.' }], effort: 'low' });
  const longTurnId = long?.turn?.id;
  await sleep(3_000);
  const interruptAt = Date.now();
  await request('turn/interrupt', { threadId, turnId: longTurnId }, 15_000).catch(error => checks.add('P3-a interrupt request', false, error.message));
  const stopped = await waitNotification(item => item.method === 'turn/completed' && item.params?.turn?.id === longTurnId, 30_000).catch(() => null);
  checks.add('P3-a turn/interrupt stops a long turn', stopped?.params?.turn?.status === 'interrupted', stopped ? `status ${stopped.params.turn.status} after ${Date.now() - interruptAt} ms` : 'no turn/completed within 30 s');

  const mcpPids = [...new Set(readLog(logFile).filter(entry => entry.event === 'start').map(entry => entry.pid))];
  child.stdin.end();
  await waitFor(() => child.exitCode !== null, 5_000);
  if (child.exitCode === null) child.kill();
  const cleaned = await waitFor(() => mcpPids.every(pid => !isAlive(pid)), 10_000);
  checks.add('P3-b MCP server processes exit with app-server', cleaned, `MCP pids ${mcpPids.join(', ') || 'none'} alive after close: ${mcpPids.filter(isAlive).join(', ') || 'none'}`);
} catch (error) {
  checks.add('prototype run', false, `${error.message}${stderr ? `\nstderr: ${stderr.slice(-800)}` : ''}`);
  child.kill();
}
checks.finish(path.join(protoDirectory, 'results', 'p1-codex.json'), { workspace, transcript: transcriptFile, mcpLog: logFile });
process.exit();
