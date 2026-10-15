import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Store, validateAgent, validateSettings, defaultAgents } from '../lib/store.mjs';
import { AgentHub } from '../lib/hub.mjs';

class FakeClient extends EventEmitter {
  constructor(mode = 'complete') { super(); this.mode = mode; this.calls = []; this.responses = []; this.threadNumber = 0; this.connected = true; }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: `thread-${++this.threadNumber}` } };
    if (method === 'turn/start') {
      const id = `turn-${params.threadId}`;
      this.emit('notification', { method:'turn/started', params:{ threadId:params.threadId, turn:{ id } } });
      if (this.mode === 'complete' || this.mode === 'hold-main' && params.threadId !== 'thread-1') setTimeout(() => {
        const answer = params.threadId === 'thread-1' && this.refinerAnswer !== undefined ? this.refinerAnswer : '실행 결과';
        this.emit('notification', { method:'thread/tokenUsage/updated', params:{ threadId:params.threadId, tokenUsage:{ total:{ totalTokens:30,inputTokens:20,outputTokens:10,cachedInputTokens:5 } } } });
        this.emit('notification', { method:'item/completed', params:{ threadId:params.threadId, item:{ id:'answer',type:'agentMessage',phase:'final_answer',text:answer } } });
        this.emit('notification', { method:'turn/completed', params:{ threadId:params.threadId, turn:{ id,status:'completed' } } });
      },5);
      return { turn:{ id } };
    }
    return {};
  }
  respond(id,result) { this.responses.push({ id,result }); }
  rejectRequest(id,message) { this.responses.push({ id,error:message }); }
  close() {}
}

function fixture(t, mode) {
  const testRoot = path.resolve('.runtime', 'tests');
  mkdirSync(testRoot, { recursive:true });
  const directory = mkdtempSync(path.join(testRoot,'agent-desk-test-'));
  const store = new Store(directory, process.cwd()); const client = new FakeClient(mode); const hub = new AgentHub(store,client);
  hub.connection = { status:'connected' }; hub.models = [{ id:'test-model',isDefault:true,efforts:['low','medium'] }];
  t.after(() => { clearTimeout(hub.saveTimer); clearTimeout(hub.emitTimer); assert.ok(path.resolve(directory).startsWith(testRoot + path.sep)); rmSync(directory,{ recursive:true,force:true }); });
  return { store,client,hub };
}
const settle = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve,10)); } throw new Error('did not settle'); };

test('agent validation prevents making the main agent writable or inactive', () => {
  const result = validateAgent({ ...defaultAgents[0], access:'workspace-write',enabled:false });
  assert.equal(result.access,'read-only'); assert.equal(result.enabled,true);
  assert.throws(() => validateAgent({ ...defaultAgents[1], instructions:'' }));
  assert.throws(() => validateSettings({ concurrency:100,maxDelegations:6,timeoutMinutes:15,tokenBudget:100000 }));
});

test('model-specific reasoning effort is saved only when supported', t => {
  const { hub } = fixture(t);
  hub.models = [
    { id:'gpt-6-sol',isDefault:false,efforts:['low','medium','high','xhigh','max','ultra'] },
    { id:'gpt-6-luna',isDefault:true,efforts:['low','medium','high','xhigh','max'] },
  ];
  const main = hub.saveAgent({ model:'gpt-6-sol',effort:'high' },'main');
  const worker = hub.saveAgent({ model:'gpt-6-luna',effort:'high' },'worker');
  assert.equal(main.model,'gpt-6-sol'); assert.equal(main.effort,'high');
  assert.equal(worker.model,'gpt-6-luna'); assert.equal(worker.effort,'high');
  assert.throws(() => hub.saveAgent({ model:'gpt-6-luna',effort:'ultra' },'worker'),/추론 수준/);
});

test('real event lifecycle yields completed report and counts usage once', async t => {
  const { hub,client } = fixture(t);
  const run = await hub.start({ projectId:'default',message:'상태 확인' });
  assert.throws(() => hub.saveSettings({}),/진행 중/);
  await settle(() => !hub.active);
  assert.equal(run.status,'completed'); assert.equal(run.answer,'실행 결과'); assert.equal(run.usage.totalTokens,30);
  assert.equal(hub.snapshot().runtime[0].status,'idle');
  const thread = client.calls.find(item => item.method === 'thread/start').params;
  assert.equal(thread.sandbox,'read-only'); assert.equal(thread.config['features.shell_tool'],false);
  assert.equal(thread.dynamicTools[0].name,'agent_desk_run');
});

test('prompt refinement runs first only when enabled and preserves the original request', async t => {
  const { hub,client } = fixture(t);
  client.refinerAnswer = '목표: 화면 수정. 제약: 파일 삭제 금지.';
  const run = await hub.start({ projectId:'default',message:'화면 좀 수정해줘. 파일은 지우지 마.',refinePrompt:true });
  await settle(() => !hub.active);
  assert.equal(run.status,'completed');
  assert.equal(run.message,'화면 좀 수정해줘. 파일은 지우지 마.');
  assert.equal(run.promptRefinement.status,'completed');
  assert.equal(run.promptRefinement.text,client.refinerAnswer);
  assert.deepEqual(run.tasks.map(task => task.agentId),['prompt_refiner','main']);
  assert.equal(run.usage.totalTokens,60);
  const threads = client.calls.filter(call => call.method === 'thread/start');
  assert.equal(threads.length,2);
  assert.equal(threads[0].params.sandbox,'read-only');
  assert.equal(threads[0].params.config['features.shell_tool'],false);
  const turns = client.calls.filter(call => call.method === 'turn/start');
  assert.equal(turns[0].params.input[0].text,run.message);
  assert.match(turns[1].params.input[0].text,/사용자 원문 \(최우선\):/);
  assert.match(turns[1].params.input[0].text,/파일은 지우지 마/);
  assert.match(turns[1].params.input[0].text,/목표: 화면 수정/);
});

test('empty refinement falls back to the untouched original request', async t => {
  const { hub,client } = fixture(t);
  client.refinerAnswer = '';
  const run = await hub.start({ projectId:'default',message:'원문 그대로 처리',refinePrompt:true });
  await settle(() => !hub.active);
  assert.equal(run.status,'completed');
  assert.equal(run.promptRefinement.status,'failed');
  assert.equal(run.promptRefinement.text,'');
  const turns = client.calls.filter(call => call.method === 'turn/start');
  assert.equal(turns[1].params.input[0].text,'원문 그대로 처리');
});

test('stopping during refinement does not start the main AI', async t => {
  const { hub,client } = fixture(t,'hold');
  const run = await hub.start({ projectId:'default',message:'중단할 요청',refinePrompt:true });
  await settle(() => hub.contexts.size === 1);
  await hub.cancel(run.id);
  await settle(() => !hub.active);
  assert.equal(run.status,'interrupted');
  assert.deepEqual(run.tasks.map(task => task.agentId),['prompt_refiner']);
  assert.equal(client.calls.filter(call => call.method === 'thread/start').length,1);
});

test('cancellation interrupts every active context and returns agents to idle', async t => {
  const { hub,client } = fixture(t,'hold');
  const run = await hub.start({ projectId:'default',message:'긴 작업' });
  await settle(() => hub.contexts.size === 1);
  await hub.cancel(run.id);
  await settle(() => !hub.active);
  assert.equal(run.status,'interrupted'); assert.equal(run.tasks[0].status,'interrupted');
  assert.ok(client.calls.some(item => item.method === 'turn/interrupt'));
  assert.equal(hub.contexts.size,0);
});

test('worker write access requires both agent and project permission', async t => {
  const { hub,client } = fixture(t);
  const agent = defaultAgents.find(agent => agent.id === 'worker');
  for (const allowWrites of [false,true]) {
    const active = { run:{ tasks:[],events:[],usage:{ totalTokens:0 },limits:{ tokenBudget:100000 } },project:{ path:process.cwd(),allowWrites },cancelled:false };
    const task = hub.newTask(active.run,agent,'제작');
    await hub.turn(active,agent,task,'test','test');
    assert.equal(client.calls.filter(item => item.method === 'thread/start').at(-1).params.sandbox,allowWrites ? 'workspace-write' : 'read-only');
  }
});

test('delegation cap rejects a batch before any child starts', async t => {
  const { hub,client } = fixture(t,'hold');
  const run = await hub.start({ projectId:'default',message:'위임 요청' });
  await settle(() => hub.contexts.size === 1);
  const [threadId,context] = [...hub.contexts.entries()][0]; context.active.delegations = run.limits.maxDelegations;
  await hub.serverRequest({ id:999,method:'item/tool/call',params:{ threadId,tool:'agent_desk_run',arguments:{ tasks:[{ agentId:'researcher',title:'조사',task:'조사해 주세요' }] } } });
  assert.equal(client.responses.at(-1).result.success,false);
  assert.equal(run.tasks.length,1);
  await hub.cancel(run.id); await settle(() => !hub.active);
});

test('selected completed reports are handed to a later agent and recorded', async t => {
  const { hub,client } = fixture(t,'hold-main');
  const run = await hub.start({ projectId:'default',message:'조사 후 구현' });
  await settle(() => hub.contexts.size === 1);
  const mainThread = [...hub.contexts.keys()][0];
  await hub.serverRequest({ id:201,method:'item/tool/call',params:{ threadId:mainThread,tool:'agent_desk_run',arguments:{ tasks:[{ agentId:'researcher',title:'API 조사',task:'API 구조를 조사해 주세요' }] } } });
  const source = run.tasks.find(task => task.agentId === 'researcher');
  assert.equal(source.status,'completed');
  source.output = '인계 자료: GET /items 응답 구조';
  await hub.serverRequest({ id:202,method:'item/tool/call',params:{ threadId:mainThread,tool:'agent_desk_run',arguments:{ tasks:[{ agentId:'worker',title:'API 구현',task:'조회 화면을 만드세요',contextFrom:[source.id] }] } } });
  const worker = run.tasks.find(task => task.agentId === 'worker');
  const workerTurn = client.calls.filter(call => call.method === 'turn/start').at(-1);
  assert.equal(worker.handoffFrom[0].taskId,source.id);
  assert.match(workerTurn.params.input[0].text,/GET \/items 응답 구조/);
  assert.ok(run.events.some(event => event.message.includes('선행 보고 1개 인계')));
  const turnsBefore = client.calls.filter(call => call.method === 'turn/start').length;
  await hub.serverRequest({ id:203,method:'item/tool/call',params:{ threadId:mainThread,tool:'agent_desk_run',arguments:{ tasks:[{ agentId:'verifier',title:'검증',task:'확인',contextFrom:['unknown-task'] }] } } });
  assert.equal(client.responses.at(-1).result.success,false);
  assert.equal(client.calls.filter(call => call.method === 'turn/start').length,turnsBefore);
  await hub.cancel(run.id); await settle(() => !hub.active);
});

test('monitor receives bounded history and only its completed report can update separate guidance', async t => {
  const { hub,client,store } = fixture(t,'hold-main');
  store.state.runs.unshift({ id:'previous',projectId:'default',message:'반복 조사',answer:'조사 완료',status:'completed',usage:{ totalTokens:120 },qualityGate:{ status:'not_required' },tasks:[{ id:'old-task',agentId:'researcher',title:'조사',status:'completed',usage:{ totalTokens:80 } }] });
  const run = await hub.start({ projectId:'default',message:'운영 점검' });
  await settle(() => hub.contexts.size === 1);
  const mainThread = [...hub.contexts.keys()][0];
  await hub.serverRequest({ id:301,method:'item/tool/call',params:{ threadId:mainThread,tool:'agent_desk_update_guidance',arguments:{ monitorTaskId:'missing',updates:[{ agentId:'researcher',guidance:'반복 조사를 피하고 먼저 최근 확인 결과를 확인하세요.' }] } } });
  assert.equal(client.responses.at(-1).result.success,false);
  await hub.serverRequest({ id:302,method:'item/tool/call',params:{ threadId:mainThread,tool:'agent_desk_run',arguments:{ tasks:[{ agentId:'monitor',title:'운영 점검',task:'최근 기록을 살펴보세요.' }] } } });
  const monitor = run.tasks.find(task => task.agentId === 'monitor');
  assert.equal(monitor.status,'completed');
  const monitorTurn = client.calls.filter(call => call.method === 'turn/start').at(-1);
  assert.match(monitorTurn.params.input[0].text,/반복 조사/);
  assert.match(monitorTurn.params.input[0].text,/120/);
  const guidance = '최근 결과가 있으면 같은 범위의 탐색을 반복하기 전에 기존 근거를 재사용하세요.';
  await hub.serverRequest({ id:303,method:'item/tool/call',params:{ threadId:mainThread,tool:'agent_desk_update_guidance',arguments:{ monitorTaskId:monitor.id,updates:[{ agentId:'researcher',guidance }] } } });
  assert.equal(client.responses.at(-1).result.success,true);
  assert.equal(store.state.agents.find(agent => agent.id === 'researcher').optimizationGuidance,guidance);
  assert.equal(store.state.agents.find(agent => agent.id === 'researcher').instructions,defaultAgents.find(agent => agent.id === 'researcher').instructions);
  await hub.serverRequest({ id:304,method:'item/tool/call',params:{ threadId:mainThread,tool:'agent_desk_run',arguments:{ tasks:[{ agentId:'researcher',title:'조사',task:'조사해 주세요.' }] } } });
  const researcherThread = client.calls.filter(call => call.method === 'thread/start').at(-1);
  assert.match(researcherThread.params.developerInstructions,/기존 근거를 재사용하세요/);
  await hub.cancel(run.id); await settle(() => !hub.active);
});

test('file changes require a PASS from a verifier after the last writer', t => {
  const { hub } = fixture(t);
  const base = { qualityGate:{ required:true,status:'pending' },tasks:[
    { id:'writer',agentId:'worker',writable:true,status:'completed',finishedAt:'2026-10-15T10:00:00.000Z' },
    { id:'verifier',agentId:'verifier',status:'completed',finishedAt:'2026-10-15T10:01:00.000Z',output:'[검증 결과: PASS]\n테스트 통과' },
  ] };
  hub.evaluateQualityGate(base);
  assert.equal(base.qualityGate.status,'passed');
  base.tasks[1].finishedAt = '2026-10-15T09:59:00.000Z';
  hub.evaluateQualityGate(base);
  assert.equal(base.qualityGate.status,'needs_review');
  base.tasks[1].finishedAt = '2026-10-15T10:01:00.000Z';
  base.tasks[1].output = '[검증 결과: FAIL]\n테스트 실패';
  hub.evaluateQualityGate(base);
  assert.equal(base.qualityGate.status,'failed');
});

test('persisted in-flight runs are marked interrupted on restart', t => {
  const { store } = fixture(t);
  store.state.runs.push({ id:'old',status:'running',tasks:[{ status:'working' }] }); store.save();
  const reopened = new Store(store.directory,process.cwd());
  assert.equal(reopened.state.runs[0].status,'interrupted'); assert.equal(reopened.state.runs[0].tasks[0].status,'interrupted');
});

test('legacy team gains the monitor and prompt refiner once', t => {
  const { store } = fixture(t);
  store.state.version = 1;
  store.state.agents = store.state.agents.filter(agent => agent.id !== 'monitor');
  store.save();
  const migrated = new Store(store.directory,process.cwd());
  assert.equal(migrated.state.version,3);
  assert.equal(migrated.state.agents.filter(agent => agent.id === 'monitor').length,1);
  assert.equal(migrated.state.agents.filter(agent => agent.id === 'prompt_refiner').length,1);
  migrated.state.agents = migrated.state.agents.filter(agent => agent.id !== 'monitor');
  migrated.save();
  assert.equal(new Store(store.directory,process.cwd()).state.agents.some(agent => agent.id === 'monitor'),false);
});

test('scheduler caps readers and keeps writes exclusive even across tool batches', async t => {
  const { hub } = fixture(t);
  const active = { cancelled:false,runningWorkers:0,busyWriter:false,waiting:[],run:{ limits:{ concurrency:2 } } };
  await hub.acquire(active); await hub.acquire(active);
  let writerStarted = false, readerStarted = false;
  const writer = hub.acquire(active,true).then(() => { writerStarted = true; });
  const reader = hub.acquire(active).then(() => { readerStarted = true; });
  assert.equal(active.runningWorkers,2);
  hub.release(active); await Promise.resolve(); assert.equal(writerStarted,false);
  hub.release(active); await writer; assert.equal(active.runningWorkers,1); assert.equal(active.busyWriter,true); assert.equal(readerStarted,false);
  hub.release(active,true); await reader; assert.equal(active.runningWorkers,1); assert.equal(active.busyWriter,false);
  hub.release(active); assert.equal(active.runningWorkers,0);
});

test('approval requests stay pending until an explicit user decision', async t => {
  const { hub,client } = fixture(t,'hold');
  const run = await hub.start({ projectId:'default',message:'확인 요청' });
  await settle(() => hub.contexts.size === 1);
  const threadId = [...hub.contexts.keys()][0];
  const pending = hub.serverRequest({ id:987,method:'item/commandExecution/requestApproval',params:{ threadId,command:'example-command' } });
  assert.equal(hub.approvals.size,1); assert.equal(client.responses.length,0);
  const id = [...hub.approvals.keys()][0]; hub.answerApproval(id,{ allow:false }); await pending;
  assert.deepEqual(client.responses.at(-1),{ id:987,result:{ decision:'decline' } });
  await hub.cancel(run.id); await settle(() => !hub.active);
});
