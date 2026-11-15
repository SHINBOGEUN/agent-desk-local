import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FakeRuntime } from '#runtime-fake';
import type { FakeScript } from '#runtime-fake';
import { runRequest } from '#orchestrator';
import type { RunConfig } from '#orchestrator';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
const script = (...turns: FakeScript['turns']): FakeScript => ({ turns });
const VERIFY = `node -e "process.exit(require('fs').existsSync('ok.txt')?0:1)"`;
const classifyPlanBuild = { workflow: 'plan-build', requirements: [{ id: 'R1', text: 'create ok.txt' }], reason: 'several files' };
const plan = { approach: 'write ok.txt directly', steps: ['create ok.txt'], files: ['ok.txt'], risks: ['none known'] };
const builderReport = { summary: 'done', changedFiles: ['ok.txt'], commandsRun: [], requirements: [{ id: 'R1', status: 'done', evidence: 'ok.txt' }], unverified: [] };
const research = (angle: string) => ({ angle, summary: `about ${angle}`, findings: [{ claim: `claim for ${angle}`, evidence: 'src/a.ts:1' }], sources: ['src/a.ts'] });
const classifyInvestigate = (texts: string[]) => ({ workflow: 'investigate', requirements: texts.map((text, index) => ({ id: `R${index + 1}`, text })), reason: 'needs reading' });
const go = (runtime: FakeRuntime, cwd: string, config: Partial<RunConfig> = {}) => runRequest('do the thing', { cwd, runtime, review: 'never', ...config });

test('plan-build: classify -> plan (read-only lead) -> build with the plan in the prompt', async () => {
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ report: classifyPlanBuild }]), script([{ report: plan }])], builder: [script([{ writeFile: { path: 'ok.txt', content: 'x' } }, { report: builderReport }])] } });
  const cwd = tmp();
  const result = await go(runtime, cwd, { verify: [VERIFY] });
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.workflow, 'plan-build');
  assert.deepEqual(result.plan, plan);
  const planTurn = runtime.turns.find(turn => turn.role === 'lead' && /Step: plan/.test(turn.input.text));
  assert.equal(planTurn?.options.access, 'read-only');
  assert.match(planTurn?.options.instructions ?? '', /Role: planner/);
  const buildTurn = runtime.turns.find(turn => turn.role === 'builder');
  assert.match(buildTurn?.input.text ?? '', /Plan from the planning step/);
  assert.match(buildTurn?.input.text ?? '', /write ok\.txt directly/);
});

test('plan-build: an invalid plan is corrected in the same turn; the user can stop after reading it', async () => {
  const bad = { ...plan, steps: [] };
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ report: classifyPlanBuild }]), script([{ report: bad }, { report: plan }])], builder: [script([{ writeFile: { path: 'ok.txt', content: 'x' } }, { report: builderReport }])] } });
  const seen: string[] = [];
  const result = await go(runtime, tmp(), { verify: [VERIFY], confirmPlan: async received => { seen.push(received.approach); return true; } });
  assert.equal(result.status, 'completed', result.reason);
  assert.deepEqual(seen, ['write ok.txt directly']);

  const stopped = new FakeRuntime({ scripts: { lead: [script([{ report: classifyPlanBuild }]), script([{ report: plan }])], builder: [] } });
  const stop = await go(stopped, tmp(), { confirmPlan: async () => false });
  assert.equal(stop.status, 'needs_user');
  assert.deepEqual(stop.plan, plan);
  assert.equal(stopped.turns.filter(turn => turn.role === 'builder').length, 0);
});

test('plan-build: a planner that changes files ends as needs_review', async () => {
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ report: classifyPlanBuild }]), script([{ writeFile: { path: 'sneaky.txt', content: 'x' } }, { report: plan }])], builder: [] } });
  const result = await go(runtime, tmp());
  assert.equal(result.status, 'needs_review');
  assert.equal(runtime.turns.filter(turn => turn.role === 'builder').length, 0);
});

test('investigate: one read-only researcher per angle, run in parallel, assembled without another model call', async () => {
  const angles = ['where is the port set', 'how is the config loaded'];
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ report: classifyInvestigate(angles) }])], researcher: angles.map(angle => script([{ usage: { inputTokens: 90, outputTokens: 10 } }, { report: research(angle) }])) } });
  const cwd = tmp();
  const result = await go(runtime, cwd);
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.workflow, 'investigate');
  const researcherTurns = runtime.turns.filter(turn => turn.role === 'researcher');
  assert.equal(researcherTurns.length, 2);
  assert.ok(researcherTurns.every(turn => turn.options.access === 'read-only'));
  assert.equal(new Set(researcherTurns.map(turn => turn.sessionId)).size, 2);
  assert.match(result.answer?.answer ?? '', /1\. where is the port set/);
  assert.match(result.answer?.answer ?? '', /claim for how is the config loaded \(src\/a\.ts:1\)/);
  assert.deepEqual(result.answer?.sources, ['src/a.ts']);
  assert.equal(result.research?.length, 2);
  assert.equal(result.usage.totalTokens, 200);
  assert.deepEqual(fs.readdirSync(cwd), []);
  assert.equal(runtime.turns.filter(turn => turn.role === 'lead').length, 1);
});

test('investigate: no angles uses the request; more than 3 angles are capped with a warning', async () => {
  const none = new FakeRuntime({ scripts: { lead: [script([{ report: classifyInvestigate([]) }])], researcher: [script([{ report: research('do the thing') }])] } });
  const single = await go(none, tmp());
  assert.equal(single.status, 'completed', single.reason);
  assert.match(none.turns.find(turn => turn.role === 'researcher')?.input.text ?? '', /Your angle[^]*do the thing/);

  const many = ['a', 'b', 'c', 'd', 'e'];
  const capped = new FakeRuntime({ scripts: { lead: [script([{ report: classifyInvestigate(many) }])], researcher: ['a', 'b', 'c'].map(angle => script([{ report: research(angle) }])) } });
  const result = await go(capped, tmp());
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.research?.length, 3);
  assert.ok(result.warnings.some(item => /first 3 of 5/.test(item)));
});

test('investigate: a failing researcher fails the run; a researcher that changes files needs review', async () => {
  const failing = new FakeRuntime({ scripts: { lead: [script([{ report: classifyInvestigate(['a', 'b']) }])], researcher: [script([{ report: research('a') }]), script([{ fail: 'model refused' }])] } });
  const failed = await go(failing, tmp());
  assert.equal(failed.status, 'failed');
  assert.match(failed.reason, /model refused/);

  const writing = new FakeRuntime({ scripts: { lead: [script([{ report: classifyInvestigate(['a']) }])], researcher: [script([{ writeFile: { path: 'x.txt', content: 'x' } }, { report: research('a') }])] } });
  assert.equal((await go(writing, tmp())).status, 'needs_review');
});

test('a role file can restrict the builder to read-only but nothing can widen the other roles', async () => {
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ report: { workflow: 'build', requirements: [{ id: 'R1', text: 'x' }], reason: 'r' } }])], builder: [script([{ report: { summary: 's', changedFiles: [], commandsRun: [], requirements: [{ id: 'R1', status: 'not_done', evidence: '' }], unverified: [] } }])] } });
  await go(runtime, tmp(), { access: { builder: 'read-only', lead: 'workspace-write' } });
  assert.equal(runtime.turns.find(turn => turn.role === 'builder')?.options.access, 'read-only');
  assert.equal(runtime.turns.find(turn => turn.role === 'lead')?.options.access, 'read-only');
});

test('skills: each role session gets its own skills, listed by id, description and SKILL.md path in the instructions', async () => {
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ report: classifyPlanBuild }]), script([{ report: plan }])], builder: [script([{ writeFile: { path: 'ok.txt', content: 'x' } }, { report: builderReport }])] } });
  const skill = { id: 'api-conventions', description: 'Use when adding an endpoint.\nNot for UI work.', path: '.agent-desk/skills/api-conventions/SKILL.md' };
  const result = await go(runtime, tmp(), { verify: [VERIFY], skills: { builder: [skill] } });
  assert.equal(result.status, 'completed', result.reason);
  const buildTurn = runtime.turns.find(turn => turn.role === 'builder');
  assert.deepEqual(buildTurn?.options.skills, [skill]);
  assert.match(buildTurn?.options.instructions ?? '', /- api-conventions: Use when adding an endpoint\. Not for UI work\. \(\.agent-desk\/skills\/api-conventions\/SKILL\.md\)/);
  assert.match(buildTurn?.options.instructions ?? '', /read its SKILL\.md/);
  const leadTurn = runtime.turns.find(turn => turn.role === 'lead');
  assert.deepEqual(leadTurn?.options.skills, []);
  assert.doesNotMatch(leadTurn?.options.instructions ?? '', /SKILL\.md/);
});
