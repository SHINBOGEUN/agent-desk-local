import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const projectRefPattern = /^[a-z0-9]{20}$/i;
const migrationPattern = /^\d{12,14}_[a-z0-9_-]+\.sql$/i;
const hash = value => createHash('sha256').update(value).digest('hex');

function powershell(script, { input = '', env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout = (stdout + chunk).slice(-100_000); });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-8_000); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || 'Windows 보안 저장소 작업에 실패했습니다.')));
    child.stdin.end(input);
  });
}

async function protectSecret(value) {
  if (process.platform !== 'win32') throw new Error('현재 보안 저장은 Windows 계정의 DPAPI를 사용합니다. 이 기능은 Agent Desk를 실행 중인 Windows PC에서 설정해 주세요.');
  return powershell("$ErrorActionPreference='Stop'; $plain=[Console]::In.ReadToEnd(); $secure=ConvertTo-SecureString $plain -AsPlainText -Force; [Console]::Out.Write((ConvertFrom-SecureString $secure))", { input: value });
}

async function revealSecret(value) {
  if (process.platform !== 'win32') throw new Error('현재 PC에서만 복호화할 수 있는 Windows 보안 저장값입니다.');
  return powershell("$ErrorActionPreference='Stop'; $secure=ConvertTo-SecureString ([Console]::In.ReadToEnd()); $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }", { input: value });
}

function runProcess(command, args, { cwd, env = {}, input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout = (stdout + chunk).slice(-100_000); });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-20_000); });
    child.once('error', error => finish(error));
    child.once('close', code => finish(null, { code, stdout: stdout.trim(), stderr: stderr.trim() }));
    const timer = setTimeout(() => { child.kill(); finish(new Error('Supabase 작업이 제한 시간 안에 끝나지 않았습니다.')); }, timeoutMs);
    child.stdin.end(input);
  });
}

export class SupabaseManager {
  constructor({ dataDirectory, projects, platform = process.platform, encrypt = protectSecret, decrypt = revealSecret, run = runProcess }) {
    this.dataDirectory = dataDirectory;
    this.projects = projects;
    this.platform = platform;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.run = run;
    this.secretFile = path.join(dataDirectory, 'supabase-connections.json');
    this.toolDirectory = path.join(dataDirectory, 'tools', 'supabase-cli');
    this.previews = new Map();
  }

  readSecrets() {
    try { return JSON.parse(fs.readFileSync(this.secretFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('Supabase 연결 저장 파일을 읽을 수 없습니다.'); }
  }

  writeSecrets(secrets) {
    fs.mkdirSync(this.dataDirectory, { recursive: true });
    const temporary = `${this.secretFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(secrets, null, 2), { encoding: 'utf8', mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, this.secretFile); break; }
      catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 5) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
      }
    }
  }

  project(id) {
    const project = this.projects().find(item => item.id === id);
    if (!project) throw new Error('연결된 Agent Desk 프로젝트를 선택해 주세요.');
    return project;
  }

  config(id) { return this.readSecrets()[id] || null; }

  async configure({ projectId, projectRef, accessToken, databasePassword }) {
    this.project(projectId);
    if (typeof projectRef !== 'string' || !projectRefPattern.test(projectRef.trim())) throw new Error('Supabase 프로젝트 ref는 20자리 영문 소문자와 숫자로 입력해 주세요.');
    const all = this.readSecrets();
    const previous = all[projectId] || {};
    const token = typeof accessToken === 'string' ? accessToken.trim() : '';
    const password = typeof databasePassword === 'string' ? databasePassword : '';
    if (token && (token.length < 20 || token.length > 5000)) throw new Error('Supabase 액세스 토큰 형식을 확인해 주세요.');
    if (password.length > 1000) throw new Error('데이터베이스 비밀번호가 너무 깁니다.');
    if (!token && !previous.accessToken) throw new Error('Supabase Personal Access Token을 입력해 주세요.');
    all[projectId] = {
      projectRef: projectRef.trim(),
      accessToken: token ? await this.encrypt(token) : previous.accessToken,
      databasePassword: password ? await this.encrypt(password) : previous.databasePassword || '',
      configuredAt: new Date().toISOString(),
    };
    this.writeSecrets(all);
    this.previews.delete(projectId);
    return this.status(projectId);
  }

  disconnect(projectId) {
    this.project(projectId);
    const all = this.readSecrets(); delete all[projectId]; this.writeSecrets(all); this.previews.delete(projectId);
    return { projectId, configured: false, projectRef: null, hasAccessToken: false, hasDatabasePassword: false, cliInstalled: this.cliInstalled() };
  }

  cliInstalled() {
    const binary = path.join(this.toolDirectory, 'node_modules', '.bin', this.platform === 'win32' ? 'supabase.cmd' : 'supabase');
    return fs.existsSync(binary);
  }

  async installCli() {
    fs.mkdirSync(this.toolDirectory, { recursive: true });
    const script = "$ErrorActionPreference='Stop'; npm.cmd install --prefix $env:AGENT_DESK_SUPABASE_TOOL_DIR --no-save --package-lock=false supabase";
    const result = this.platform === 'win32'
      ? await this.run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { cwd: this.toolDirectory, env: { AGENT_DESK_SUPABASE_TOOL_DIR: this.toolDirectory }, timeoutMs: 300_000 })
      : await this.run('npm', ['install', '--prefix', this.toolDirectory, '--no-save', '--package-lock=false', 'supabase'], { cwd: this.toolDirectory, timeoutMs: 300_000 });
    if (result.code !== 0 || !this.cliInstalled()) throw new Error((result.stderr || result.stdout || 'Supabase CLI 설치를 확인하지 못했습니다.').slice(-3000));
    return { installed: true };
  }

  async cli(args, { cwd, config, password = true, timeoutMs } = {}) {
    if (!this.cliInstalled()) throw new Error('먼저 이 화면에서 Supabase CLI를 설치해 주세요.');
    const token = await this.decrypt(config.accessToken);
    const dbPassword = password && config.databasePassword ? await this.decrypt(config.databasePassword) : '';
    const env = { SUPABASE_ACCESS_TOKEN: token, SUPABASE_DB_PASSWORD: dbPassword };
    const binary = path.join(this.toolDirectory, 'node_modules', '.bin', this.platform === 'win32' ? 'supabase.cmd' : 'supabase');
    if (this.platform === 'win32') {
      const script = "$ErrorActionPreference='Stop'; $argList=ConvertFrom-Json -InputObject $env:AGENT_DESK_SUPABASE_ARGS; $cli=Join-Path $env:AGENT_DESK_SUPABASE_TOOL_DIR 'node_modules/.bin/supabase.cmd'; & $cli @argList; exit $LASTEXITCODE";
      const result = await this.run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { cwd, env: { ...env, AGENT_DESK_SUPABASE_TOOL_DIR: this.toolDirectory, AGENT_DESK_SUPABASE_ARGS: JSON.stringify(args) }, timeoutMs });
      return result;
    }
    return this.run(binary, args, { cwd, env, timeoutMs });
  }

  workspace(projectId) { return path.join(this.dataDirectory, 'supabase-workspaces', hash(projectId).slice(0, 24)); }

  async prepare(projectId) {
    const project = this.project(projectId), config = this.config(projectId);
    if (!config?.accessToken || !config.projectRef) throw new Error('먼저 Supabase 프로젝트 ref와 Personal Access Token을 저장해 주세요.');
    if (!this.cliInstalled()) throw new Error('먼저 Supabase CLI를 설치해 주세요.');
    const source = path.join(project.path, 'supabase', 'migrations');
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error('연결한 프로젝트에 supabase/migrations 폴더가 없습니다.');
    const files = fs.readdirSync(source, { withFileTypes: true }).filter(entry => entry.isFile() && migrationPattern.test(entry.name)).map(entry => entry.name).sort();
    if (!files.length) throw new Error('적용할 수 있는 타임스탬프 형식의 SQL 마이그레이션 파일이 없습니다.');
    if (files.length > 200) throw new Error('마이그레이션 파일이 200개를 넘어 자동 미리보기를 중단했습니다.');
    const workspace = this.workspace(projectId), migrationDir = path.join(workspace, 'supabase', 'migrations');
    fs.mkdirSync(migrationDir, { recursive: true });
    let bytes = 0;
    const local = files.map(name => {
      const content = fs.readFileSync(path.join(source, name)); bytes += content.length;
      fs.writeFileSync(path.join(migrationDir, name), content);
      return { name, hash: hash(content), size: content.length };
    });
    for (const entry of fs.readdirSync(migrationDir, { withFileTypes: true })) if (entry.isFile() && migrationPattern.test(entry.name) && !files.includes(entry.name)) fs.rmSync(path.join(migrationDir, entry.name));
    if (bytes > 10 * 1024 * 1024) throw new Error('마이그레이션 파일 총 크기가 10MB를 넘어 자동 미리보기를 중단했습니다.');
    const configFile = path.join(workspace, 'supabase', 'config.toml');
    if (!fs.existsSync(configFile)) {
      const initialized = await this.cli(['init'], { cwd: workspace, config, password: false });
      if (initialized.code !== 0 || !fs.existsSync(configFile)) throw new Error((initialized.stderr || initialized.stdout || '격리된 Supabase 작업공간을 초기화하지 못했습니다.').slice(-3000));
    }
    const linkedRefFile = path.join(workspace, 'supabase', '.temp', 'project-ref');
    const linkedRef = fs.existsSync(linkedRefFile) ? fs.readFileSync(linkedRefFile, 'utf8').trim() : '';
    if (linkedRef !== config.projectRef) {
      if (linkedRef) await this.cli(['unlink'], { cwd: workspace, config, password: false });
      const linked = await this.cli(['link', '--project-ref', config.projectRef], { cwd: workspace, config });
      if (linked.code !== 0) throw new Error((linked.stderr || linked.stdout || 'Supabase 프로젝트 연결에 실패했습니다.').slice(-3000));
    }
    return { project, config, workspace, local };
  }

  async status(projectId) {
    const project = this.project(projectId), config = this.config(projectId);
    const migrationDir = path.join(project.path, 'supabase', 'migrations');
    const localMigrations = fs.existsSync(migrationDir) ? fs.readdirSync(migrationDir, { withFileTypes: true }).filter(entry => entry.isFile() && migrationPattern.test(entry.name)).map(entry => entry.name).sort() : [];
    return { projectId, configured: !!config, projectRef: config?.projectRef || '', hasAccessToken: !!config?.accessToken, hasDatabasePassword: !!config?.databasePassword, cliInstalled: this.cliInstalled(), localMigrations };
  }

  async preview(projectId, expectedProjectRef = '') {
    const savedConfig = this.config(projectId);
    if (expectedProjectRef && savedConfig?.projectRef !== expectedProjectRef) {
      throw new Error(`저장된 Supabase 프로젝트 ref가 요청한 대상과 다릅니다. 연결 ref: ${savedConfig?.projectRef || '없음'}, 요청 대상: ${expectedProjectRef}`);
    }
    const { config, workspace, local } = await this.prepare(projectId);
    if (expectedProjectRef && config.projectRef !== expectedProjectRef) throw new Error('Supabase 프로젝트 ref가 미리보기 직전에 변경되어 실행을 중단했습니다.');
    const result = await this.cli(['db', 'push', '--linked', '--dry-run'], { cwd: workspace, config });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').slice(-20_000);
    if (result.code !== 0) throw new Error(output || '미리보기 명령이 실패했습니다.');
    const names = [...new Set(output.match(/\b\d{12,14}_[a-z0-9_-]+\.sql\b/gi) || [])];
    const versions = new Set(output.match(/\b\d{12,14}\b/g) || []);
    const pending = local.filter(file => names.includes(file.name) || versions.has(file.name.split('_', 1)[0]));
    const upToDate = /up to date|no pending|nothing to push/i.test(output);
    if (!pending.length && !upToDate) throw new Error(`CLI 미리보기 결과에서 적용 대기 파일을 확인할 수 없어 실행을 보류했습니다.\n${output}`);
    const id = randomUUID();
    const signature = hash(JSON.stringify({ projectRef: config.projectRef, pending, local }));
    this.previews.set(id, { projectId, signature, expiresAt: Date.now() + 5 * 60_000 });
    return { previewId: id, projectRef: config.projectRef, pending: pending.map(({ name, size }) => ({ name, size })), localCount: local.length, output, canApply: pending.length > 0 };
  }

  async apply(projectId, previewId) {
    const approved = this.previews.get(previewId);
    if (!approved || approved.projectId !== projectId || approved.expiresAt < Date.now()) throw new Error('미리보기가 만료됐습니다. 다시 미리보기한 뒤 적용해 주세요.');
    this.previews.delete(previewId);
    const fresh = await this.preview(projectId);
    const next = this.previews.get(fresh.previewId); this.previews.delete(fresh.previewId);
    if (approved.signature !== next?.signature) throw new Error('미리보기 뒤 프로젝트 또는 원격 마이그레이션 상태가 바뀌었습니다. 새 미리보기에서 다시 확인해 주세요.');
    if (!fresh.canApply) return { applied: false, output: '적용 대기 마이그레이션이 없습니다.' };
    const { config, workspace } = await this.prepare(projectId);
    const result = await this.cli(['db', 'push', '--linked'], { cwd: workspace, config, timeoutMs: 300_000 });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').slice(-20_000);
    if (result.code !== 0) throw new Error(output || '마이그레이션 적용에 실패했습니다.');
    return { applied: true, projectRef: config.projectRef, output };
  }
}
