import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export class CodexClient extends EventEmitter {
  constructor({ command = process.env.AGENT_DESK_CODEX || process.env.CODEX_CLI_PATH || 'codex', cwd = process.cwd() } = {}) {
    super();
    this.command = command;
    this.cwd = cwd;
    this.pending = new Map();
    this.nextId = 1;
    this.connected = false;
    this.stderr = '';
  }

  async connect() {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async open() {
    const child = spawn(this.command, ['app-server', '--stdio', '-c', 'agents.enabled=false'], {
      cwd: this.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdin.on('error', () => {});
    child.stderr.on('data', data => { this.stderr = (this.stderr + data.toString()).slice(-5000); });
    child.on('error', error => { if (this.child === child) this.disconnected(error); });
    child.on('exit', (code, signal) => { if (this.child === child) this.disconnected(new Error(`Codex 연결이 종료되었습니다 (${signal || code}).`)); });
    createInterface({ input: child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (Object.hasOwn(message, 'id') && message.method) {
        this.emit('request', message);
      } else if (Object.hasOwn(message, 'id')) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else if (message.method) this.emit('notification', message);
    });
    try {
      this.info = await this.request('initialize', {
        clientInfo: { name: 'agent_desk_local', title: 'Agent Desk Local', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      this.send({ method: 'initialized', params: {} });
      this.connected = true;
      this.emit('connection', true);
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  disconnected(error) {
    const wasConnected = this.connected;
    this.connected = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (wasConnected) this.emit('connection', false, error.message);
  }

  send(message) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) throw new Error('Codex가 연결되어 있지 않습니다.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = 45000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 응답 시간이 초과되었습니다.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  respond(id, result) { this.send({ id, result }); }
  rejectRequest(id, message) { this.send({ id, error: { code: -32601, message } }); }
  close() {
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 1500);
    timer.unref();
  }
}
