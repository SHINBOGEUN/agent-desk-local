import assert from 'node:assert/strict';

const base = process.env.AGENT_DESK_TEST_URL || 'http://127.0.0.1:4318';
const response = await fetch(`${base}/api/state`);
assert.equal(response.status,200);
let state = await response.json();
assert.equal(state.connection.status,'connected');
assert.ok(state.models.length > 0);
const post = async (route,body,headers = {}) => fetch(`${base}/api/${route}`,{ method:'POST', headers:{ 'Content-Type':'application/json','X-Agent-Desk-Token':state.csrf,...headers }, body:JSON.stringify(body) });
assert.equal((await post('settings',state.settings,{ 'X-Agent-Desk-Token':'invalid' })).status,403);
assert.equal((await post('settings',state.settings,{ Origin:'https://example.com' })).status,403);
assert.equal((await fetch(`${base}/data/state.json`)).status,404);
console.log('HTTP, authentication state, CSRF, origin and static boundaries: passed');

if (process.argv.includes('--live')) {
  const streamAbort = new AbortController();
  const events = await fetch(`${base}/api/events`,{ signal:streamAbort.signal });
  const observed = new Set();
  const monitor = (async () => {
    const reader = events.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    try {
      while (true) {
        const { done,value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value,{ stream:true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0,boundary); buffer = buffer.slice(boundary + 2);
          const line = frame.split('\n').find(item => item.startsWith('data: ')); if (!line) continue;
          const update = JSON.parse(line.slice(6));
          for (const runtime of update.runtime) if (runtime.status !== 'idle') observed.add(`${runtime.id}:${runtime.status}`);
        }
      }
    } catch(error) { if (error.name !== 'AbortError') throw error; }
  })();
  const started = await post('runs',{ projectId:'default',message:'대시보드 연결 검증 작업입니다. agent_desk_run 도구를 사용해 먼저 researcher에게 제공된 숫자 2, 3, 5의 합계를 계산하고 한 문장으로 보고하게 하세요. 그 보고를 받은 뒤 verifier에게 원래 숫자와 계산 결과를 전달해 독립적으로 검산시키세요. 두 팀원의 실제 보고를 받은 후 최종 답변을 두 문장으로 작성하세요. 이 작업은 제공된 숫자만 사용하며 파일, 셸, 웹, 외부 앱 도구는 사용하지 마세요.' });
  assert.equal(started.status,202);
  const { id } = await started.json(); console.log(`Live run started: ${id}`);
  let run;
  const deadline = Date.now() + 180000;
  let lastStage = '';
  while (Date.now() < deadline) {
    state = await (await fetch(`${base}/api/state`)).json();
    run = state.runs.find(item => item.id === id);
    const stage = run.tasks.map(task => `${task.agentId}:${task.status}`).join(', ');
    if (stage !== lastStage) { console.log(stage); lastStage = stage; }
    if (['completed','failed','interrupted'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve,1500));
  }
  streamAbort.abort(); await monitor;
  console.log(JSON.stringify({ status:run.status,answer:run.answer,error:run.error,tasks:run.tasks.map(task => ({ agent:task.agentId,status:task.status,output:task.output,error:task.error })),usage:run.usage,observed:[...observed] },null,2));
  assert.equal(run.status,'completed');
  assert.ok(run.tasks.some(task => task.agentId === 'researcher' && task.status === 'completed'));
  assert.ok(run.tasks.some(task => task.agentId === 'verifier' && task.status === 'completed'));
  assert.ok(observed.has('researcher:working'));
  assert.ok(observed.has('verifier:working'));
  assert.ok(run.usage.totalTokens > 0);
  console.log('Live main → researcher → verifier → main and SSE state transitions: passed');
}
