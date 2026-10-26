import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LocalProcessManager } from '../lib/local-process-manager.mjs';

class FakeChild extends EventEmitter {
  constructor(pid = 4321) { super(); this.pid = pid; this.stdout = new PassThrough(); this.stderr = new PassThrough(); }
  unref() {}
  kill() { this.emit('exit',0,'SIGTERM'); }
}

test('local process manager lists, starts, logs, probes, and stops only project development scripts', async t => {
  mkdirSync(path.resolve('.runtime/tests'),{ recursive:true });
  const root = mkdtempSync(path.resolve('.runtime/tests/process-manager-'));
  const projectPath = path.join(root,'project');
  mkdirSync(projectPath,{ recursive:true });
  writeFileSync(path.join(projectPath,'package.json'),JSON.stringify({ scripts:{ dev:'expo start', 'start:android':'expo start --android', test:'node test.js', build:'vite build' } }));
  t.after(() => { if (path.resolve(root).startsWith(path.resolve('.runtime/tests') + path.sep)) rmSync(root,{ recursive:true,force:true }); });
  const project = { id:'project-1',name:'Test',path:projectPath,allowLocalProcesses:false };
  const calls = [];
  const manager = new LocalProcessManager({ dataDirectory:path.join(root,'data'),projects:() => [project],spawnProcess:(command,args,options) => {
    calls.push({ command,args,options });
    const child = new FakeChild();
    queueMicrotask(() => { child.emit('spawn'); if (command === 'taskkill.exe') child.emit('close',0); });
    return child;
  } });

  const scripts = await manager.run(project.id,{ action:'scripts' });
  assert.deepEqual(scripts.scripts.map(item => item.name),['dev','start:android']);
  assert.equal(scripts.allowed,false);
  assert.equal(manager.matchesManagedCommand('"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" run dev','dev'),true);
  await assert.rejects(manager.run(project.id,{ action:'start',script:'dev' }),/로컬 프로세스 관리 허용/);
  project.allowLocalProcesses = true;
  await assert.rejects(manager.run(project.id,{ action:'start',script:'dev',args:['--port','8081;&whoami'] }),/실행 인자/);

  const started = await manager.run(project.id,{ action:'start',script:'start:android',args:['--dev-client','--lan','--port','8081','--android'] });
  assert.equal(started.status,'running');
  assert.equal(calls[0].options.cwd,projectPath);
  assert.equal(calls[0].options.detached,true);
  assert.ok(calls[0].args.join(' ').includes('start:android'));
  const child = manager.children.get(started.id);
  child.stdout.write('password=hunter2\nready on http://127.0.0.1:8081\n');
  await new Promise(resolve => setTimeout(resolve,10));
  const logs = await manager.run(project.id,{ action:'logs',processId:started.id });
  assert.match(logs.output,/ready on http/);
  assert.match(logs.output,/REDACTED/);
  assert.doesNotMatch(logs.output,/hunter2/);
  await assert.rejects(manager.run(project.id,{ action:'probe',url:'https://example.com' }),/사설 네트워크/);

  const stopping = await manager.run(project.id,{ action:'stop',processId:started.id });
  assert.equal(stopping.status,'stopped');
  child.emit('exit',0,'SIGTERM');
  assert.equal(manager.snapshot()[0].status,'stopped');
  assert.ok(Array.isArray(JSON.parse(readFileSync(path.join(root,'data','local-processes.json'),'utf8'))));
});

test('failed Windows process-tree termination is reported as unverified', async t => {
  if (process.platform !== 'win32') return t.skip('Windows process-tree behavior');
  const root = mkdtempSync(path.resolve('.runtime/tests/process-manager-stop-'));
  const projectPath = path.join(root,'project'); mkdirSync(projectPath,{ recursive:true });
  writeFileSync(path.join(projectPath,'package.json'),JSON.stringify({ scripts:{ dev:'node app.js' } }));
  t.after(() => { if (path.resolve(root).startsWith(path.resolve('.runtime/tests') + path.sep)) rmSync(root,{ recursive:true,force:true }); });
  const project = { id:'stop-test',name:'Stop test',path:projectPath,allowLocalProcesses:true };
  const manager = new LocalProcessManager({ dataDirectory:path.join(root,'data'),projects:() => [project],spawnProcess:(command) => {
    const child = new FakeChild(command === 'taskkill.exe' ? 9001 : 9000);
    queueMicrotask(() => child.emit('spawn'));
    if (command === 'taskkill.exe') queueMicrotask(() => child.emit('close',1));
    return child;
  } });
  const started = await manager.run(project.id,{ action:'start',script:'dev' });
  const stopped = await manager.run(project.id,{ action:'stop',processId:started.id });
  assert.equal(stopped.status,'unknown');
  assert.match(stopped.error,/확인하지 못했습니다|종료는 확인되지 않았습니다/);
});
