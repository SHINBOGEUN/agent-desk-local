#!/usr/bin/env node
// Minimal stdio MCP server used by the phase-1 prototypes. It exposes one tool,
// `submit_report`, and appends every call (and its own pid) to the log file in
// AGENT_DESK_PROTO_LOG so the prototype can verify, from outside the model,
// that the tool was really called and that the server process was cleaned up.
import fs from 'node:fs';
import { createInterface } from 'node:readline';

const logFile = process.env.AGENT_DESK_PROTO_LOG;
const log = entry => { if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`); };
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

log({ event: 'start' });
process.on('exit', () => log({ event: 'exit' }));

const tools = [{
  name: 'submit_report',
  description: 'Submit the structured result of this step to the Agent Desk harness. Call it exactly once at the end of the step.',
  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One sentence result' },
      changedFiles: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'changedFiles'],
    additionalProperties: false,
  },
  ...(process.env.AGENT_DESK_PROTO_ANNOTATE === '1' ? { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } } : {}),
}];

createInterface({ input: process.stdin }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (method === 'initialize') {
    log({ event: 'initialize', client: params?.clientInfo?.name, protocolVersion: params?.protocolVersion });
    send({ id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agent-desk-proto', version: '0.0.1' } } });
  } else if (method === 'tools/list') send({ id, result: { tools } });
  else if (method === 'tools/call') {
    log({ event: 'tool_call', name: params?.name, arguments: params?.arguments });
    if (params?.name !== 'submit_report') send({ id, result: { isError: true, content: [{ type: 'text', text: `unknown tool ${params?.name}` }] } });
    else send({ id, result: { content: [{ type: 'text', text: 'Report accepted by Agent Desk.' }] } });
  } else if (method === 'ping') send({ id, result: {} });
  else if (id !== undefined) send({ id, error: { code: -32601, message: `unsupported method ${method}` } });
});
process.stdin.on('end', () => process.exit(0));
