// Entry point of the MCP server process that Codex or Claude starts. It has no
// state of its own: every tool call is forwarded to the harness endpoint named
// by AGENT_DESK_TOOLS_URL, authenticated with AGENT_DESK_TOOLS_TOKEN.

import { ENV_TOKEN, ENV_URL } from './endpoint.ts';
import { runStdioServer } from './stdio-server.ts';
import type { ToolBridge, ToolCallOutcome } from './stdio-server.ts';
import { TOOL_DEFINITIONS } from './tool-definitions.ts';

const url = process.env[ENV_URL];
const token = process.env[ENV_TOKEN];
if (!url || !token) {
  process.stderr.write(`agent-desk tools: ${ENV_URL} and ${ENV_TOKEN} must be set\n`);
  process.exit(2);
}

const bridge: ToolBridge = {
  async call(name, args): Promise<ToolCallOutcome> {
    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ tool: name, arguments: args }) });
    } catch {
      return { text: 'The Agent Desk harness is not reachable. Stop and report that you could not submit.', isError: true };
    }
    if (!response.ok) return { text: `The harness rejected the call (HTTP ${response.status}).`, isError: true };
    return (await response.json()) as ToolCallOutcome;
  },
};

await runStdioServer({ name: 'agent-desk-tools', version: '0.2.0', tools: TOOL_DEFINITIONS, bridge }, process.stdin, process.stdout);
