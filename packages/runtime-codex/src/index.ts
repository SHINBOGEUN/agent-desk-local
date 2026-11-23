// Runtime adapter for the Codex App Server (`codex app-server --stdio`). One
// app-server process per session keeps sessions isolated and makes cleanup
// simple: closing the session ends the process and the MCP server it started.
// Approvals are not expected (sandbox + approvalPolicy "never"); if the server
// asks anyway, the request is surfaced as an event and declined.

import { spawn, spawnSync } from 'node:child_process';
import type { ApprovalDecision, DoctorCheck, DoctorResult, Runtime, RuntimeEvent, Session, SessionOptions, TokenUsage, TurnInput } from '#core';
import { ToolEndpoint, mcpServerCommand } from '#tools-mcp';
import type { ToolRegistration } from '#tools-mcp';
import { RpcPeer } from './rpc.ts';
import type { RpcNotification } from './rpc.ts';

export interface CodexRuntimeOptions {
  /** Path to the codex executable. Defaults to AGENT_DESK_CODEX or "codex". */
  command?: string;
  /** Arguments that start the app-server. Tests replace this to run a fake server. */
  serverArgs?: string[];
  /** Shared tool endpoint. Created on first use when omitted. */
  endpoint?: ToolEndpoint;
  initializeTimeoutMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

export function usageFromCodex(raw: unknown): TokenUsage {
  const record = isRecord(raw) ? raw : {};
  const usage: TokenUsage = {
    inputTokens: num(record.inputTokens),
    cachedInputTokens: num(record.cachedInputTokens),
    outputTokens: num(record.outputTokens),
    reasoningTokens: num(record.reasoningOutputTokens ?? record.reasoningTokens),
    totalTokens: num(record.totalTokens),
  };
  if (!usage.totalTokens) usage.totalTokens = usage.inputTokens + usage.outputTokens;
  return usage;
}

/**
 * Codex repeats the last usage notification in some cases (seen when a turn is
 * interrupted right after a model call): the same "last" again, with an
 * unchanged thread "total". Counting it would double the call. Returns the
 * thread total of a usage notification, or null when it has none.
 */
export function usageTotalOf(notification: RpcNotification): number | null {
  if (notification.method !== 'thread/tokenUsage/updated') return null;
  const tokenUsage = isRecord(notification.params.tokenUsage) ? notification.params.tokenUsage : {};
  if (!isRecord(tokenUsage.total)) return null;
  const total = usageFromCodex(tokenUsage.total).totalTokens;
  return total > 0 ? total : null;
}

// Notifications this runtime understands or that carry nothing to account for. Any other method is recorded
// once per turn as a "notice:" tool event, so a model call that left no item can still be traced.
const KNOWN_NOTIFICATIONS = new Set(['thread/tokenUsage/updated', 'item/started', 'item/completed', 'turn/started', 'turn/completed', 'thread/started', 'thread/status/changed', 'account/rateLimits/updated', 'thread/settings/updated']);

/** The first string under a "model" key, looked up a few levels deep (Codex nests thread settings). */
export function findModel(value: unknown, depth = 0): string | null {
  if (!isRecord(value) || depth > 3) return null;
  if (typeof value.model === 'string' && value.model) return value.model;
  for (const child of Object.values(value)) { const found = findModel(child, depth + 1); if (found) return found; }
  return null;
}

/** Models from Codex "model/list": id, label and which one is the default. Unknown shapes give an empty list. */
export function modelsFromList(raw: unknown): { id: string; label: string; isDefault: boolean }[] {
  const record = isRecord(raw) ? raw : {};
  const list = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
  return list.filter(isRecord).map(item => {
    const id = str(item.model) || str(item.id);
    return { id, label: str(item.displayName) || id, isDefault: item.isDefault === true };
  }).filter(item => item.id);
}

/** Translates one app-server notification into runtime events. */
export function eventsFromNotification(notification: RpcNotification): RuntimeEvent[] {
  const { method, params } = notification;
  if (method === 'thread/tokenUsage/updated') {
    const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : {};
    return isRecord(tokenUsage.last) ? [{ type: 'usage', delta: usageFromCodex(tokenUsage.last) }] : [];
  }
  if (method === 'thread/settings/updated') {
    const model = findModel(params);
    return model ? [{ type: 'session_info', model }] : [];
  }
  if (method === 'item/started' && isRecord(params.item)) {
    // Recorded when it starts: a turn the harness ends right after the report may never send its completion.
    const type = str(params.item.type);
    if (['agentMessage', 'userMessage', 'commandExecution', 'fileChange', ''].includes(type)) return [];
    const detail = [str(params.item.server), str(params.item.tool)].filter(Boolean).join('/');
    return [{ type: 'tool', name: `${type}${detail ? `:${detail}` : ''}` }];
  }
  if (method !== 'item/completed' || !isRecord(params.item)) return [];
  const item = params.item;
  if (item.type === 'agentMessage') return [{ type: 'message', text: str(item.text), final: item.phase === 'final_answer' }];
  if (item.type === 'commandExecution') {
    return [{ type: 'command', command: str(item.command), exitCode: typeof item.exitCode === 'number' ? item.exitCode : null, output: str(item.aggregatedOutput) }];
  }
  if (item.type === 'fileChange' && Array.isArray(item.changes)) {
    return item.changes.filter(isRecord).map(change => {
      const kindValue = isRecord(change.kind) ? str(change.kind.type) : str(change.kind);
      const kind = kindValue === 'add' || kindValue === 'delete' ? kindValue : 'update';
      return { type: 'file_change' as const, path: str(change.path), kind };
    });
  }
  return [];
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

type Signal = { notification: RpcNotification } | { event: RuntimeEvent } | { exited: string };

class CodexSession implements Session {
  readonly id: string;
  readonly #peer: RpcPeer;
  readonly #registration: ToolRegistration;
  readonly #options: SessionOptions;
  readonly #threadId: string;
  #queue = new Queue<Signal>();
  #exitReason: string | null = null;
  #busy = false;
  /** Thread total from the last usage notification counted, to drop repeats. */
  #usageTotal: number | null = null;
  #closed = false;

  constructor(peer: RpcPeer, registration: ToolRegistration, options: SessionOptions, threadId: string) {
    this.#peer = peer;
    this.#registration = registration;
    this.#options = options;
    this.#threadId = threadId;
    this.id = threadId;
    peer.onNotification = notification => { this.#queue.push({ notification }); };
    peer.onExit = reason => { this.#exitReason = reason; this.#queue.push({ exited: reason }); };
    peer.onServerRequest = (method, params) => this.#answerServerRequest(method, params);
  }

  async #answerServerRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'mcpServer/elicitation/request') {
      const server = str(params.serverName ?? params.server);
      return !server || server === 'agentdesk' ? { action: 'accept', content: {} } : { action: 'decline' };
    }
    const decision: ApprovalDecision = { behavior: 'deny', message: 'Agent Desk runs Codex without interactive approvals.' };
    this.#queue.push({ event: { type: 'approval_request', id: str(params.itemId) || method, kind: method, detail: { ...params, decision: decision.behavior } } });
    if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
    return { decision: 'decline' };
  }

  async *runTurn(input: TurnInput, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    if (this.#closed) throw new Error('session is closed');
    if (this.#busy) throw new Error('a turn is already running in this session');
    this.#busy = true;
    try {
      if (this.#exitReason) { yield { type: 'turn_end', status: 'failed', error: this.#exitReason }; return; }
      const content: unknown[] = [{ type: 'text', text: input.text }, ...(input.images ?? []).map(path => ({ type: 'localImage', path }))];
      let turnId = '';
      try {
        const started = await this.#peer.request<{ turn?: { id?: string } }>('turn/start', { threadId: this.#threadId, input: content, ...(this.#options.effort ? { effort: this.#options.effort } : {}) });
        turnId = str(started?.turn?.id);
      } catch (error) {
        yield { type: 'turn_end', status: 'failed', error: error instanceof Error ? error.message : String(error) };
        return;
      }
      const seenMethods = new Set<string>();
      let interrupted = false;
      const interrupt = () => {
        if (interrupted) return;
        interrupted = true;
        this.#peer.request('turn/interrupt', { threadId: this.#threadId, turnId }, 15_000).catch(() => {});
      };
      if (signal.aborted) interrupt(); else signal.addEventListener('abort', interrupt, { once: true });
      try {
        for (;;) {
          const signalItem = await this.#queue.next();
          if ('exited' in signalItem) { yield { type: 'turn_end', status: 'failed', error: signalItem.exited }; return; }
          if ('event' in signalItem) { yield signalItem.event; continue; }
          const { notification } = signalItem;
          if (notification.method === 'turn/completed') {
            const turn = isRecord(notification.params.turn) ? notification.params.turn : {};
            if (turnId && str(turn.id) && str(turn.id) !== turnId) continue;
            const status = str(turn.status);
            // codexErrorInfo names the kind ("usageLimitExceeded", or an object keyed by it); keep it with the message.
            const info = isRecord(turn.error) ? turn.error.codexErrorInfo : undefined;
            const kind = typeof info === 'string' ? info : isRecord(info) ? Object.keys(info)[0] ?? '' : '';
            const error = isRecord(turn.error) ? `${str(turn.error.message)}${kind ? ` [${kind}]` : ''}`.trim() : '';
            yield status === 'completed' ? { type: 'turn_end', status: 'completed' }
              : status === 'interrupted' ? { type: 'turn_end', status: 'interrupted' }
              : { type: 'turn_end', status: 'failed', error: error || `turn ended with status "${status || 'unknown'}"` };
            return;
          }
          if (!KNOWN_NOTIFICATIONS.has(notification.method) && !notification.method.endsWith('/delta') && !seenMethods.has(notification.method)) {
            seenMethods.add(notification.method);
            yield { type: 'tool', name: `notice:${notification.method}` };
          }
          const total = usageTotalOf(notification);
          if (total !== null) {
            if (total === this.#usageTotal) continue;
            this.#usageTotal = total;
          }
          yield* eventsFromNotification(notification);
        }
      } finally {
        signal.removeEventListener('abort', interrupt);
      }
    } finally {
      this.#busy = false;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#registration.dispose();
    // Ephemeral threads should not be listed, but some Codex builds still show them in the app's thread list
    // ("Step: research. User request: ..."). Archive the thread as well; an error (already gone) is ignored.
    if (process.env.AGENT_DESK_CODEX_KEEP_SESSIONS !== '1') await this.#peer.request('thread/archive', { threadId: this.#threadId }, 5_000).catch(() => {});
    await this.#peer.close();
  }
}

export class CodexRuntime implements Runtime {
  readonly id = 'codex' as const;
  readonly #options: CodexRuntimeOptions;
  #endpoint: ToolEndpoint | undefined;
  #ownsEndpoint = false;

  constructor(options: CodexRuntimeOptions = {}) {
    this.#options = options;
    this.#endpoint = options.endpoint;
  }

  get command(): string {
    return this.#options.command ?? process.env.AGENT_DESK_CODEX ?? 'codex';
  }

  async doctor(): Promise<DoctorResult> {
    const checks: DoctorCheck[] = [];
    const result = spawnSync(this.command, ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    if (result.error || result.status !== 0) {
      checks.push({ name: 'codex executable', ok: false, detail: result.error ? result.error.message : `exit ${String(result.status)}: ${(result.stderr || '').trim()}`, fix: 'Install the Codex CLI and sign in, or set AGENT_DESK_CODEX to the full path of codex.exe.' });
    } else {
      checks.push({ name: 'codex executable', ok: true, detail: (result.stdout || '').trim() || 'version printed' });
    }
    return { runtime: 'codex', ok: checks.every(check => check.ok), checks };
  }

  async startSession(options: SessionOptions): Promise<Session> {
    if (!this.#endpoint) { this.#endpoint = await ToolEndpoint.start(); this.#ownsEndpoint = true; }
    const registration = this.#endpoint.register(options.tools);
    const tools = mcpServerCommand(registration);
    const child = spawn(this.command, this.#options.serverArgs ?? ['app-server', '--stdio', '-c', 'agents.enabled=false'], { cwd: options.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const peer = new RpcPeer(child);
    try {
      await peer.request('initialize', { clientInfo: { name: 'agent_desk', title: 'Agent Desk', version: '0.2.0' }, capabilities: { experimentalApi: true } }, this.#options.initializeTimeoutMs ?? 30_000);
      peer.notify('initialized', {});
      const config = {
        'agents.enabled': false,
        'features.apps': false,
        'features.plugins': false,
        'features.memories': false,
        'mcp_servers.agentdesk.command': tools.command,
        'mcp_servers.agentdesk.args': tools.args,
        'mcp_servers.agentdesk.env': tools.env,
        'mcp_servers.agentdesk.default_tools_approval_mode': 'approve',
        // Our four tools go to the model directly. Behind tool search or code mode the model
        // spends one or two extra calls (about 13k tokens each) finding submit_report first (run #54).
        'mcp_servers.agentdesk.omit_tools_from': ['deferred', 'code_mode'],
      };
      const start = (config: Record<string, unknown>) => peer.request<{ thread?: { id?: string } }>('thread/start', {
        cwd: options.cwd,
        ...(options.model ? { model: options.model } : {}),
        // Sessions are not saved by default. AGENT_DESK_CODEX_KEEP_SESSIONS=1 keeps them in ~/.codex/sessions,
        // the only place that shows every item of a model call (for tracing where tokens went).
        ephemeral: process.env.AGENT_DESK_CODEX_KEEP_SESSIONS !== '1',
        sandbox: options.access,
        approvalPolicy: 'never',
        developerInstructions: options.instructions,
        config,
      });
      let started;
      try {
        started = await start(config);
      } catch (error) {
        // An older Codex that does not know omit_tools_from: start without it.
        if (!/omit_tools_from/.test(String(error instanceof Error ? error.message : error))) throw error;
        const { 'mcp_servers.agentdesk.omit_tools_from': _omit, ...rest } = config;
        started = await start(rest);
      }
      const threadId = str(started?.thread?.id);
      if (!threadId) throw new Error('thread/start returned no thread id');
      return new CodexSession(peer, registration, options, threadId);
    } catch (error) {
      registration.dispose();
      await peer.close(500);
      throw error;
    }
  }

  /** Reads the account's rate limits through a short-lived app-server. The raw response goes to normalizeRateLimits. */
  async readRateLimits(timeoutMs = 15_000): Promise<unknown> {
    const child = spawn(this.command, this.#options.serverArgs ?? ['app-server', '--stdio', '-c', 'agents.enabled=false'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const peer = new RpcPeer(child);
    try {
      await peer.request('initialize', { clientInfo: { name: 'agent_desk', title: 'Agent Desk', version: '0.2.0' }, capabilities: { experimentalApi: true } }, timeoutMs);
      peer.notify('initialized', {});
      return await peer.request('account/rateLimits/read', {}, timeoutMs);
    } finally {
      await peer.close(500);
    }
  }

  /** Models this Codex account can use ("model/list" on a short-lived app-server). */
  async listModels(timeoutMs = 15_000): Promise<{ id: string; label: string; isDefault: boolean }[]> {
    const child = spawn(this.command, this.#options.serverArgs ?? ['app-server', '--stdio', '-c', 'agents.enabled=false'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const peer = new RpcPeer(child);
    try {
      await peer.request('initialize', { clientInfo: { name: 'agent_desk', title: 'Agent Desk', version: '0.2.0' }, capabilities: { experimentalApi: true } }, timeoutMs);
      peer.notify('initialized', {});
      return modelsFromList(await peer.request('model/list', {}, timeoutMs));
    } finally {
      await peer.close(500);
    }
  }

  async close(): Promise<void> {
    if (this.#ownsEndpoint && this.#endpoint) { await this.#endpoint.close(); this.#endpoint = undefined; this.#ownsEndpoint = false; }
  }
}
