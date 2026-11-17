import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FakeRuntime } from '#runtime-fake';
import type { FakeScript } from '#runtime-fake';
import { runRequest } from '#orchestrator';
import type { RunEvent } from '#orchestrator';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orch-'));
const script = (...turns: FakeScript['turns']): FakeScript => ({ turns });
const usage = (total: number) => ({ usage: { inputTokens: total - 10, outputTokens: 10 } });

const answerReport = { workflow: 'answer', requirements: [], reason: 'plain question', answer: 'It listens on 3000.', sources: ['https://nodejs.org/api/http.html'] };
const buildClassify = { workflow: 'build', requirements: [{ id: 'R1', text: 'add GET /api/ping returning {ok:true}', quote: 'ping endpoint' }, { id: 'R2', text: 'cover it with a test', quote: 'with a test' }], reason: 'one change' };
const doneReport = { summary: 'added ping', changedFiles: ['ping.js', 'ping.test.js'], commandsRun: [], requirements: [{ id: 'R1', status: 'done', evidence: 'ping.js' }, { id: 'R2', status: 'done', evidence: 'ping.test.js' }], unverified: [] };
const write = (file: string) => ({ writeFile: { path: file, content: 'x' } });
const files = [write('ping.js'), write('ping.test.js')];

test('answer fast path: one lead session, no builder, files untouched', async () => {
  const cwd = tmp();
  const runtime = new FakeRuntime({ scripts: { lead: [script([usage(100), { report: answerReport }])], builder: [] } });
  const result = await runRequest('Which port does the server use?', { cwd, runtime });
  assert.equal(result.status, 'completed');
  assert.equal(result.workflow, 'answer');
  assert.equal(result.answer?.answer, 'It listens on 3000.');
  assert.equal(runtime.turns.length, 1);
  assert.equal(runtime.turns[0]?.options.access, 'read-only');
  assert.equal(runtime.turns[0]?.options.effort, 'low');
  assert.equal(result.usage.totalTokens, 100);
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('language ko: agents are told to write in Korean and the harness result message is Korean; default stays English', async () => {
  const ko = new FakeRuntime({ scripts: { lead: [script([usage(100), { report: answerReport }])], builder: [] } });
  const korean = await runRequest('Which port does the server use?', { cwd: tmp(), runtime: ko, language: 'ko' });
  assert.match(korean.reason, /프로젝트 파일을 바탕으로/);
  assert.match(ko.turns[0]!.options.instructions ?? '', /in Korean/);
  const en = new FakeRuntime({ scripts: { lead: [script([usage(100), { report: answerReport }])], builder: [] } });
  const english = await runRequest('Which port does the server use?', { cwd: tmp(), runtime: en });
  assert.match(english.reason, /Answered from the project files/);
  assert.doesNotMatch(en.turns[0]!.options.instructions ?? '', /in Korean/);
});

test('build workflow follows classify -> build -> report and records usage per step', async () => {
  const cwd = tmp();
  const runtime = new FakeRuntime({ scripts: { lead: [script([usage(50), { report: buildClassify }])], builder: [script([write('ping.js'), write('ping.test.js'), usage(400), { report: doneReport }])] } });
  const events: RunEvent[] = [];
  const result = await runRequest('Add a ping endpoint with a test', { cwd, runtime, review: 'never', onEvent: event => events.push(event) });
  assert.equal(result.status, 'completed');
  assert.equal(result.builder?.changedFiles.length, 2);
  assert.deepEqual(result.requirements.map(requirement => requirement.id), ['R1', 'R2']);
  assert.ok(fs.existsSync(path.join(cwd, 'ping.js')));
  const steps = events.filter(event => event.type === 'step_started').map(event => (event as Extract<RunEvent, { type: 'step_started' }>).step);
  assert.deepEqual(steps, ['classify', 'build', 'report']);
  assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index + 1));
  assert.equal(events.at(-1)?.type, 'run_finished');
  assert.deepEqual([...new Set(result.usageEntries.map(entry => entry.stepId))], ['classify', 'build']);
  assert.equal(result.usage.totalTokens, 450);
  assert.equal(runtime.turns[1]?.options.access, 'workspace-write');
  assert.match(runtime.turns[1]?.input.text ?? '', /R1: add GET \/api\/ping/);
  assert.equal(runtime.remaining('lead') + runtime.remaining('builder'), 0);
});

test('a rejected report is corrected inside the same turn', async () => {
  const cwd = tmp();
  const missingR2 = { ...doneReport, requirements: [doneReport.requirements[0]] };
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ report: { workflow: 'answer', requirements: [], reason: 'q' } }, { report: answerReport }])], builder: [] } });
  const result = await runRequest('q', { cwd, runtime });
  assert.equal(result.status, 'completed');
  assert.deepEqual(runtime.turns[0]?.toolResults.map(item => item.ok), [false, true]);
  assert.match(runtime.turns[0]?.toolResults[0]?.message ?? '', /report\.answer/);

  const second = new FakeRuntime({ scripts: { lead: [script([{ report: buildClassify }])], builder: [script([...files, { report: missingR2 }, { report: doneReport }])] } });
  const built = await runRequest('Add a ping endpoint with a test', { cwd: tmp(), runtime: second, review: 'never' });
  assert.equal(built.status, 'completed');
  assert.match(second.turns[1]?.toolResults[0]?.message ?? '', /missing an entry for R2/);
});

test('builder reporting open requirements ends as needs_review', async () => {
  const partial = { ...doneReport, requirements: [doneReport.requirements[0], { id: 'R2', status: 'unverified', evidence: '' }], unverified: ['test not run'] };
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ report: buildClassify }])], builder: [script([...files, { report: partial }])] } });
  const result = await runRequest('Add a ping endpoint with a test', { cwd: tmp(), runtime, review: 'never' });
  assert.equal(result.status, 'needs_review');
  assert.match(result.reason, /could not verify R2/);
});

test('a turn without a report gets one reminder, then fails', async () => {
  const reminded = new FakeRuntime({ scripts: { lead: [script([{ message: 'thinking' }], [{ report: answerReport }])], builder: [] } });
  const ok = await runRequest('q', { cwd: tmp(), runtime: reminded });
  assert.equal(ok.status, 'completed');
  assert.match(reminded.turns[1]?.input.text ?? '', /without an accepted report/);

  const silent = new FakeRuntime({ scripts: { lead: [script([{ message: 'a' }], [{ message: 'b' }])], builder: [] } });
  const failed = await runRequest('q', { cwd: tmp(), runtime: silent });
  assert.equal(failed.status, 'failed');
  assert.match(failed.reason, /twice without an accepted report/);
});

test('runtime failure and a missing runtime script end as failed', async () => {
  const crash = new FakeRuntime({ scripts: { lead: [script([{ fail: 'spawn EPERM' }])], builder: [] } });
  const crashed = await runRequest('q', { cwd: tmp(), runtime: crash });
  assert.equal(crashed.status, 'failed');
  assert.match(crashed.reason, /spawn EPERM/);
  assert.equal(crashed.failureType, 'environment');

  const none = await runRequest('q', { cwd: tmp(), runtime: new FakeRuntime({ scripts: {} }) });
  assert.equal(none.status, 'failed');
  assert.match(none.reason, /no script left/);
});

test('abort ends the run as interrupted', async () => {
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ hang: true }])], builder: [] } });
  const controller = new AbortController();
  setTimeout(() => { controller.abort(); }, 50);
  const result = await runRequest('q', { cwd: tmp(), runtime, signal: controller.signal });
  assert.equal(result.status, 'interrupted');
});

test('questions go to askUser; without it the run waits for the user', async () => {
  const asked = new FakeRuntime({ scripts: { lead: [script([{ ask: { question: 'Which database?' } }, { report: answerReport }])], builder: [] } });
  const seen: string[] = [];
  const ok = await runRequest('q', { cwd: tmp(), runtime: asked, askUser: async question => { seen.push(question.question); return 'sqlite'; } });
  assert.equal(ok.status, 'completed');
  assert.deepEqual(seen, ['Which database?']);
  assert.deepEqual(asked.turns[0]?.answers, ['sqlite']);

  const unattended = new FakeRuntime({ scripts: { lead: [script([{ ask: { question: 'Which database?' } }])], builder: [] } });
  const waiting = await runRequest('q', { cwd: tmp(), runtime: unattended });
  assert.equal(waiting.status, 'needs_user');
  assert.match(waiting.reason, /Which database\?/);
});

test('roles can use different runtimes', async () => {
  const lead = new FakeRuntime({ scripts: { lead: [script([{ report: buildClassify }])] } });
  const builder = new FakeRuntime({ scripts: { builder: [script([...files, { report: doneReport }])] } });
  const result = await runRequest('Add a ping endpoint with a test', { cwd: tmp(), runtime: { lead, builder }, review: 'never' });
  assert.equal(result.status, 'completed');
  assert.equal(lead.turns.length, 1);
  assert.equal(builder.turns.length, 1);
  const missing = await runRequest('Add a ping endpoint with a test', { cwd: tmp(), runtime: { lead: new FakeRuntime({ scripts: { lead: [script([{ report: buildClassify }])] } }) } });
  assert.equal(missing.status, 'failed');
  assert.match(missing.reason, /no runtime configured for role "builder"/);
});

import { commandClaimErrors, fileOfSource, missingSourceErrors, requirementQuoteErrors, skillsTouched } from '../src/evidence.ts';

test('evidence checks: claimed commands, cited files, requirement quotes, skills opened', () => {
  const ran = [{ command: "/bin/bash -lc 'npm test'", exitCode: 1 }, { command: 'node --test', exitCode: 0 }];
  assert.deepEqual(commandClaimErrors([{ command: 'node --test', exitCode: 0 }], ran), []);
  assert.match(commandClaimErrors([{ command: 'npm test', exitCode: 0 }], ran)[0] ?? '', /exited with 1, not 0/);
  assert.match(commandClaimErrors([{ command: 'npm run lint', exitCode: 0 }], ran)[0] ?? '', /did not run/);
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, 'src')); fs.writeFileSync(path.join(cwd, 'src', 'config.mjs'), '');
  assert.equal(fileOfSource('src/config.mjs:3'), 'src/config.mjs');
  assert.equal(fileOfSource('https://nodejs.org/api'), null);
  assert.equal(fileOfSource('the README explains it'), null);
  assert.deepEqual(missingSourceErrors(cwd, ['src/config.mjs:3', './src/config.mjs#L2', 'https://x.test/a'], 's'), []);
  assert.equal(missingSourceErrors(cwd, ['src/server.mjs', '../outside.txt'], 's').length, 2);
  assert.deepEqual(requirementQuoteErrors('할 일에 마감일 필드를 추가하고, 지난 건 빨간색으로 보여줘', [{ id: 'R1', text: 'due', quote: '마감일 필드를 추가하고' }, { id: 'R2', text: 'red', quote: '지난 건 빨간색으로' }]), []);
  assert.equal(requirementQuoteErrors('Add a due date', [{ id: 'R1', text: 'add tests', quote: 'with tests' }, { id: 'R2', text: 'x' }]).length, 2);
  const skills = [{ id: 'html-output', path: '.agent-desk/skills/html-output/SKILL.md' }, { id: 'api', path: '.agent-desk/skills/api/SKILL.md' }];
  assert.deepEqual(skillsTouched({ type: 'command', command: "sed -n 1,80p .agent-desk/skills/html-output/SKILL.md" }, skills), ['html-output']);
  assert.deepEqual(skillsTouched({ type: 'file_read', path: 'C:\\p\\.agent-desk\\skills\\api\\SKILL.md' }, skills), ['api']);
  assert.deepEqual(skillsTouched({ type: 'command', command: 'npm test' }, skills), []);
});

test('the run rejects a builder report that claims a command it never ran, records skills it opened', async () => {
  const runtime = new FakeRuntime({ scripts: {
    lead: [script([{ report: buildClassify }])],
    builder: [script([...files, { command: 'cat .agent-desk/skills/api/SKILL.md' }, { report: { ...doneReport, commandsRun: [{ command: 'npm test', exitCode: 0 }] } }, { report: doneReport }])],
  } });
  const skills = { builder: [{ id: 'api', description: 'API rules when adding endpoints. Not for UI.', path: '.agent-desk/skills/api/SKILL.md' }] };
  const result = await runRequest('Add a ping endpoint with a test', { cwd: tmp(), runtime, review: 'never', skills });
  assert.equal(result.status, 'completed', result.reason);
  assert.deepEqual(result.skillsRead, [{ step: 'build', role: 'builder', skill: 'api' }]);
  const rejected = runtime.turns.flatMap(turn => turn.toolResults).find(entry => !entry.ok);
  assert.match(rejected?.message ?? '', /"npm test" did not run in this step/);
});

test('the lead cannot add requirements the request does not contain, nor cite missing files', async () => {
  const invented = new FakeRuntime({ scripts: { lead: [script([{ report: { workflow: 'build', requirements: [{ id: 'R1', text: 'add tests', quote: 'with full test coverage' }], reason: 'r' } }, { report: { workflow: 'build', requirements: [{ id: 'R1', text: 'add ping', quote: 'ping endpoint' }], reason: 'r' } }])], builder: [script([write('ping.js'), { report: { ...doneReport, changedFiles: ['ping.js'], requirements: [{ id: 'R1', status: 'done', evidence: 'ping.js' }] } }])] } });
  const result = await runRequest('Add a ping endpoint', { cwd: tmp(), runtime: invented, review: 'never' });
  assert.equal(result.status, 'completed', result.reason);
  assert.match(invented.turns.flatMap(turn => turn.toolResults).find(entry => !entry.ok)?.message ?? '', /not in the user's request/);
  const cites = new FakeRuntime({ scripts: { lead: [script([{ report: { ...answerReport, sources: ['src/server.js'] } }, { report: answerReport }])] } });
  const answered = await runRequest('Which port?', { cwd: tmp(), runtime: cites });
  assert.equal(answered.status, 'completed');
  assert.match(cites.turns.flatMap(turn => turn.toolResults).find(entry => !entry.ok)?.message ?? '', /not a file in the project/);
});
