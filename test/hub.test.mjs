import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Store, validateAgent, validateSettings, defaultAgents } from '../lib/store.mjs';
import { AgentHub } from '../lib/hub.mjs';

class FakeClient extends EventEmitter {
  constructor(mode = 'complete') { super(); this.mode = mode; this.calls = []; this.responses = []; this.threadNumber = 0; this.connected = true; }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/rateLimits/read') return this.rateLimits || { rateLimits: { primary: { usedPercent: this.quotaUsedPercent ?? 10, windowDurationMins:300, resetsAt:1800000000 } } };
    if (method === 'thread/start') return { thread: { id: `thread-${++this.threadNumber}` } };
    if (method === 'turn/start') {
      const id = `turn-${params.threadId}`;
      this.emit('notification', { method:'turn/started', params:{ threadId:params.threadId, turn:{ id } } });
      if (this.mode === 'complete' || this.mode === 'hold-main' && params.threadId !== 'thread-1' || this.autoComplete?.(params.threadId)) setTimeout(() => {
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
  assert.throws(() => validateSettings({ concurrency:100,maxDelegations:6,timeoutMinutes:15,usagePercentLimit:5 }));
  assert.throws(() => validateSettings({ concurrency:2,maxDelegations:6,timeoutMinutes:15,usagePercentLimit:0 }));
});

test('skills persist as standard Codex SKILL.md manifests and are invoked as assigned skill inputs', async t => {
  const { hub,client,store } = fixture(t);
  const agent = store.state.agents.find(item => item.id === 'worker');
  store.state.skills = [];
  const instructions = '먼저 영향을 받는 API 계약을 확인하고 관련 검사 결과를 기록하세요.';
  const skill = hub.saveSkill({ name:'API 계약 확인', description:'API 변경과 관련된 계약을 확인할 때 사용합니다.', instructions, agentIds:[agent.id], enabled:true });
  const manifestPath = path.join(store.directory,'skills',skill.id,'SKILL.md');
  const manifest = readFileSync(manifestPath,'utf8');
  assert.match(manifest,new RegExp(`^---\\nname: "agent-desk-${skill.id}"\\ndescription:`));
  assert.match(manifest,new RegExp(instructions));
  const active = { cancelled:false, project:{ path:process.cwd(),allowWrites:false,autoApproveCommands:false }, run:{ events:[],tasks:[],usage:{ totalTokens:0,inputTokens:0,outputTokens:0,cachedInputTokens:0 } } };
  await hub.turn(active,agent,{ title:'API 조사' },'담당자 지침','API 계약을 확인하세요.',false,[],[skill]);
  const turn = client.calls.find(call => call.method === 'turn/start').params;
  assert.match(turn.input[0].text,new RegExp(`\\$agent-desk-${skill.id}`));
  assert.deepEqual(turn.input.at(-1),{ type:'skill',name:`agent-desk-${skill.id}`,path:manifestPath });
  const thread = client.calls.find(call => call.method === 'thread/start').params;
  assert.doesNotMatch(thread.developerInstructions,new RegExp(instructions));
  hub.deleteSkill(skill.id);
  assert.equal(existsSync(path.dirname(manifestPath)),false);
});

test('main selects only task-relevant skills that are assigned to its chosen agent', async t => {
  const { hub,client,store } = fixture(t,'hold-main');
  store.state.skills = [];
  const worker = store.state.agents.find(item => item.id === 'worker');
  const skill = hub.saveSkill({ name:'API 계약 확인',description:'API 변경 계약을 확인할 때 사용합니다.',instructions:'요청·응답 형식과 오류 동작을 확인하세요.',agentIds:[worker.id],enabled:true });
  const run = await hub.start({ projectId:'default',message:'작업을 나누어 처리해 주세요.' });
  await settle(() => hub.contexts.size === 1);
  const main = client.calls.find(call => call.method === 'thread/start').params;
  assert.match(main.dynamicTools[0].description,new RegExp(skill.id));
  await hub.serverRequest({ id:811,method:'item/tool/call',params:{ threadId:[...hub.contexts.keys()][0],tool:'agent_desk_run',arguments:{ tasks:[{ agentId:worker.id,title:'API 확인',task:'계약을 확인하세요.',readOnly:true,skillIds:[skill.id] }] } } });
  const workerTurn = client.calls.filter(call => call.method === 'turn/start').at(-1).params;
  assert.equal(workerTurn.input.at(-1).name,`agent-desk-${skill.id}`);
  await hub.cancel(run.id); await settle(() => !hub.active);
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

test('main AI receives measured budget facts without a completion guarantee', async t => {
  const { hub,client,store } = fixture(t,'hold');
  store.state.runs.unshift({ id:'earlier',projectId:'default',status:'interrupted',usage:{ totalTokens:312215 },limits:{ tokenBudget:250000 },tasks:[{},{}] });
  const run = await hub.start({ projectId:'default',message:'토큰 예산을 확인하고 조사 계획을 세워줘' });
  await settle(() => hub.contexts.size === 1);
  const threadId = [...hub.contexts.keys()][0];
  const main = client.calls.find(call => call.method === 'thread/start').params;
  assert.match(main.developerInstructions,/완료를 보장하지 마세요/);
  assert.match(main.developerInstructions,/5%p/);
  assert.match(main.developerInstructions,/312215/);
  assert.ok(main.dynamicTools.some(tool => tool.name === 'agent_desk_budget'));
  await hub.serverRequest({ id:810,method:'item/tool/call',params:{ threadId,tool:'agent_desk_budget',arguments:{} } });
  const facts = JSON.parse(client.responses.at(-1).result.contentItems[0].text);
  assert.equal(facts.usagePercentLimit,5);
  assert.equal(facts.baselineUsedPercent,10);
  assert.equal(facts.consumedPercent,0);
  assert.equal(facts.observedTokens,0);
  assert.equal(facts.previousRuns[0].totalTokens,312215);
  assert.equal(facts.previousRuns[0].budgetTokens,250000);
  assert.match(facts.note,/환산할 수 없습니다/);
  await hub.cancel(run.id); await settle(() => !hub.active);
});

test('main AI receives the latest needs-review request, checker reason, and team report on a short follow-up', async t => {
  const { hub,client,store } = fixture(t,'hold-main');
  store.state.runs.unshift({
    id:'reviewed-run',projectId:'default',message:'프로젝트의 로그인 흐름을 수정하고 테스트해줘',answer:'로그인 변경은 적용했지만 실제 브라우저 검증이 남았습니다.',status:'needs_review',
    endReason:{ kind:'error',message:'상위 요청이 종료되었습니다.' },
    qualityGate:{ required:true,status:'needs_review',reason:'마지막 파일 변경 이후 체커의 검증 보고가 없습니다.' },
    tasks:[{ id:'login-writer',agentId:'frontend',agentName:'프론트엔드 에이전트',title:'로그인 흐름 수정',status:'completed',writable:true,output:'로그인 리다이렉트 처리를 수정했습니다. 관련 파일과 단위 테스트 결과를 기록했습니다.' }],
  });
  const run = await hub.start({ projectId:'default',message:'다시 해줘' });
  await settle(() => hub.contexts.size === 1);
  const main = client.calls.find(call => call.method === 'thread/start').params;
  assert.match(main.developerInstructions,/완료되지 않은 요청/);
  assert.match(main.developerInstructions,/reviewed-run · 검토 필요/);
  assert.match(main.developerInstructions,/로그인 흐름을 수정하고 테스트해줘/);
  assert.match(main.developerInstructions,/마지막 파일 변경 이후 체커의 검증 보고가 없습니다/);
  assert.match(main.developerInstructions,/로그인 리다이렉트 처리를 수정했습니다/);
  assert.doesNotMatch(main.developerInstructions,/상위 요청이 종료되었습니다/);
  await hub.cancel(run.id); await settle(() => !hub.active);
});

test('simple budget adequacy questions get a factual answer without spending tokens', async t => {
  const { hub,client,store } = fixture(t);
  store.state.runs.unshift({ id:'earlier',projectId:'default',status:'interrupted',usage:{ totalTokens:312215 },limits:{ tokenBudget:250000 },tasks:[] });
  const run = await hub.start({ projectId:'default',message:'250000 토큰이 적은거야?' });
  assert.equal(run.status,'completed');
  assert.equal(run.usage.totalTokens,0);
  assert.match(run.answer,/5%p/);
  assert.match(run.answer,/312,215토큰/);
  assert.match(run.answer,/충분하다고 보장할 수 없습니다/);
  assert.equal(client.calls.filter(call => call.method === 'thread/start').length,0);
  const again = await hub.start({ projectId:'default',message:'토큰 예산이 충분해?' });
  assert.match(again.answer,/312,215토큰/);
});

test('five-hour percentage warnings and cap use account usage delta, not token count', async t => {
  const { hub,client,store } = fixture(t,'hold');
  store.state.settings.usagePercentLimit = 5;
  const run = await hub.start({ projectId:'default',message:'사용량 확인' });
  await settle(() => hub.contexts.size === 1);
  const report = async usedPercent => { client.quotaUsedPercent = usedPercent; await hub.refreshUsageLimits(true,true); };
  await report(13.5); await report(14); await report(14.5);
  assert.equal(run.events.filter(event => event.message.includes('70% 도달')).length,1);
  assert.equal(run.events.filter(event => event.message.includes('90% 도달')).length,1);
  await report(15.2);
  await settle(() => !hub.active);
  assert.equal(run.status,'interrupted');
  assert.equal(run.accountUsage.consumedPercent,5.2);
  assert.equal(run.usage.totalTokens,0);
  assert.match(run.error,/5.2%p \/ 설정 5%p/);
  assert.equal(run.endReason.kind,'usage_limit');
});

test('resuming links a new run, carries prior reports, and keeps the same five-hour budget', async t => {
  const { hub,client,store } = fixture(t,'hold');
  const old = { id:'previous',resumeFromRunId:'older',projectId:'default',message:'화면을 고치고 검증해 줘',status:'interrupted',error:'사용자가 요청을 중단했습니다.',endReason:{kind:'manual',message:'사용자가 요청을 중단했습니다.'},resumeAttempt:1,accountUsage:{baselineUsedPercent:10,currentUsedPercent:12,consumedPercent:2,windowResetsAt:1800000000},qualityGate:{status:'pending'},tasks:[{agentId:'builder',agentName:'구현 담당',title:'화면 수정',status:'completed',writable:true,output:'버튼을 수정했습니다.',usage:{totalTokens:80}}],usage:{totalTokens:80},answer:'' };
  store.state.runs.unshift(old);
  store.state.runs.push({id:'older',projectId:'default',status:'interrupted',tasks:[{agentName:'조사 담당',title:'구조 조사',status:'completed',output:'진입 파일은 app.js입니다.'}],usage:{totalTokens:40}});
  client.quotaUsedPercent = 12.5;
  const resumed = await hub.resume(old.id);
  await settle(() => hub.contexts.size === 1);
  assert.equal(resumed.resumeFromRunId,old.id);
  assert.equal(resumed.resumeAttempt,2);
  assert.equal(resumed.promptRefinement.enabled,false);
  assert.equal(resumed.accountUsage.baselineUsedPercent,10);
  assert.equal(resumed.accountUsage.consumedPercent,2.5);
  assert.equal(old.status,'interrupted');
  const turn = client.calls.find(call => call.method === 'turn/start');
  assert.match(turn.params.input[0].text,/버튼을 수정했습니다/);
  assert.match(turn.params.input[0].text,/진입 파일은 app.js/);
  assert.match(turn.params.input[0].text,/현재 파일 상태를 다시 확인/);
  const thread = client.calls.find(call => call.method === 'thread/start');
  assert.match(thread.params.developerInstructions,/무작정 반복하지 마세요/);
  await hub.cancel(resumed.id);
  await settle(() => !hub.active);
  assert.equal(resumed.endReason.kind,'manual');
});

test('resume cannot reset a reached limit in the same window and can start after reset', async t => {
  const { hub,client,store } = fixture(t,'hold');
  store.state.runs.unshift({ id:'previous',projectId:'default',message:'계속 작업',status:'interrupted',accountUsage:{baselineUsedPercent:10,currentUsedPercent:15.2,consumedPercent:5.2,windowResetsAt:1800000000},tasks:[],usage:{totalTokens:0} });
  client.quotaUsedPercent = 15.2;
  await assert.rejects(() => hub.resume('previous'),/이전 실행을 포함해/);
  assert.equal(store.state.runs.length,1);
  client.rateLimits = { rateLimits:{ primary:{ usedPercent:15.2,windowDurationMins:300,resetsAt:1800000001 } } };
  await assert.rejects(() => hub.resume('previous'),/이전 실행을 포함해/);
  assert.equal(store.state.runs.length,1);
  client.rateLimits = { rateLimits:{ primary:{ usedPercent:1,windowDurationMins:300,resetsAt:1800018000 } } };
  const resumed = await hub.resume('previous');
  await settle(() => hub.contexts.size === 1);
  assert.equal(resumed.accountUsage.baselineUsedPercent,1);
  assert.equal(resumed.accountUsage.consumedPercent,0);
  await hub.cancel(resumed.id); await settle(() => !hub.active);
});

test('a usage-limit run can add 5 percentage points without resetting its consumed usage or default', async t => {
  const { hub,client,store } = fixture(t,'hold');
  store.state.settings.usagePercentLimit = 5;
  store.state.runs.unshift({ id:'limited',projectId:'default',message:'계속 작업',status:'interrupted',endReason:{kind:'usage_limit'},limits:{usagePercentLimit:5},accountUsage:{baselineUsedPercent:10,currentUsedPercent:15.2,consumedPercent:5.2,windowResetsAt:1800000000},tasks:[],usage:{totalTokens:0} });
  client.quotaUsedPercent = 15.2;
  await assert.rejects(() => hub.resume('limited'),/이전 실행을 포함해/);
  const resumed = await hub.resume('limited',5);
  await settle(() => hub.contexts.size === 1);
  assert.equal(resumed.limits.usagePercentLimit,10);
  assert.equal(resumed.accountUsage.baselineUsedPercent,10);
  assert.equal(resumed.accountUsage.consumedPercent,5.2);
  assert.equal(store.state.settings.usagePercentLimit,5);
  client.quotaUsedPercent = 20.1;
  await hub.refreshUsageLimits(true,true);
  await settle(() => !hub.active);
  assert.equal(resumed.endReason.kind,'usage_limit');
  assert.equal(resumed.accountUsage.consumedPercent,10.1);
  const secondResume = await hub.resume(resumed.id,5);
  await settle(() => hub.contexts.size === 1);
  assert.equal(secondResume.limits.usagePercentLimit,15);
  assert.equal(secondResume.accountUsage.baselineUsedPercent,10);
  await hub.cancel(secondResume.id); await settle(() => !hub.active);
});

test('a later account increase explains why five points are insufficient and accepts a larger explicit increment', async t => {
  const { hub,client,store } = fixture(t,'hold');
  store.state.settings.usagePercentLimit = 20;
  store.state.runs.unshift({ id:'limited',projectId:'default',message:'계속 작업',status:'interrupted',endReason:{kind:'usage_limit'},limits:{usagePercentLimit:20},accountUsage:{baselineUsedPercent:0,currentUsedPercent:20,consumedPercent:20,windowResetsAt:1800000000},tasks:[],usage:{totalTokens:0} });
  client.quotaUsedPercent = 33;
  await assert.rejects(() => hub.resume('limited',5),/33%p.*25%p.*\+20%p/);
  assert.equal(store.state.runs.length,1);
  const resumed = await hub.resume('limited',20);
  await settle(() => hub.contexts.size === 1);
  assert.equal(resumed.limits.usagePercentLimit,40);
  assert.equal(resumed.accountUsage.consumedPercent,33);
  assert.equal(store.state.settings.usagePercentLimit,20);
  await hub.cancel(resumed.id); await settle(() => !hub.active);
});

test('quota extension requires a limited run, same window, and five percent account headroom', async t => {
  const { hub,client,store } = fixture(t,'hold');
  store.state.runs.unshift({ id:'limited',projectId:'default',message:'계속 작업',status:'interrupted',endReason:{kind:'usage_limit'},limits:{usagePercentLimit:5},accountUsage:{baselineUsedPercent:90,currentUsedPercent:95.2,consumedPercent:5.2,windowResetsAt:1800000000},tasks:[],usage:{totalTokens:0} });
  client.quotaUsedPercent = 95.2;
  await assert.rejects(() => hub.resume('limited',5),/잔여량/);
  await assert.rejects(() => hub.resume('limited',7),/5%p 단위/);
  store.state.runs[0].endReason.kind = 'manual';
  await assert.rejects(() => hub.resume('limited',5),/사용률 제한으로 중단된/);
  store.state.runs[0].endReason.kind = 'usage_limit';
  client.rateLimits = { rateLimits:{ primary:{ usedPercent:1,windowDurationMins:300,resetsAt:1800018000 } } };
  await assert.rejects(() => hub.resume('limited',5),/새 5시간 창/);
  assert.equal(store.state.runs.length,1);
});

test('legacy resumed runs use their measurement time to keep a same-window cap', async t => {
  const { hub,client,store } = fixture(t);
  store.state.runs.unshift({ id:'legacy',projectId:'default',message:'계속 작업',status:'interrupted',accountUsage:{baselineUsedPercent:10,currentUsedPercent:15.2,consumedPercent:5.2,checkedAt:new Date((1800000000 - 3600) * 1000).toISOString()},tasks:[],usage:{totalTokens:0} });
  client.quotaUsedPercent = 15.2;
  await assert.rejects(() => hub.resume('legacy'),/이전 실행을 포함해/);
  assert.equal(store.state.runs.length,1);
});

test('missing five-hour usage stops, while a quota-window reset rebases and keeps the run active', async t => {
  const { hub,client,store } = fixture(t,'hold');
  client.rateLimits = {};
  await assert.rejects(() => hub.start({ projectId:'default',message:'실행' }),/한도 사용률을 확인할 수 없어/);
  assert.equal(store.state.runs.length,0);
  client.rateLimits = null;
  const run = await hub.start({ projectId:'default',message:'실행' });
  await settle(() => hub.contexts.size === 1);
  client.rateLimits = { rateLimits:{ primary:{ usedPercent:11,windowDurationMins:300,resetsAt:1800000001 } } };
  await hub.refreshUsageLimits(true,true);
  assert.equal(run.accountUsage.baselineUsedPercent,10);
  assert.equal(run.accountUsage.consumedPercent,1);
  assert.equal(run.events.some(event => event.message.includes('새 창 기준')),false);
  client.rateLimits = { rateLimits:{ primary:{ usedPercent:1,windowDurationMins:300,resetsAt:1800018000 } } };
  await hub.refreshUsageLimits(true,true);
  assert.equal(hub.active.run.id,run.id);
  assert.equal(run.status,'running');
  assert.equal(run.accountUsage.baselineUsedPercent,0);
  assert.equal(run.accountUsage.consumedPercent,1);
  client.rateLimits = { rateLimits:{ primary:{ usedPercent:3,windowDurationMins:300,resetsAt:1800018001 } } };
  await hub.refreshUsageLimits(true,true);
  assert.equal(run.accountUsage.consumedPercent,3);
  client.rateLimits = { rateLimits:{ primary:{ usedPercent:6,windowDurationMins:300,resetsAt:1800018002 } } };
  await hub.refreshUsageLimits(true,true);
  await settle(() => !hub.active);
  assert.equal(run.endReason.kind,'usage_limit');
  assert.equal(run.accountUsage.consumedPercent,6);
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

test('image-only request reaches the main turn and only explicitly selected teammate', async t => {
  const { hub,client } = fixture(t,'hold-main');
  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+b9d0AAAAASUVORK5CYII=';
  const run = await hub.start({ projectId:'default',message:'',images:[pixel],refinePrompt:true });
  await settle(() => hub.contexts.size === 1);
  assert.equal(run.images.length,1);
  assert.equal(run.promptRefinement.enabled,false);
  assert.equal(run.images[0].mimeType,'image/png');
  const mainTurn = client.calls.find(call => call.method === 'turn/start').params;
  assert.equal(mainTurn.input[1].type,'localImage');
  assert.ok(mainTurn.input[1].path.endsWith(`${run.images[0].id}.png`));
  const mainThread = [...hub.contexts.keys()][0];
  await hub.serverRequest({ id:811,method:'item/tool/call',params:{ threadId:mainThread,tool:'agent_desk_run',arguments:{ tasks:[{ agentId:'researcher',title:'이미지 확인',task:'첨부 이미지를 확인해 주세요.',includeImages:true }] } } });
  const teammateTurn = client.calls.filter(call => call.method === 'turn/start').at(-1).params;
  assert.equal(teammateTurn.input[1].path,mainTurn.input[1].path);
  await hub.cancel(run.id); await settle(() => !hub.active);
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

test('project command automation persists and keeps read-only agents behind automatic review', async t => {
  const { hub,client,store } = fixture(t);
  const project = hub.saveProject({ id:'default',name:'Test project',path:process.cwd(),allowWrites:true,autoApproveCommands:true });
  assert.equal(project.autoApproveCommands,true);
  const active = { run:{ tasks:[],events:[],usage:{ totalTokens:0 },limits:{ tokenBudget:100000 } },project,cancelled:false };
  const writer = defaultAgents.find(agent => agent.id === 'worker');
  await hub.turn(active,writer,hub.newTask(active.run,writer,'구현'),'test','test');
  const writableParams = client.calls.filter(item => item.method === 'thread/start').at(-1).params;
  assert.equal(writableParams.sandbox,'workspace-write');
  assert.equal(writableParams.approvalPolicy,'never');
  const verifier = defaultAgents.find(agent => agent.id === 'verifier');
  await hub.turn(active,verifier,hub.newTask(active.run,verifier,'검증'),'test','test');
  const verifierParams = client.calls.filter(item => item.method === 'thread/start').at(-1).params;
  assert.equal(verifierParams.sandbox,'read-only');
  assert.equal(verifierParams.approvalPolicy,'on-request');
  assert.equal(verifierParams.approvalsReviewer,'auto_review');
  assert.equal(store.state.projects[0].autoApproveCommands,true);
});

test('read-only operational delegation skips change verification for a writable agent', async t => {
  const { hub,client,store } = fixture(t,'hold-main');
  store.state.projects[0].allowWrites = true;
  const run = await hub.start({ projectId:'default',message:'개발 서버를 실행하고 주소를 확인해 줘' });
  await settle(() => hub.contexts.size === 1);
  const mainThread = [...hub.contexts.keys()][0];
  const mainThreadStart = client.calls.find(call => call.method === 'thread/start').params;
  assert.match(mainThreadStart.developerInstructions,/readOnly: true를 지정하고 체커를 별도로 호출하지 마세요/);
  assert.equal(mainThreadStart.dynamicTools[0].inputSchema.properties.tasks.items.properties.readOnly.type,'boolean');
  await hub.serverRequest({ id:801,method:'item/tool/call',params:{ threadId:mainThread,tool:'agent_desk_run',arguments:{ tasks:[{ agentId:'worker',title:'서버 실행 확인',task:'서버 상태만 확인',readOnly:true }] } } });
  const operational = run.tasks.find(task => task.agentId === 'worker');
  assert.equal(operational.status,'completed');
  assert.equal(operational.readOnly,true);
  assert.equal(operational.writable,false);
  assert.equal(client.calls.filter(call => call.method === 'thread/start').at(-1).params.sandbox,'read-only');
  assert.equal(run.qualityGate.required,false);
  assert.equal(run.tasks.some(task => task.agentId === 'verifier'),false);
  await hub.serverRequest({ id:802,method:'item/tool/call',params:{ threadId:mainThread,tool:'agent_desk_run',arguments:{ tasks:[{ agentId:'worker',title:'설정 변경',task:'설정을 수정' }] } } });
  assert.equal(run.qualityGate.required,true);
  assert.equal(client.calls.filter(call => call.method === 'thread/start').at(-1).params.sandbox,'workspace-write');
  await hub.cancel(run.id); await settle(() => !hub.active);
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

test('working teammates can ask and read a bounded, read-only consultation without adding a worker slot', async t => {
  const { hub,client,store } = fixture(t,'hold');
  const run = await hub.start({ projectId:'default',message:'프론트와 백엔드의 API 계약을 정해 주세요.' });
  await settle(() => hub.contexts.size === 1);
  const active = hub.active;
  const front = store.state.agents.find(agent => agent.id === 'researcher');
  const back = store.state.agents.find(agent => agent.id === 'worker');
  const frontTask = hub.newTask(run,front,'프론트 설계'); frontTask.brief = '목록 화면의 응답 구조를 정한다.';
  const backTask = hub.newTask(run,back,'백엔드 설계'); backTask.brief = 'GET /items 계약을 정한다.';
  const frontWork = hub.turn(active,front,frontTask,'프론트 역할','화면 설계').catch(() => {});
  const backWork = hub.turn(active,back,backTask,'백엔드 역할','API 설계').catch(() => {});
  await settle(() => hub.contexts.size === 3);
  active.runningWorkers = 2;
  client.autoComplete = threadId => threadId === 'thread-4';
  const frontThread = [...hub.contexts.values()].find(item => item.agent.id === front.id).threadId;
  const backThread = [...hub.contexts.values()].find(item => item.agent.id === back.id).threadId;
  const workerTools = client.calls.filter(call => call.method === 'thread/start')[1].params.dynamicTools.map(tool => tool.name);
  assert.deepEqual(workerTools,['agent_desk_ask','agent_desk_inbox']);
  await hub.serverRequest({ id:701,method:'item/tool/call',params:{ threadId:frontThread,tool:'agent_desk_ask',arguments:{ agentId:back.id,question:'GET /items 응답 필드는?',context:'목록 화면에 제목과 상태가 필요합니다.' } } });
  const answer = JSON.parse(client.responses.find(item => item.id === 701).result.contentItems[0].text);
  assert.equal(answer.fromName,back.name);
  assert.equal(run.discussions.length,1);
  assert.equal(run.discussions[0].status,'completed');
  assert.equal(run.discussions[0].question,'GET /items 응답 필드는?');
  assert.equal(active.runningWorkers,2);
  const consultant = client.calls.filter(call => call.method === 'thread/start')[3].params;
  assert.equal(consultant.sandbox,'read-only');
  assert.equal(consultant.config['features.shell_tool'],false);
  assert.equal(consultant.dynamicTools,undefined);
  assert.match(client.calls.filter(call => call.method === 'turn/start')[3].params.input[0].text,/GET \/items 계약을 정한다/);
  await hub.serverRequest({ id:702,method:'item/tool/call',params:{ threadId:backThread,tool:'agent_desk_inbox',arguments:{} } });
  const inbox = JSON.parse(client.responses.find(item => item.id === 702).result.contentItems[0].text);
  assert.equal(inbox.discussions[0].question,'GET /items 응답 필드는?');
  assert.equal(inbox.discussions[0].answer,answer.answer);
  await hub.serverRequest({ id:703,method:'item/tool/call',params:{ threadId:frontThread,tool:'agent_desk_ask',arguments:{ agentId:front.id,question:'나에게 질문' } } });
  assert.equal(client.responses.find(item => item.id === 703).result.success,false);
  assert.equal(run.discussions.length,1);
  await hub.cancel(run.id); await Promise.all([frontWork,backWork]); await settle(() => !hub.active);
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
  base.tasks[1].output = '[검증 결과: NOT_VERIFIED]\n실기기 동작 미확인';
  hub.evaluateQualityGate(base);
  assert.equal(base.qualityGate.status,'needs_review');
  assert.match(base.qualityGate.reason,/실제 동작을 확인하지 못해/);
  base.tasks[1].consultation = true;
  base.tasks[1].output = '[검증 결과: PASS]\n상담 답변';
  hub.evaluateQualityGate(base);
  assert.equal(base.qualityGate.status,'needs_review');
});

test('persisted in-flight runs are marked interrupted on restart', t => {
  const { store } = fixture(t);
  store.state.runs.push({ id:'old',status:'running',tasks:[{ status:'working' }] }); store.save();
  const reopened = new Store(store.directory,process.cwd());
  assert.equal(reopened.state.runs[0].status,'interrupted'); assert.equal(reopened.state.runs[0].tasks[0].status,'interrupted');
});

test('saved NOT_VERIFIED history keeps its review status and gains the correct reason', t => {
  const { store } = fixture(t);
  store.state.runs.unshift({ id:'review',status:'needs_review',qualityGate:{ required:true,status:'needs_review',verifierTaskId:'check',reason:'체커 보고에 표준 판정이 없어 검토가 필요합니다.' },tasks:[{ id:'check',agentId:'verifier',output:'[검증 결과: NOT_VERIFIED]\n실기기 미확인' }] });
  store.save();
  const reopened = new Store(store.directory,process.cwd());
  assert.equal(reopened.state.runs[0].status,'needs_review');
  assert.match(reopened.state.runs[0].qualityGate.reason,/실제 동작을 확인하지 못해/);
});

test('legacy token budget migrates to a percentage cap without changing old run history', t => {
  const { store } = fixture(t);
  store.state.version = 3;
  store.state.settings = { concurrency:2,maxDelegations:6,timeoutMinutes:15,tokenBudget:250000 };
  store.state.runs.push({ id:'old',status:'completed',limits:{ tokenBudget:250000 },tasks:[] });
  store.save();
  const reopened = new Store(store.directory,process.cwd());
  assert.equal(reopened.state.version,5);
  assert.equal(reopened.state.settings.usagePercentLimit,5);
  assert.equal('tokenBudget' in reopened.state.settings,false);
  assert.equal(reopened.state.runs[0].limits.tokenBudget,250000);
});

test('legacy team gains the monitor and prompt refiner once', t => {
  const { store } = fixture(t);
  store.state.version = 1;
  store.state.agents = store.state.agents.filter(agent => agent.id !== 'monitor');
  store.save();
  const migrated = new Store(store.directory,process.cwd());
  assert.equal(migrated.state.version,5);
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
