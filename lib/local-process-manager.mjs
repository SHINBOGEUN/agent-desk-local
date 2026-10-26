import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const STARTABLE_SCRIPT = /^(start|dev|serve|preview)(:[a-z0-9:_-]+)?$/i;
const SAFE_ARGUMENT = /^(--[a-z][a-z0-9-]*(?:=[a-zA-Z0-9_.:-]+)?|[a-zA-Z0-9_.:-]+)$/;
const MAX_LOG_BYTES = 1024 * 1024;
const redact = text => String(text).replace(/\b(bearer)\s+[A-Za-z0-9._~+\/-]+=*/gi, '$1 [REDACTED]')
  .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization)\b(\s*[:=]\s*)(["']?)[^\s"'`,;]+/gi, '$1$2[REDACTED]')
  .replace(/\b(sk-[A-Za-z0-9_-]{16,}|sbp_[A-Za-z0-9_-]{16,})\b/g, '[REDACTED]');

export class LocalProcessManager {
  constructor({ dataDirectory, projects, spawnProcess = spawn }) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.projects = projects;
    this.spawnProcess = spawnProcess;
    this.stateFile = path.join(this.dataDirectory, 'local-processes.json');
    this.logDirectory = path.join(this.dataDirectory, 'process-logs');
    this.processes = new Map();
    this.children = new Map();
    this.onChange = () => {};
    fs.mkdirSync(this.logDirectory, { recursive: true });
    this.load();
  }

  load() {
    try {
      const records = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (!Array.isArray(records)) return;
      for (const record of records.slice(-100)) {
        if (!record || !/^[0-9a-f-]{36}$/i.test(record.id || '') || !Number.isInteger(record.pid)) continue;
        this.processes.set(record.id, { ...record, status: ['running','starting'].includes(record.status) ? 'checking' : record.status });
      }
    } catch {}
  }

  save() {
    const records = [...this.processes.values()].slice(-100).map(({ child, ...record }) => record);
    const temporary = `${this.stateFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(records, null, 2), 'utf8');
    fs.renameSync(temporary, this.stateFile);
  }

  changed() { this.save(); this.onChange(); }

  getProject(projectId) {
    const project = this.projects().find(item => item.id === projectId);
    if (!project) throw new Error('선택한 프로젝트를 찾을 수 없습니다.');
    const realPath = fs.realpathSync(project.path);
    if (!fs.statSync(realPath).isDirectory()) throw new Error('프로젝트 경로가 폴더가 아닙니다.');
    return { ...project, path: realPath };
  }

  scripts(projectId) {
    const project = this.getProject(projectId);
    const packageFile = path.join(project.path, 'package.json');
    if (!fs.existsSync(packageFile)) throw new Error('이 프로젝트에는 package.json이 없습니다. 현재 로컬 프로세스 관리 기능은 npm 개발 스크립트를 대상으로 합니다.');
    const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    const scripts = Object.entries(manifest.scripts || {}).filter(([name]) => STARTABLE_SCRIPT.test(name)).map(([name]) => ({ name }));
    return { projectId, allowed: project.allowLocalProcesses === true, scripts, message: scripts.length ? '' : 'start, dev, serve, preview로 시작하는 npm 스크립트가 없습니다.' };
  }

  snapshot() {
    return [...this.processes.values()].map(({ logFile, ...item }) => ({ ...item }));
  }

  async run(projectId, input) {
    const action = input?.action;
    if (!['scripts','start','stop','status','logs','probe'].includes(action)) throw new Error('지원하지 않는 프로세스 작업입니다.');
    const project = this.getProject(projectId);
    if (action === 'scripts') return this.scripts(project.id);
    if (action === 'probe') return this.probe(input.url);
    if (action === 'start' && project.allowLocalProcesses !== true) throw new Error('이 프로젝트의 설정에서 “로컬 프로세스 관리 허용”을 먼저 켜 주세요.');
    if (action === 'start') return this.start(project, input);
    const processId = String(input.processId || '');
    const record = this.processes.get(processId);
    if (!record || record.projectId !== project.id) throw new Error('이 프로젝트에서 관리 중인 프로세스를 찾을 수 없습니다.');
    if (action === 'status') return this.status(record);
    if (action === 'logs') return this.logs(record, input.lines);
    return this.stop(record);
  }

  async start(project, input) {
    const script = String(input.script || '');
    if (!STARTABLE_SCRIPT.test(script)) throw new Error('start, dev, serve, preview 계열의 개발 스크립트만 실행할 수 있습니다.');
    const available = this.scripts(project.id).scripts;
    if (!available.some(item => item.name === script)) throw new Error(`package.json에 실행 가능한 '${script}' 스크립트가 없습니다.`);
    const args = input.args ?? [];
    if (!Array.isArray(args) || args.length > 12 || args.some(value => typeof value !== 'string' || value.length > 100 || !SAFE_ARGUMENT.test(value))) throw new Error('실행 인자는 옵션과 값만 사용할 수 있습니다. 셸 기호, 명령 연결, 경로 인자는 허용하지 않습니다.');
    const existing = [...this.processes.values()].find(item => item.projectId === project.id && item.script === script && ['running','starting','checking'].includes(item.status));
    if (existing) return this.status(existing);
    const id = randomUUID();
    const logFile = path.join(this.logDirectory, `${id}.log`);
    const windows = process.platform === 'win32';
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (windows && !fs.existsSync(npmCli)) throw new Error(`현재 Node.js 설치에서 npm-cli.js를 찾을 수 없습니다: ${npmCli}`);
    const logDescriptor = fs.openSync(logFile, 'a');
    const command = windows ? process.execPath : 'npm';
    const commandArgs = windows
      ? [npmCli, 'run', script, ...(args.length ? ['--', ...args] : [])]
      : ['run', script, ...(args.length ? ['--', ...args] : [])];
    const child = this.spawnProcess(command, commandArgs, {
      cwd: project.path,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(token|secret|password|passwd|api[_-]?key|private[_-]?key)/i.test(key))),
      detached: true,
      windowsHide: true,
      stdio: ['ignore','pipe','pipe'],
      shell: false,
    });
    const record = { id, projectId:project.id, projectName:project.name, projectPath:project.path, script, args, pid:child.pid || 0, status:'starting', startedAt:new Date().toISOString(), exitCode:null, error:null, logFile };
    this.processes.set(id, record);
    this.children.set(id, child);
    const write = stream => {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        pending += chunk;
        if (pending.length > 16000 && !pending.includes('\n')) pending = pending.slice(-8000);
        const lines = pending.split(/\r?\n/); pending = lines.pop() || '';
        const text = lines.map(line => redact(line).slice(0, 8000)).join('\n');
        if (!text) return;
        try {
          if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_LOG_BYTES) fs.writeFileSync(logFile, '');
          fs.writeSync(logDescriptor, `${text}\n`);
        } catch {}
      });
      stream.on('end', () => { if (pending) { try { fs.writeSync(logDescriptor, `${redact(pending).slice(-8000)}\n`); } catch {} } });
    };
    if (child.stdout) write(child.stdout);
    if (child.stderr) write(child.stderr);
    child.once('spawn', () => { if (record.status === 'starting') record.status = 'running'; this.changed(); });
    child.once('error', error => { record.status = 'failed'; record.error = error.message.slice(0, 500); this.children.delete(id); this.changed(); });
    child.once('exit', (code, signal) => {
      record.status = record.treeStopUnverified ? 'unknown' : 'stopped';
      record.exitCode = code; record.signal = signal; record.finishedAt = new Date().toISOString();
      if (record.treeStopUnverified) record.error = '실행 관리 프로세스는 종료됐지만 Windows가 자식 프로세스 트리 종료를 확인하지 못했습니다. HTTP 응답이나 작업 관리자에서 대상 서비스가 멈췄는지 확인하세요.';
      this.children.delete(id); this.changed();
    });
    child.once('close', () => { try { fs.closeSync(logDescriptor); } catch {} });
    child.unref();
    this.changed();
    await new Promise(resolve => setTimeout(resolve, 150));
    return this.status(record);
  }

  async processCommand(pid) {
    if (process.platform === 'win32') {
      const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}'; if ($p) { [Console]::Out.Write($p.CommandLine) }`;
      return new Promise(resolve => {
        const child = this.spawnProcess('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command',script], { windowsHide:true, stdio:['ignore','pipe','ignore'] });
        let output = ''; child.stdout.setEncoding('utf8').on('data', chunk => { output = (output + chunk).slice(-4000); });
        child.once('error', () => resolve('')); child.once('close', code => resolve(code === 0 ? output : ''));
      });
    }
    try { return fs.readFileSync(`/proc/${Number(pid)}/cmdline`, 'utf8').replaceAll('\0',' '); } catch { return ''; }
  }

  async status(record) {
    if (this.children.has(record.id)) return { ...this.publicRecord(record) };
    const commandLine = await this.processCommand(record.pid);
    const recognizable = this.matchesManagedCommand(commandLine,record.script);
    if (recognizable) record.status = 'running';
    else if (record.status === 'checking' || record.status === 'running' || record.status === 'starting') record.status = 'unknown';
    this.changed();
    return this.publicRecord(record);
  }

  publicRecord(record) {
    const { logFile, ...result } = record;
    return { ...result };
  }

  matchesManagedCommand(commandLine, script) {
    if (!commandLine) return false;
    const escaped = script.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return new RegExp(`(?:npm(?:\\.cmd)?\\s+run\\s+|npm-cli\\.js"?\\s+run\\s+)"?${escaped}(?:"|\\s|$)`,'i').test(commandLine);
  }

  async stop(record) {
    if (record.status === 'stopped') return this.publicRecord(record);
    if (this.children.has(record.id)) {
      if (process.platform === 'win32') {
        const result = await this.killWindowsTree(record.pid);
        if (result.code === 0) {
          record.status = 'stopped'; record.finishedAt = new Date().toISOString(); record.exitCode = null;
        } else {
          const child = this.children.get(record.id);
          record.treeStopUnverified = true;
          record.status = 'stopping';
          record.error = `프로세스 트리 종료를 확인하지 못해 Agent Desk가 직접 실행 프로세스에 종료 신호를 보냈습니다.${result.output ? ` ${result.output}` : ''}`.slice(0,500);
          let signalled = false;
          try { signalled = child.kill('SIGTERM'); } catch {}
          if (signalled) {
            const timer = setTimeout(() => {
              if (record.status === 'stopping') { record.status = 'unknown'; this.changed(); }
            }, 5000);
            timer.unref();
          } else {
            record.treeStopUnverified = false;
            record.status = 'unknown'; record.error = result.error || `Windows가 프로세스 종료를 확인하지 못했습니다${result.output ? `: ${result.output}` : ` (taskkill ${result.code ?? '실행 오류'})`}`;
          }
        }
      } else {
        try { process.kill(-record.pid, 'SIGTERM'); record.status = 'stopping'; }
        catch (error) { record.status = 'unknown'; record.error = `프로세스 종료 신호를 보내지 못했습니다: ${String(error.message || error).slice(0,300)}`; }
      }
      this.changed();
      return this.publicRecord(record);
    }
    const commandLine = await this.processCommand(record.pid);
    const recognizable = this.matchesManagedCommand(commandLine,record.script);
    if (!recognizable) throw new Error('프로세스 ID를 같은 개발 스크립트로 확인할 수 없어 안전을 위해 종료하지 않았습니다.');
    if (process.platform === 'win32') {
      const result = await this.killWindowsTree(record.pid);
      if (result.code !== 0) {
        record.status = 'unknown'; record.error = result.error || `Windows가 프로세스 종료를 확인하지 못했습니다${result.output ? `: ${result.output}` : ` (taskkill ${result.code ?? '실행 오류'})`}`;
        this.changed(); return this.publicRecord(record);
      }
    } else {
      try { process.kill(-record.pid, 'SIGTERM'); }
      catch (error) { record.status = 'unknown'; record.error = `프로세스 종료 신호를 보내지 못했습니다: ${String(error.message || error).slice(0,300)}`; this.changed(); return this.publicRecord(record); }
    }
    record.status = 'stopped'; record.finishedAt = new Date().toISOString(); this.changed();
    return this.publicRecord(record);
  }

  killWindowsTree(pid) {
    return new Promise(resolve => {
      let output = '';
      const killer = this.spawnProcess('taskkill.exe', ['/PID',String(Number(pid)),'/T','/F'], { windowsHide:true, stdio:['ignore','pipe','pipe'] });
      for (const stream of [killer.stdout,killer.stderr]) if (stream) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-1000); });
      killer.once('error', error => resolve({ code:null, error:String(error.message || error).slice(0,300), output:redact(output) }));
      killer.once('close', code => resolve({ code, output:redact(output).trim() }));
    });
  }

  logs(record, lineCount = 100) {
    const lines = Math.max(1, Math.min(300, Number(lineCount) || 100));
    const output = fs.existsSync(record.logFile) ? fs.readFileSync(record.logFile, 'utf8').split(/\r?\n/).slice(-lines).join('\n') : '';
    return { ...this.publicRecord(record), output:output.slice(-12000) };
  }

  async probe(value) {
    let url;
    try { url = new URL(String(value || '')); } catch { throw new Error('확인할 로컬 HTTP 주소를 입력해 주세요.'); }
    const host = url.hostname.toLowerCase();
    const local = host === 'localhost' || host === '::1' || host === '[::1]' || host === '127.0.0.1' || host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (!['http:','https:'].includes(url.protocol) || !local || url.username || url.password) throw new Error('상태 확인은 localhost 또는 사설 네트워크의 HTTP 주소만 허용합니다.');
    try {
      const response = await fetch(url, { redirect:'manual', signal:AbortSignal.timeout(5000) });
      return { url:url.href, status:response.status, ok:response.ok, checkedAt:new Date().toISOString() };
    } catch (error) { return { url:url.href, status:null, ok:false, checkedAt:new Date().toISOString(), error:String(error.message || error).slice(0,300) }; }
  }
}
