// Runtime adapter for the Claude Code CLI in headless stream-json mode. One
// `claude -p` process per session. Harness tools (report, question, approval)
// are reached through the local MCP server; every other tool is limited with
// `--tools`, because `--allowedTools` only skips prompts and does not remove
// built-in tools (ADR 0003). Permission questions go to the harness through
// `--permission-prompt-tool`, which applies the approval policy.
//
// UNVERIFIED on a real Claude Code (to be checked on the user's PC): the exact
// shape of `assistant`/`user` stream messages beyond what the prototype logged,
// that `--tools` accepts the comma list used here, and the Bash exit code (only
// `is_error` is available, so exitCode is 0 or 1).

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { DoctorCheck, DoctorResult, Runtime, RuntimeEvent, Session, SessionOptions, TokenUsage, TurnInput } from '#core';
import { ToolEndpoint, mcpServerCommand } from '#tools-mcp';
import type { ToolRegistration } from '#tools-mcp';

export interface ClaudeRuntimeOptions {
  /** Path to the claude executable. Defaults to AGENT_DESK_CLAUDE or "claude". */
  command?: string;
  /** Arguments placed before the generated flags. Tests use this to run a fake CLI script. */
  prefixArgs?: string[];
  endpoint?: ToolEndpoint;
  /** How long to wait for an interrupted turn to report before killing the process. */
  interruptGraceMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const MCP_TOOLS = ['mcp__agentdesk__submit_report', 'mcp__agentdesk__request_user_input'];
const APPROVE_TOOL = 'mcp__agentdesk__approve';
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];
export const WRITE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'];

export function buildArgs(options: SessionOptions, mcpConfigFile: string): string[] {
  const tools = options.access === 'read-only' ? READ_ONLY_TOOLS : WRITE_TOOLS;
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--mcp-config', mcpConfigFile, '--strict-mcp-config',
    '--tools', tools.join(','),
    '--allowedTools', ...MCP_TOOLS,
    '--permission-prompt-tool', APPROVE_TOOL,
    '--append-system-prompt', options.instructions,
    ...(options.model ? ['--model', options.model] : []),
  ];
}

/** Claude reports uncached input, cache writes and cache reads separately; all three count as input. */
export function usageFromClaude(raw: unknown): TokenUsage {
  const record = isRecord(raw) ? raw : {};
  const cached = num(record.cache_read_input_tokens);
  const input = num(record.input_tokens) + num(record.cache_creation_input_tokens) + cached;
  const output = num(record.output_tokens);
  const details = isRecord(record.output_tokens_details) ? record.output_tokens_details : {};
  return { inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningTokens: num(details.thinking_tokens), totalTokens: input + output };
}

const FIELDS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens'] as const;
const positiveDiff = (now: TokenUsage, before: TokenUsage): TokenUsage => {
  const out = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  for (const field of FIELDS) out[field] = Math.max(0, now[field] - before[field]);
  return out;
};
const isZero = (usage: TokenUsage): boolean => FIELDS.every(field => usage[field] === 0);
const maxOf = (a: TokenUsage, b: TokenUsage): TokenUsage => ({ inputTokens: Math.max(a.inputTokens, b.inputTokens), cachedInputTokens: Math.max(a.cachedInputTokens, b.cachedInputTokens), outputTokens: Math.max(a.outputTokens, b.outputTokens), reasoningTokens: Math.max(a.reasoningTokens, b.reasoningTokens), totalTokens: Math.max(a.totalTokens, b.totalTokens) });
const ZERO: TokenUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

/** Attached images as stream-json image blocks (base64). Unreadable or unknown files are skipped. */
export function imageBlocks(paths: string[]): unknown[] {
  const blocks: unknown[] = [];
  for (const file of paths) {
    const mediaType = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (!mediaType) continue;
    try { blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: fs.readFileSync(file).toString('base64') } }); } catch { /* skipped */ }
  }
  return blocks;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(isRecord).map(block => str(block.text)).join('\n');
  return '';
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Turns the stream-json messages of one turn into runtime events. */
export class TurnTranslator {
  #usageByMessage = new Map<string, TokenUsage>();
  #emitted: TokenUsage = { ...ZERO };
  #pendingText: string | null = null;
  #toolUses = new Map<string, { name: string; input: Record<string, unknown> }>();

  #flush(final: boolean, out: RuntimeEvent[]): void {
    if (this.#pendingText !== null && this.#pendingText.trim()) out.push({ type: 'message', text: this.#pendingText, final });
    this.#pendingText = null;
  }

  #addUsage(delta: TokenUsage, out: RuntimeEvent[]): void {
    if (isZero(delta)) return;
    out.push({ type: 'usage', delta });
    for (const field of FIELDS) this.#emitted[field] += delta[field];
  }

  handle(message: Record<string, unknown>): RuntimeEvent[] {
    const out: RuntimeEvent[] = [];
    if (message.type === 'assistant' && isRecord(message.message)) {
      const body = message.message;
      const id = str(body.id);
      if (id && isRecord(body.usage)) {
        const now = usageFromClaude(body.usage);
        const before = this.#usageByMessage.get(id) ?? ZERO;
        this.#addUsage(positiveDiff(now, before), out);
        this.#usageByMessage.set(id, maxOf(now, before));
      }
      for (const block of Array.isArray(body.content) ? body.content : []) {
        if (!isRecord(block)) continue;
        if (block.type === 'text') { this.#flush(false, out); this.#pendingText = str(block.text); }
        else if (block.type === 'tool_use') { this.#flush(false, out); this.#toolUses.set(str(block.id), { name: str(block.name), input: isRecord(block.input) ? block.input : {} }); }
      }
    } else if (message.type === 'user' && isRecord(message.message) && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (!isRecord(block) || block.type !== 'tool_result') continue;
        const use = this.#toolUses.get(str(block.tool_use_id));
        if (!use) continue;
        const failed = block.is_error === true;
        if (use.name === 'Bash') out.push({ type: 'command', command: str(use.input.command), exitCode: failed ? 1 : 0, output: resultText(block.content) });
        else if (EDIT_TOOLS.has(use.name) && !failed) out.push({ type: 'file_change', path: str(use.input.file_path ?? use.input.notebook_path), kind: 'update' });
        else if (use.name === 'Read' && !failed) out.push({ type: 'file_read', path: str(use.input.file_path) });
        else if (use.name !== 'Read' && !EDIT_TOOLS.has(use.name)) out.push({ type: 'tool', name: use.name });
      }
    }
    return out;
  }

  /** Handles the final `result` message; `interrupted` is true when the harness asked for an interrupt. */
  finish(result: Record<string, unknown>, interrupted: boolean): RuntimeEvent[] {
    const out: RuntimeEvent[] = [];
    this.#addUsage(positiveDiff(usageFromClaude(result.usage), this.#emitted), out);
    const failed = result.is_error === true || (str(result.subtype) !== '' && str(result.subtype) !== 'success');
    if (!failed) {
      if (this.#pendingText !== null) this.#flush(true, out);
      else if (str(result.result).trim()) out.push({ type: 'message', text: str(result.result), final: true });
      out.push({ type: 'turn_end', status: 'completed' });
      return out;
    }
    this.#flush(false, out);
    if (interrupted) { out.push({ type: 'turn_end', status: 'interrupted' }); return out; }
    const errors = Array.isArray(result.errors) ? result.errors.map(item => str(item)).filter(Boolean).join('; ') : '';
    out.push({ type: 'turn_end', status: 'failed', error: str(result.result) || errors || `turn ended with "${str(result.subtype) || 'error'}"` });
    return out;
  }
}

class Queue<T> {
  #items: T[] = [];
  #waiting: ((value: T) => void) | null = null;
  push(item: T): void {
    if (this.#waiting) { const waiting = this.#waiting; this.#waiting = null; waiting(item); } else this.#items.push(item);
  }
  next(): Promise<T> {
    const item = this.#items.shift();
    return item === undefined ? new Promise<T>(resolve => { this.#waiting = resolve; }) : Promise.resolve(item);
  }
}

type Signal = { message: Record<string, unknown> } | { exited: string };

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
}

class ClaudeSession implements Session {
  readonly id: string;
  readonly #child: ReturnType<typeof spawn>;
  readonly #registration: ToolRegistration;
  readonly #tempDir: string;
  readonly #graceMs: number;
  #queue = new Queue<Signal>();
  #exitReason: string | null = null;
  #stderr = '';
  #busy = false;
  #closed = false;

  constructor(child: ReturnType<typeof spawn>, registration: ToolRegistration, tempDir: string, graceMs: number, id: string) {
    this.#child = child;
    this.#registration = registration;
    this.#tempDir = tempDir;
    this.#graceMs = graceMs;
    this.id = id;
    child.stdin?.on('error', () => {});
    child.stderr?.on('data', (data: Buffer) => { this.#stderr = (this.#stderr + data.toString('utf8')).slice(-4000); });
    if (child.stdout) createInterface({ input: child.stdout }).on('line', line => {
      try { const parsed: unknown = JSON.parse(line); if (isRecord(parsed)) this.#queue.push({ message: parsed }); } catch { /* not JSON: ignore */ }
    });
    const ended = (reason: string) => { if (!this.#exitReason) { this.#exitReason = reason; this.#queue.push({ exited: reason }); } };
    child.once('error', error => { ended(`cannot start Claude: ${error.message}`); });
    child.once('exit', (code, signal) => { ended(`Claude exited (${signal ?? code})${this.#stderr ? `: ${this.#stderr.trim().slice(-500)}` : ''}`); });
  }

  #write(message: unknown): void {
    this.#child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  async *runTurn(input: TurnInput, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    if (this.#closed) throw new Error('session is closed');
    if (this.#busy) throw new Error('a turn is already running in this session');
    this.#busy = true;
    try {
      if (this.#exitReason) { yield { type: 'turn_end', status: 'failed', error: this.#exitReason }; return; }
      const content: unknown[] = [{ type: 'text', text: input.text }, ...imageBlocks(input.images ?? [])];
      this.#write({ type: 'user', message: { role: 'user', content } });
      const translator = new TurnTranslator();
      let interrupted = false;
      let killTimer: NodeJS.Timeout | null = null;
      const interrupt = () => {
        if (interrupted) return;
        interrupted = true;
        this.#write({ type: 'control_request', request_id: `interrupt-${Date.now()}`, request: { subtype: 'interrupt' } });
        killTimer = setTimeout(() => { killTree(this.#child.pid); }, this.#graceMs);
      };
      if (signal.aborted) interrupt(); else signal.addEventListener('abort', interrupt, { once: true });
      try {
        for (;;) {
          const item = await this.#queue.next();
          if ('exited' in item) { yield interrupted ? { type: 'turn_end', status: 'interrupted' } : { type: 'turn_end', status: 'failed', error: item.exited }; return; }
          if (item.message.type === 'result') { yield* translator.finish(item.message, interrupted); return; }
          yield* translator.handle(item.message);
        }
      } finally {
        signal.removeEventListener('abort', interrupt);
        if (killTimer) clearTimeout(killTimer);
      }
    } finally {
      this.#busy = false;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#registration.dispose();
    this.#child.stdin?.end();
    if (this.#exitReason === null) {
      const exited = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => { resolve(false); }, 3000);
        this.#child.once('exit', () => { clearTimeout(timer); resolve(true); });
      });
      if (!exited) killTree(this.#child.pid);
    }
    fs.rmSync(this.#tempDir, { recursive: true, force: true });
  }
}

export class ClaudeRuntime implements Runtime {
  readonly id = 'claude' as const;
  readonly #options: ClaudeRuntimeOptions;
  #endpoint: ToolEndpoint | undefined;
  #ownsEndpoint = false;

  constructor(options: ClaudeRuntimeOptions = {}) {
    this.#options = options;
    this.#endpoint = options.endpoint;
  }

  get command(): string {
    return this.#options.command ?? process.env.AGENT_DESK_CLAUDE ?? 'claude';
  }

  async doctor(): Promise<DoctorResult> {
    const checks: DoctorCheck[] = [];
    const result = spawnSync(this.command, [...(this.#options.prefixArgs ?? []), '--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    if (result.error || result.status !== 0) {
      checks.push({ name: 'claude executable', ok: false, detail: result.error ? result.error.message : `exit ${String(result.status)}: ${(result.stderr || '').trim()}`, fix: 'Install Claude Code and sign in, or set AGENT_DESK_CLAUDE to the full path of claude.exe.' });
    } else {
      checks.push({ name: 'claude executable', ok: true, detail: (result.stdout || '').trim() || 'version printed' });
    }
    return { runtime: 'claude', ok: checks.every(check => check.ok), checks };
  }

  async startSession(options: SessionOptions): Promise<Session> {
    if (!this.#endpoint) { this.#endpoint = await ToolEndpoint.start(); this.#ownsEndpoint = true; }
    const registration = this.#endpoint.register(options.tools);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desk-claude-'));
    try {
      const server = mcpServerCommand(registration);
      const configFile = path.join(tempDir, 'mcp.json');
      fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { agentdesk: { command: server.command, args: server.args, env: server.env } } }), { mode: 0o600 });
      const child = spawn(this.command, [...(this.#options.prefixArgs ?? []), ...buildArgs(options, configFile)], { cwd: options.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      return new ClaudeSession(child, registration, tempDir, this.#options.interruptGraceMs ?? 10_000, `claude-${path.basename(tempDir)}`);
    } catch (error) {
      registration.dispose();
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#ownsEndpoint && this.#endpoint) { await this.#endpoint.close(); this.#endpoint = undefined; this.#ownsEndpoint = false; }
  }
}
