import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const base = 'http://127.0.0.1:4318';
const directory = path.resolve('.runtime','fixture-project');
fs.mkdirSync(directory,{ recursive:true });
fs.writeFileSync(path.join(directory,'README.md'),'# Agent Desk test fixture\nOnly result.json may be created. Validate its numeric sum equals 10.\n');
let state = await (await fetch(`${base}/api/state`)).json();
const post = async (route,body) => {
  const response = await fetch(`${base}/api/${route}`,{ method:'POST',headers:{ 'Content-Type':'application/json','X-Agent-Desk-Token':state.csrf },body:JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
};
await post('settings',{ ...state.settings,tokenBudget:200000 });
const project = await post('projects',{ name:'파일 생성·검증 QA',path:directory,allowWrites:true });
const started = await post('runs',{ projectId:project.id,message:'로컬 실행 검증입니다. worker에게 현재 프로젝트 폴더에 result.json 파일 하나를 만들도록 맡기세요. 내용은 {"numbers":[2,3,5],"sum":10} 입니다. worker가 실제 파일을 만든 뒤 verifier에게 셸 명령으로 그 파일을 읽고 numbers의 합이 sum과 같은지 검사하도록 맡기세요. verifier는 성공 시 CHECK_OK를 출력하는 명령을 실행해야 합니다. 같은 배치가 아닌 순차 위임으로 진행하고, 실제 파일 경로와 실행한 검증 결과를 최종 보고하세요. README.md와 result.json 이외의 파일은 읽거나 수정하지 말고 외부 도구와 네트워크는 사용하지 마세요.' });
console.log(`Workspace integration run started: ${started.id}`);
let run; let stage = '';
const deadline = Date.now() + 240000;
while (Date.now() < deadline) {
  state = await (await fetch(`${base}/api/state`)).json(); run = state.runs.find(item => item.id === started.id);
  const next = run.tasks.map(task => `${task.agentId}:${task.status}`).join(', ');
  if (next !== stage) { console.log(next); stage = next; }
  if (state.approvals.length) { console.log('Approval requested; awaiting dashboard user decision.'); break; }
  if (['completed','failed','interrupted'].includes(run.status)) break;
  await new Promise(resolve => setTimeout(resolve,1500));
}
console.log(JSON.stringify({ status:run.status,error:run.error,answer:run.answer,tasks:run.tasks.map(task => ({ agent:task.agentId,status:task.status,output:task.output,error:task.error })),commands:run.events.filter(event => event.kind === 'command'),usage:run.usage },null,2));
assert.equal(run.status,'completed');
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory,'result.json'),'utf8')),{ numbers:[2,3,5],sum:10 });
assert.ok(run.tasks.some(task => task.agentId === 'worker' && task.status === 'completed'));
assert.ok(run.tasks.some(task => task.agentId === 'verifier' && task.status === 'completed'));
assert.ok(run.events.some(event => event.kind === 'command' && event.message.includes('CHECK_OK')));
console.log('Actual file creation and independent shell validation: passed');
