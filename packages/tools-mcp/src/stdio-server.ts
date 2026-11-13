// A minimal MCP server over stdio (newline-delimited JSON-RPC 2.0). It only
// speaks the part of MCP the harness needs: initialize, tools/list, tools/call
// and ping. Calls are forwarded to a ToolBridge, which reaches the harness.

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { ToolDefinition } from './tool-definitions.ts';

export interface ToolCallOutcome {
  text: string;
  isError: boolean;
}

export interface ToolBridge {
  call(name: string, args: unknown): Promise<ToolCallOutcome>;
}

export interface McpServerOptions {
  name: string;
  version: string;
  tools: readonly ToolDefinition[];
  bridge: ToolBridge;
}

type JsonRpcId = string | number | null;

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

function failure(id: JsonRpcId, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

function success(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Handles one incoming line. Returns the response line, or null when no
 * response is due (notifications).
 */
export async function handleMcpLine(line: string, options: McpServerOptions): Promise<string | null> {
  let message: unknown;
  try { message = JSON.parse(line); } catch { return failure(null, -32700, 'Parse error'); }
  if (!isRecord(message) || typeof message.method !== 'string') return failure(null, -32600, 'Invalid request');

  const { method } = message;
  const hasId = 'id' in message && (typeof message.id === 'string' || typeof message.id === 'number');
  const id: JsonRpcId = hasId ? (message.id as string | number) : null;
  if (!hasId) return null; // notifications such as notifications/initialized

  const params = isRecord(message.params) ? message.params : {};
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION;
    return success(id, { protocolVersion: requested, capabilities: { tools: {} }, serverInfo: { name: options.name, version: options.version } });
  }
  if (method === 'ping') return success(id, {});
  if (method === 'tools/list') return success(id, { tools: options.tools });
  if (method === 'tools/call') {
    const name = params.name;
    if (typeof name !== 'string' || !options.tools.some(tool => tool.name === name)) {
      return success(id, { isError: true, content: [{ type: 'text', text: `Unknown tool: ${String(name)}` }] });
    }
    try {
      const outcome = await options.bridge.call(name, params.arguments ?? {});
      return success(id, { isError: outcome.isError, content: [{ type: 'text', text: outcome.text }] });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return success(id, { isError: true, content: [{ type: 'text', text: `Harness tool call failed: ${reason}` }] });
    }
  }
  return failure(id, -32601, `Method not found: ${method}`);
}

/** Reads requests from `input` and writes responses to `output` until input ends. */
export function runStdioServer(options: McpServerOptions, input: Readable, output: Writable): Promise<void> {
  return new Promise(resolve => {
    const pending = new Set<Promise<void>>();
    const reader = createInterface({ input });
    reader.on('line', line => {
      if (!line.trim()) return;
      const work = handleMcpLine(line, options).then(response => {
        if (response !== null) output.write(`${response}\n`);
      }).finally(() => { pending.delete(work); });
      pending.add(work);
    });
    reader.on('close', () => { void Promise.allSettled([...pending]).then(() => resolve()); });
  });
}
