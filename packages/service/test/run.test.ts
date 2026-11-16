import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FakeRuntime } from '#runtime-fake';
import { RunStore } from '#store';
import { executeRun, resumeBrief } from '../src/index.ts';

const answer = { workflow: 'answer', requirements: [], reason: 'question', answer: 'Port 3000.', sources: [] };
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const response = (used: number) => ({ rateLimitsByLimitId: { codex: { primary: { usedPercent: used, windowDurationMins: 300, resetsAt: 1_800_000_000 } } } });

/** A machine where both runtimes "exist" (dummy executables) and every runtime is a fake that answers. */
function machine() {
  const home = tmp('svc-home-');
  const codex = path.join(home, 'codex.exe'); const claude = path.join(home, 'claude.exe');
  fs.writeFileSync(codex, ''); fs.writeFileSync(claude, '');
  const created: string[] = [];
  const createRuntime = (kind: string) => { created.push(kind); return new FakeRuntime({ scripts: { lead: [{ turns: [[{ report: answer }]] }] } }); };
  return { env: { AGENT_DESK_HOME: home, AGENT_DESK_CODEX: codex, AGENT_DESK_CLAUDE: claude }, home, created, createRuntime };
}
const settingsOf = (home: string, runId: number) => { const store = new RunStore(path.join(home, 'agent-desk.db')); try { return store.getSettings(runId); } finally { store.close(); } };

test('each run records the settings it started with', async () => {
  const m = machine();
  const outcome = await executeRun({ project: tmp('svc-p-'), request: 'Which port?', env: m.env, platform: 'linux', createRuntime: m.createRuntime, readRateLimits: async () => response(10), images: ['/tmp/a.png'] });
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  const settings = settingsOf(m.home, outcome.runId)!;
  assert.equal(settings.mode, 'default');
  assert.deepEqual(settings.runtimes, { lead: 'codex', builder: 'codex', verifier: 'claude', researcher: 'codex' });
  assert.equal(settings.review, 'always');
  assert.equal(settings.images, 1);
});

test('fallback: Codex nearly out of its 5-hour window hands Codex roles to Claude, unless the team was chosen', async () => {
  const m = machine();
  const project = tmp('svc-p-');
  const outcome = await executeRun({ project, request: 'Which port?', env: m.env, platform: 'linux', createRuntime: m.createRuntime, readRateLimits: async () => response(97) });
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  const settings = settingsOf(m.home, outcome.runId)!;
  assert.deepEqual(Object.values(settings.runtimes as object), ['claude', 'claude', 'claude', 'claude']);
  assert.match(String(settings.fallback), /97%/);
  const chosen = await executeRun({ project, request: 'Which port?', env: m.env, platform: 'linux', createRuntime: m.createRuntime, readRateLimits: async () => response(97), mode: 'codex' });
  assert.ok(chosen.ok);
  if (chosen.ok) assert.deepEqual(Object.values(settingsOf(m.home, chosen.runId)!.runtimes as object), ['codex', 'codex', 'codex', 'codex']);
  fs.mkdirSync(path.join(project, '.agent-desk'));
  fs.writeFileSync(path.join(project, '.agent-desk', 'config.json'), JSON.stringify({ limits: { switchAtCodexPercent: 0 } }));
  const off = await executeRun({ project, request: 'Which port?', env: m.env, platform: 'linux', createRuntime: m.createRuntime, readRateLimits: async () => response(99) });
  assert.ok(off.ok);
  if (off.ok) assert.equal(settingsOf(m.home, off.runId)!.fallback, undefined);
});

test('resume: the new run is told where the old one stopped and what is left', async () => {
  const brief = resumeBrief({ id: 7, status: 'interrupted', reason: 'token budget', brief: 'did R1' }, {
    requirements: [{ id: 'R1', text: 'add field' }, { id: 'R2', text: 'show it' }],
    builder: { requirements: [{ id: 'R1', status: 'done' }, { id: 'R2', status: 'not_done' }] },
    resume: { step: 'build', note: 'budget' },
  });
  assert.match(brief, /continues run 7, which ended as interrupted: token budget/);
  assert.match(brief, /stopped at the build step/);
  assert.match(brief, /- R2: show it/);
  assert.doesNotMatch(brief, /- R1:/);
  const m = machine();
  const project = tmp('svc-p-');
  const first = await executeRun({ project, request: 'Which port?', env: m.env, platform: 'linux', createRuntime: m.createRuntime, runtime: 'fake' });
  assert.ok(first.ok);
  if (!first.ok) return;
  const second = await executeRun({ project, request: 'Which port?', env: m.env, platform: 'linux', createRuntime: m.createRuntime, runtime: 'fake', resumeOf: first.runId });
  assert.ok(second.ok);
  if (second.ok) assert.equal(settingsOf(m.home, second.runId)!.resumeOf, first.runId);
  const missing = await executeRun({ project, request: 'x', env: m.env, platform: 'linux', createRuntime: m.createRuntime, runtime: 'fake', resumeOf: 9999 });
  assert.equal(missing.ok, false);
});

import { chosenSkills, dryRun, runTriggerTest } from '../src/index.ts';

test('dry run reports the team, checks and skills without starting a model', () => {
  const m = machine();
  const project = tmp('svc-p-');
  fs.mkdirSync(path.join(project, '.agent-desk', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(project, '.agent-desk', 'config.json'), JSON.stringify({ mode: 'claude+codex' }));
  fs.writeFileSync(path.join(project, '.agent-desk', 'agents', 'builder.md'), '---\nskills: [ghost]\n---\n');
  const report = dryRun({ project, env: m.env, platform: 'linux' });
  assert.deepEqual(report.runtimes, { lead: 'claude', builder: 'claude', verifier: 'codex', researcher: 'claude' });
  assert.ok(report.problems.some(problem => /ghost/.test(problem)));
  assert.ok(report.notes.some(note => /No verify commands/.test(note)));
  assert.equal(m.created.length, 0);
});

test('trigger test: one fresh session per case, hit rate and false-trigger rate per skill', async () => {
  const project = tmp('svc-p-');
  const dir = path.join(project, '.agent-desk', 'skills', 'api-rules');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'triggers.json'), JSON.stringify({ should: ['add an endpoint', 'change status codes'], shouldNot: ['fix the CSS'] }));
  const reply = (skills: string[]) => ({ turns: [[{ message: JSON.stringify({ skills }), final: true }]] });
  const runtime = new FakeRuntime({ scripts: { lead: [reply(['api-rules']), reply([]), reply(['api-rules'])] } });
  const skills = [{ id: 'api-rules', description: 'Checks endpoints when adding one. Not for UI.', path: '.agent-desk/skills/api-rules/SKILL.md' }, { id: 'no-cases', description: 'x', path: '.agent-desk/skills/no-cases/SKILL.md' }];
  const results = await runTriggerTest({ project, runtime, skills });
  assert.equal(results[0]!.hitRate, 0.5);
  assert.equal(results[0]!.falseRate, 1);
  assert.equal(new Set(runtime.turns.map(turn => turn.sessionId)).size, 3);
  assert.equal(runtime.turns[0]!.options.access, 'read-only');
  assert.match(results[1]!.missing ?? '', /triggers\.json/);
  assert.deepEqual(chosenSkills('I would read api-rules first.', ['api-rules', 'api']), ['api-rules']);
});
