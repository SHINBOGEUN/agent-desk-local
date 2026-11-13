// Newline-delimited JSON-RPC peer for the Codex app-server. The wire format has
// no "jsonrpc" field: requests carry {id, method, params}, notifications omit id.

import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface RpcNotification {
  method: string;
  params: Record<string, unknown>;
}

export type ServerRequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export class RpcPeer {
  readonly #child: ChildProcess;
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  #nextId = 1;
  #exited = false;
  #stderr = '';
  onNotification: (notification: RpcNotification) => void = () => {};
  onServerRequest: ServerRequestHandler = async () => ({});
  onExit: (reason: string) => void = () => {};

  constructor(child: ChildProcess) {
    this.#child = child;
    child.stdin?.on('error', () => {});
    child.stderr?.on('data', (data: Buffer) => { this.#stderr = (this.#stderr + data.toString('utf8')).slice(-4000); });
    if (child.stdout) createInterface({ input: child.stdout }).on('line', line => { this.#receive(line); });
    child.once('error', error => { this.#finish(`cannot start Codex: ${error.message}`); });
    child.once('exit', (code, signal) => { this.#finish(`Codex app-server exited (${signal ?? code})${this.#stderr ? `: ${this.#stderr.trim().slice(-500)}` : ''}`); });
  }

  get exited(): boolean {
    return this.#exited;
  }

  #finish(reason: string): void {
    if (this.#exited) return;
    this.#exited = true;
    for (const [id, waiter] of this.#pending) { clearTimeout(waiter.timer); waiter.reject(new Error(reason)); this.#pending.delete(id); }
    this.onExit(reason);
  }

  #write(message: unknown): void {
    if (this.#exited) return;
    this.#child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  notify(method: string, params: unknown = {}): void {
    this.#write({ method, params });
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.#exited) return Promise.reject(new Error('Codex app-server is not running'));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
      this.#pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.#write({ id, method, params });
    });
  }

  #receive(line: string): void {
    let message: unknown;
    try { message = JSON.parse(line); } catch { return; }
    if (!isRecord(message)) return;
    const params = isRecord(message.params) ? message.params : {};
    if (typeof message.method === 'string' && message.id !== undefined) {
      const id = message.id;
      this.onServerRequest(message.method, params).then(
        result => { this.#write({ id, result }); },
        error => { this.#write({ id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }); },
      );
    } else if (typeof message.method === 'string') {
      this.onNotification({ method: message.method, params });
    } else if (typeof message.id === 'number') {
      const waiter = this.#pending.get(message.id);
      if (!waiter) return;
      this.#pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (isRecord(message.error)) waiter.reject(new Error(typeof message.error.message === 'string' ? message.error.message : JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  }

  /** Closes stdin, waits briefly for a clean exit, then kills. */
  async close(graceMs = 3000): Promise<void> {
    if (this.#exited) return;
    this.#child.stdin?.end();
    const gone = new Promise<void>(resolve => { this.#child.once('exit', () => resolve()); });
    const timer = new Promise<void>(resolve => setTimeout(resolve, graceMs).unref());
    await Promise.race([gone, timer]);
    if (!this.#exited) { this.#child.kill(); await Promise.race([gone, new Promise<void>(resolve => setTimeout(resolve, 2000).unref())]); }
  }
}
