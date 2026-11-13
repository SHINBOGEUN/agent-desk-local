import { fileURLToPath } from 'node:url';
import type { ToolRegistration } from './endpoint.ts';

export { TOOL_DEFINITIONS, TOOL_NAMES } from './tool-definitions.ts';
export type { ToolDefinition, ToolName } from './tool-definitions.ts';
export { handleMcpLine, runStdioServer } from './stdio-server.ts';
export type { McpServerOptions, ToolBridge, ToolCallOutcome } from './stdio-server.ts';
export { ENV_TOKEN, ENV_URL, ToolEndpoint, dispatchTool } from './endpoint.ts';
export type { ToolRegistration } from './endpoint.ts';
export { ReportCollector } from './report-tool.ts';

export interface McpServerCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** What a runtime needs to start the stdio MCP server for one session. */
export function mcpServerCommand(registration: ToolRegistration): McpServerCommand {
  return { command: process.execPath, args: [fileURLToPath(new URL('./bin.ts', import.meta.url))], env: registration.env };
}
