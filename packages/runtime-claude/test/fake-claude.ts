// A stand-in for `claude -p --input-format stream-json --output-format stream-json`.
// Behaviour is chosen by words in the user's prompt. For "report" it starts the
// real MCP server from --mcp-config and calls submit_report and approve.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('2.1.322 (Claude Code)\n'); process.exit(0); }
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
let interrupt: (() => void) | null = null;
let n = 0;

const usage = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({ input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: output, output_tokens_details: { thinking_tokens: 0 } });
const assistant = (id: string, content: unknown[], u: unknown) => send({ type: 'assistant', session_id: 's1', message: { id, role: 'assistant', content, usage: u } });
const result = (extra: Record<string, unknown>) => send({ type: 'result', subtype: 'success', is_error: false, session_id: 's1', ...extra });

async function callMcp(calls: Array<{ name: string; arguments: unknown }>): Promise<string[]> {
  const config = JSON.parse(fs.readFileSync(argv[argv.indexOf('--mcp-config') + 1]!, 'utf8')).mcpServers.agentdesk;
  const child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const rpc = async (id: number, method: string, params?: unknown) => { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); return JSON.parse((await lines.next()).value as string); };
  await rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
  const texts: string[] = [];
  let id = 2;
  for (const call of calls) texts.push((await rpc(id++, 'tools/call', call)).result.content[0].text as string);
  child.stdin.end();
  return texts;
}

async function play(text: string) {
  n++;
  send({ type: 'system', subtype: 'init', session_id: 's1', model: 'fake', tools: [] });
  if (text.includes('hang')) { await new Promise<void>(resolve => { interrupt = resolve; }); return result({ subtype: 'error_during_execution', is_error: true, usage: usage(1, 0, 0, 1) }); }
  if (text.includes('crash')) process.exit(3);
  if (text.includes('fail')) return result({ subtype: 'success', is_error: true, result: 'Credit balance is too low', usage: usage(1, 0, 0, 0) });
  if (text.includes('args')) { assistant('m1', [{ type: 'text', text: JSON.stringify(argv) }], usage(5, 0, 0, 3)); return result({ result: 'args', usage: usage(5, 0, 0, 3) }); }
  if (text.includes('tools')) {
    assistant('m1', [{ type: 'text', text: 'running tests' }, { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'npm test' } }], usage(10, 100, 20, 5));
    send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', is_error: true, content: [{ type: 'text', text: 'boom' }] }] } });
    assistant('m2', [{ type: 'tool_use', id: 'u2', name: 'Edit', input: { file_path: 'src/a.ts' } }], usage(12, 120, 0, 8));
    send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u2', content: 'ok' }] } });
    assistant('m2', [{ type: 'text', text: 'all done' }], usage(12, 120, 0, 9));
    return result({ result: 'all done', usage: usage(22, 220, 20, 15) });
  }
  if (text.includes('report')) {
    const texts = await callMcp([
      { name: 'submit_report', arguments: { workflow: 'nope' } },
      { name: 'submit_report', arguments: { workflow: 'answer', requirements: [], reason: 'q' } },
      { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'rm -rf x' }, tool_use_id: 'u9' } },
    ]);
    assistant('m1', [{ type: 'text', text: texts.map(t => t.slice(0, 60)).join(' | ') }], usage(4, 0, 0, 4));
    return result({ result: 'x', usage: usage(4, 0, 0, 4) });
  }
  assistant('m1', [{ type: 'text', text: 'first' }], usage(5, 0, 0, 2));
  assistant('m2', [{ type: 'text', text: `second turn ${n}` }], usage(6, 0, 0, 3));
  return result({ result: `second turn ${n}`, usage: usage(11, 0, 0, 5) });
}

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'control_request' && message.request?.subtype === 'interrupt') { interrupt?.(); return; }
  if (message.type === 'user') void play(message.message.content[0].text);
});
