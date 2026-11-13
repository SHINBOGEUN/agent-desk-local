// The harness side of the tool bridge: a tiny HTTP server on 127.0.0.1 that the
// stdio MCP process (started by Codex or Claude) calls. Each session gets its
// own secret token, so a tool call can only reach the HarnessTools of the
// session it was started for. Nothing here listens beyond the loopback address.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ApprovalDecision, ApprovalRequest, HarnessTools } from '#core';
import type { ToolCallOutcome } from './stdio-server.ts';

export const ENV_URL = 'AGENT_DESK_TOOLS_URL';
export const ENV_TOKEN = 'AGENT_DESK_TOOLS_TOKEN';

const MAX_BODY_BYTES = 1024 * 1024;

export interface ToolRegistration {
  url: string;
  token: string;
  /** Environment for the MCP server process. */
  env: Record<string, string>;
  dispose(): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(request: http.IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk as Buffer);
  }
  return size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString('utf8');
}

export async function dispatchTool(tools: HarnessTools, name: string, args: unknown): Promise<ToolCallOutcome> {
  if (name === 'submit_report') {
    const result = await tools.submitReport(args);
    return { text: result.message, isError: !result.ok };
  }
  if (name === 'request_user_input') {
    if (!isRecord(args) || typeof args.question !== 'string' || !args.question.trim()) {
      return { text: 'request_user_input needs a non-empty "question" string.', isError: true };
    }
    const options = Array.isArray(args.options) ? args.options.filter((option): option is string => typeof option === 'string') : undefined;
    const answer = await tools.requestUserInput({ question: args.question, ...(options?.length ? { options } : {}) });
    return { text: answer, isError: false };
  }
  if (name === 'approve') {
    const record = isRecord(args) ? args : {};
    const request: ApprovalRequest = { toolName: typeof record.tool_name === 'string' ? record.tool_name : '', input: record.input ?? {}, ...(typeof record.tool_use_id === 'string' ? { toolUseId: record.tool_use_id } : {}) };
    const decision: ApprovalDecision = tools.approve && request.toolName
      ? await tools.approve(request)
      : { behavior: 'deny', message: 'The harness has no approval handler for this session.' };
    return { text: JSON.stringify(decision.behavior === 'allow' ? { behavior: 'allow', updatedInput: decision.updatedInput ?? request.input } : decision), isError: false };
  }
  return { text: `Unknown tool: ${name}`, isError: true };
}

export class ToolEndpoint {
  readonly #server: http.Server;
  readonly #sessions = new Map<string, HarnessTools>();
  readonly port: number;

  private constructor(server: http.Server, port: number) {
    this.#server = server;
    this.port = port;
  }

  static async start(): Promise<ToolEndpoint> {
    let endpoint: ToolEndpoint | undefined;
    const server = http.createServer((request, response) => { if (endpoint) void endpoint.handle(request, response); });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    endpoint = new ToolEndpoint(server, (server.address() as AddressInfo).port);
    return endpoint;
  }

  register(tools: HarnessTools): ToolRegistration {
    const token = randomBytes(32).toString('hex');
    this.#sessions.set(token, tools);
    const url = `http://127.0.0.1:${this.port}/call`;
    return { url, token, env: { [ENV_URL]: url, [ENV_TOKEN]: token }, dispose: () => { this.#sessions.delete(token); } };
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  close(): Promise<void> {
    this.#sessions.clear();
    this.#server.closeAllConnections();
    return new Promise(resolve => { this.#server.close(() => resolve()); });
  }

  async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    try {
      if (request.method !== 'POST' || request.url !== '/call') return reply(404, { error: 'not found' });
      const header = request.headers.authorization ?? '';
      const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
      let tools: HarnessTools | undefined;
      for (const [token, candidate] of this.#sessions) if (sameToken(token, presented)) tools = candidate;
      if (!tools) return reply(401, { error: 'unauthorized' });
      const body = await readBody(request);
      if (body === null) return reply(413, { error: 'request body too large' });
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { return reply(400, { error: 'invalid JSON' }); }
      if (!isRecord(parsed) || typeof parsed.tool !== 'string') return reply(400, { error: 'expected { tool, arguments }' });
      return reply(200, await dispatchTool(tools, parsed.tool, parsed.arguments ?? {}));
    } catch (error) {
      return reply(500, { error: error instanceof Error ? error.message : 'internal error' });
    }
  }
}
