import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CodexClient } from './lib/codex.mjs';
import { Store } from './lib/store.mjs';
import { AgentHub } from './lib/hub.mjs';
import { imagePath } from './lib/images.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.AGENT_DESK_PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('유효한 포트가 필요합니다.');
const store = new Store(process.env.AGENT_DESK_DATA || path.join(directory, 'data'), path.dirname(directory));
const client = new CodexClient({ cwd: directory });
const hub = new AgentHub(store, client);
const csrf = randomBytes(32).toString('hex');
const streams = new Set();
const host = `127.0.0.1:${port}`;
const origin = `http://${host}`;
const json = (response, status, data) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); };
const sendState = response => response.write(`event: state\ndata: ${JSON.stringify(hub.snapshot())}\n\n`);
hub.on('state', () => { for (const response of streams) sendState(response); });
const usageTimer = setInterval(() => hub.refreshUsageLimits(!!hub.active).catch(() => {}), 5_000);
usageTimer.unref();

function runPicker(command, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: env || process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errorOutput = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output = (output + chunk).slice(-4000); });
    child.stderr.setEncoding('utf8').on('data', chunk => { errorOutput = (errorOutput + chunk).slice(-2000); });
    child.once('error', error => reject(error));
    child.once('close', code => {
      if (code === 0) resolve(output.trim());
      else if (code === 1) resolve('');
      else reject(new Error(errorOutput.trim() || `${command} 실행에 실패했습니다.`));
    });
  });
}

async function pickDirectory(startPath = '') {
  if (process.platform === 'win32') {
    const initial = Buffer.from(startPath, 'utf8').toString('base64');
    const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; $initial=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AGENT_DESK_PICKER_START)); $picker=New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description='프로젝트 폴더 선택'; $picker.ShowNewFolderButton=$false; if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) { $picker.SelectedPath=$initial }; if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($picker.SelectedPath) }";
    return runPicker('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-Command', script], { env: { ...process.env, AGENT_DESK_PICKER_START: initial } });
  }
  if (process.platform === 'darwin') {
    const escapedStart = startPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const chooser = `set pickedFolder to choose folder with prompt "프로젝트 폴더 선택"${startPath ? ` default location POSIX file "${escapedStart}"` : ''}\nreturn POSIX path of pickedFolder`;
    return runPicker('osascript', ['-e', chooser]);
  }
  if (process.platform === 'linux') {
    const args = ['--file-selection', '--directory', '--title=프로젝트 폴더 선택'];
    if (startPath) args.push(`--filename=${path.join(startPath, path.sep)}`);
    try { return await runPicker('zenity', args); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { return await runPicker('kdialog', ['--getexistingdirectory', startPath || '/', '--title', '프로젝트 폴더 선택']); }
      catch (fallbackError) {
        if (fallbackError.code === 'ENOENT') throw new Error('폴더 선택 창을 열려면 zenity 또는 kdialog를 설치해 주세요.');
        throw fallbackError;
      }
    }
  }
  throw new Error('이 운영체제에서는 폴더 선택 창을 지원하지 않습니다.');
}

async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('JSON 요청이 필요합니다.');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > 22 * 1024 * 1024) throw new Error('요청이 너무 큽니다.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (request.headers.host !== host) return json(response, 403, { error: '로컬 주소로 접속해 주세요.' });
  if (request.headers.origin && request.headers.origin !== origin) return json(response, 403, { error: '다른 웹사이트에서의 접근은 허용되지 않습니다.' });
  const url = new URL(request.url, origin);
  try {
    if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, { ok: true, connection: hub.connection.status, activeRunId: hub.active?.run.id || null, pid: process.pid, appDirectory: directory, quotaWindowReset: 'continue', usageWindowDriftToleranceSeconds: 300, quotaResumeIncrement: 5 });
    if (request.method === 'GET' && url.pathname === '/api/state') return json(response, 200, { ...hub.snapshot(), csrf });
    if (request.method === 'GET' && /^\/api\/attachments\/[0-9a-f-]{36}$/.test(url.pathname)) {
      const id = url.pathname.split('/').at(-1);
      const image = store.state.runs.flatMap(run => run.images || []).find(item => item.id === id);
      if (!image) return json(response, 404, { error: '첨부 이미지를 찾을 수 없습니다.' });
      const filename = imagePath(store.directory, image);
      if (!fs.existsSync(filename)) return json(response, 404, { error: '첨부 이미지 파일이 없습니다.' });
      response.writeHead(200, { 'Content-Type': image.mimeType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
      fs.createReadStream(filename).pipe(response); return;
    }
    if (request.method === 'GET' && url.pathname === '/api/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      response.write('retry: 2000\n\n'); streams.add(response); sendState(response);
      const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 20000);
      request.on('close', () => { clearInterval(heartbeat); streams.delete(response); }); return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (request.method !== 'POST' || request.headers['x-agent-desk-token'] !== csrf) return json(response, 403, { error: '페이지를 새로고침한 뒤 다시 시도해 주세요.' });
      const input = await body(request);
      if (url.pathname === '/api/runs') return json(response, 202, { id: (await hub.start(input)).id });
      if (url.pathname === '/api/runs/resume') return json(response, 202, { id: (await hub.resume(input.id, input.additionalUsagePercent ?? 0)).id });
      if (url.pathname === '/api/cancel') { await hub.cancel(input.id); return json(response, 200, { ok: true }); }
      if (url.pathname === '/api/agents') return json(response, 200, hub.saveAgent(input, input.id));
      if (url.pathname === '/api/agents/delete') { hub.deleteAgent(input.id); return json(response, 200, { ok: true }); }
      if (url.pathname === '/api/skills') return json(response, 200, hub.saveSkill(input, input.id));
      if (url.pathname === '/api/skills/delete') { hub.deleteSkill(input.id); return json(response, 200, { ok: true }); }
      if (url.pathname === '/api/projects') return json(response, 200, hub.saveProject(input));
      if (url.pathname === '/api/projects/browse') {
        hub.requireIdle();
        const selectedPath = await pickDirectory(typeof input.path === 'string' ? input.path : '');
        return json(response, 200, { path: selectedPath || null });
      }
      if (url.pathname === '/api/settings') { hub.saveSettings(input); return json(response, 200, { ok: true }); }
      if (url.pathname === '/api/approvals') { hub.answerApproval(input.id, input); return json(response, 200, { ok: true }); }
      if (url.pathname === '/api/reconnect') { hub.requireIdle(); await hub.connect(); return json(response, 200, hub.connection); }
      if (url.pathname === '/api/usage-limits/refresh') return json(response, 200, await hub.refreshUsageLimits(true, true));
      if (url.pathname === '/api/shutdown') { json(response, 200, { ok: true }); setTimeout(() => shutdown(), 50); return; }
      return json(response, 404, { error: '요청한 기능을 찾을 수 없습니다.' });
    }
    if (!['GET', 'HEAD'].includes(request.method)) return json(response, 405, { error: '지원하지 않는 요청입니다.' });
    const publicRoot = path.join(directory, 'public');
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const filename = path.resolve(publicRoot, `.${relative}`);
    if (!filename.startsWith(`${publicRoot}${path.sep}`)) return json(response, 403, { error: '접근할 수 없습니다.' });
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) return json(response, 404, { error: '파일을 찾을 수 없습니다.' });
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
    response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    if (request.method === 'HEAD') response.end(); else fs.createReadStream(filename).pipe(response);
  } catch (error) { if (!response.headersSent) json(response, 400, { error: error.message }); else response.end(); }
});
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `${port} 포트가 사용 중입니다. 이미 실행 중인 Agent Desk를 확인해 주세요.` : error.message); process.exitCode = 1; client.close(); });
server.listen(port, '127.0.0.1', () => {
  console.log(`Agent Desk Local: ${origin}`);
  hub.connect().catch(error => console.error(error.message));
});
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  clearInterval(usageTimer);
  for (const response of streams) response.end();
  await hub.close(); server.close(); setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
