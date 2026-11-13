#!/usr/bin/env node
// Prototype P2 + P3 (Claude). Answers the open questions in the v2 design before
// runtime-claude is written, using the locally logged-in Claude Code CLI:
//   P2-a  one `claude -p` process accepts several turns over stream-json input
//   P2-b  a local stdio MCP tool given with --mcp-config is callable and allowed
//         only through --allowedTools (other tools stay blocked)
//   P2-c  how per-turn usage is reported (increment or running total)
//   P3-c  an in-flight turn can be interrupted without killing the process
//   P3-d  ending the CLI leaves no MCP server process behind
//
//   node scripts/proto/p2-claude.mjs [--claude <path to claude executable>] [--model <id>]
//
// Uses a few small Claude requests. Run it when no benchmark is measuring usage.
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { Checks, makeWorkspace, mcpServerPath, readLog, isAlive, waitFor, sleep, protoDirectory } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []));
const claudeCommand = args.claude || process.env.AGENT_DESK_CLAUDE || 'claude';
const workspace = makeWorkspace('p2');
const logFile = path.join(workspace, 'mcp-log.jsonl');
const transcriptFile = path.join(workspace, 'transcript.jsonl');
const mcpConfigFile = path.join(workspace, 'mcp.json');
fs.writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: { agentdesk: { command: process.execPath, args: [mcpServerPath], env: { AGENT_DESK_PROTO_LOG: logFile } } } }, null, 2));
const checks = new Checks('P2 claude');
console.log(`workspace: ${workspace}`);

const cliArgs = [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--mcp-config', mcpConfigFile, '--strict-mcp-config',
  '--allowedTools', 'mcp__agentdesk__submit_report',
  '--disallowedTools', 'Bash', 'Edit', 'Write',
  '--append-system-prompt', 'You are testing a tool integration. Follow the user instruction exactly and keep answers short.',
  ...(args.model ? ['--model', args.model] : []),
];
const child = spawn(claudeCommand, cliArgs, { cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
child.stdin.on('error', () => {});
const spawnFailed = new Promise((_, reject) => child.once('error', error => reject(new Error(`cannot start ${claudeCommand}: ${error.message}. Pass --claude <path> (see "where.exe claude") or set AGENT_DESK_CLAUDE.`))));
spawnFailed.catch(() => {});

const events = [];
const waiters = [];
createInterface({ input: child.stdout }).on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  fs.appendFileSync(transcriptFile, `${line}\n`);
  events.push(message);
  for (const waiter of [...waiters]) if (waiter.match(message)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
});
const waitEvent = (match, timeoutMs) => Promise.race([spawnFailed, new Promise((resolve, reject) => {
  const waiter = { match, resolve: value => { clearTimeout(timer); resolve(value); } };
  const timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('timed out waiting for Claude output')); }, timeoutMs);
  waiters.push(waiter);
})]);
const sendUser = text => child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`);
const resultCount = () => events.filter(event => event.type === 'result').length;
const nextResult = timeoutMs => { const seen = resultCount(); return waitEvent(event => event.type === 'result' && resultCount() > seen, timeoutMs); };

try {
  sendUser('Call the submit_report tool exactly once with summary "prototype ok" and changedFiles []. Then reply with the single word DONE.');
  const first = await nextResult(240_000);
  const init = events.find(event => event.type === 'system' && event.subtype === 'init');
  const mcpStatus = init?.mcp_servers?.find(server => server.name === 'agentdesk')?.status;
  checks.add('P2 init', !!init?.session_id, `session ${init?.session_id || 'missing'}, model ${init?.model || '?'}, MCP agentdesk status ${mcpStatus || 'unknown'}`);
  checks.add('turn 1 result', first.subtype === 'success', `subtype ${first.subtype}, is_error ${first.is_error}`);

  const log = readLog(logFile);
  const toolCalls = log.filter(entry => entry.event === 'tool_call');
  checks.add('P2-b MCP tool called', toolCalls.length >= 1 && toolCalls[0].arguments?.summary === 'prototype ok', `tool calls: ${JSON.stringify(toolCalls.map(call => call.arguments))}`);
  const tools = init?.tools || [];
  checks.add('P2-b only allowed tools usable', !tools.includes('Bash') && !tools.includes('Write') && !tools.includes('Edit'), `tools offered: ${tools.join(', ') || 'unknown'}`);

  sendUser('Reply with the single word SECOND.');
  const second = await nextResult(120_000);
  checks.add('P2-a second turn in the same process', second.subtype === 'success' && second.session_id === first.session_id, `subtype ${second.subtype}, same session ${second.session_id === first.session_id}`);
  const u1 = first.usage || {}, u2 = second.usage || {};
  const out1 = u1.output_tokens ?? 0, out2 = u2.output_tokens ?? 0;
  const looksCumulative = out2 >= out1 && out1 > 20;
  checks.add('P2-c usage per turn', !!first.usage && !!second.usage, `turn1 ${JSON.stringify(u1)} | turn2 ${JSON.stringify(u2)} | cost ${first.total_cost_usd} -> ${second.total_cost_usd} | ${looksCumulative ? 'turn 2 looks CUMULATIVE: record deltas' : 'turn 2 looks like an increment'}`);

  sendUser('Count slowly from 1 to 400, one number per line, with a short comment on each number.');
  await sleep(4_000);
  child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'proto-interrupt-1', request: { subtype: 'interrupt' } })}\n`);
  const interruptAt = Date.now();
  const interrupted = await nextResult(30_000).catch(() => null);
  checks.add('P3-c interrupt over stream-json control message', !!interrupted && child.exitCode === null, interrupted ? `result ${interrupted.subtype} after ${Date.now() - interruptAt} ms, process alive ${child.exitCode === null}` : 'no result within 30 s (fallback: end the process)');

  const mcpPids = [...new Set(readLog(logFile).filter(entry => entry.event === 'start').map(entry => entry.pid))];
  child.stdin.end();
  const exited = await waitFor(() => child.exitCode !== null, 15_000);
  if (!exited) child.kill();
  let cleaned = await waitFor(() => mcpPids.every(pid => !isAlive(pid)), 10_000);
  const leftovers = mcpPids.filter(isAlive);
  checks.add('P3-d MCP server processes exit with the CLI', cleaned, `CLI exited by itself: ${exited}; MCP pids ${mcpPids.join(', ') || 'none'} alive after: ${leftovers.join(', ') || 'none'}`);
  for (const pid of leftovers) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    else { try { process.kill(pid); } catch {} }
  }
} catch (error) {
  checks.add('prototype run', false, `${error.message}${stderr ? `\nstderr: ${stderr.slice(-800)}` : ''}`);
  child.kill();
}
checks.finish(path.join(protoDirectory, 'results', 'p2-claude.json'), { workspace, transcript: transcriptFile, mcpLog: logFile });
process.exit();
