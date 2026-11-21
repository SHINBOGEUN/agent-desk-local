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
  fs.mkdirSync(path.join(project, '.agent-desk'), { recursive: true });
  fs.writeFileSync(path.join(project, '.agent-desk', 'config.json'), JSON.stringify({ limits: { switchAtCodexPercent: 0 } }));
  const off = await executeRun({ project, request: 'Which port?', env: m.env, platform: 'linux', createRuntime: m.createRuntime, readRateLimits: async () => response(99) });
  assert.ok(off.ok);
  if (off.ok) assert.equal(settingsOf(m.home, off.runId)!.fallback, undefined);
});

test('fallback also happens when the weekly window is the one used up', async () => {
  const m = machine();
  const project = tmp('svc-p-');
  const weekly = { rateLimitsByLimitId: { codex: { primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1_800_000_000 } } } };
  const outcome = await executeRun({ project, request: 'Which port?', env: m.env, platform: 'linux', createRuntime: m.createRuntime, readRateLimits: async () => weekly });
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  const settings = settingsOf(m.home, outcome.runId)!;
  assert.deepEqual(Object.values(settings.runtimes as object), ['claude', 'claude', 'claude', 'claude']);
  assert.match(String(settings.fallback), /weekly usage is 100%/);
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

test('a run writes its note and memory proposals to the vault; approvals made in Obsidian reach memory before the next run', async () => {
  const home = tmp('svc-home-');
  const codex = path.join(home, 'codex.exe'); fs.writeFileSync(codex, '');
  const withMemory = { ...answer, memorySuggestions: ['Dates are YYYY-MM-DD'] };
  const createRuntime = () => new FakeRuntime({ scripts: { lead: [{ turns: [[{ report: withMemory }]] }] } });
  const env = { AGENT_DESK_HOME: home, AGENT_DESK_CODEX: codex };
  const project = tmp('svc-p-');
  const first = await executeRun({ project, request: '앞으로 날짜는 YYYY-MM-DD로 하자', env, platform: 'linux', createRuntime, mode: 'codex', language: 'ko' });
  assert.ok(first.ok);
  if (!first.ok) return;
  const vault = path.join(project, '.agent-desk', 'notes');
  const runNote = fs.readFileSync(path.join(vault, 'runs', `${String(first.runId).padStart(4, '0')} 앞으로 날짜는 YYYY-MM-DD로 하자.md`), 'utf8');
  assert.match(runNote, /^---\ntype: run\nrun: \d+\nstatus: completed/);
  assert.match(runNote, /## 답변\n\nPort 3000\./);
  assert.match(runNote, /## 메모 제안\n\n- \[\[inbox\/Dates are YYYY-MM-DD\]\]/);
  const inbox = path.join(vault, 'inbox', 'Dates are YYYY-MM-DD.md');
  assert.match(fs.readFileSync(inbox, 'utf8'), /status: proposed/);
  assert.equal(fs.existsSync(path.join(project, '.agent-desk', 'memory.md')), false);

  fs.writeFileSync(inbox, fs.readFileSync(inbox, 'utf8').replace('status: proposed', 'status: approved'));
  const notes: string[] = [];
  const second = await executeRun({ project, request: 'Which port?', env, platform: 'linux', createRuntime, mode: 'codex', onNote: note => notes.push(note) });
  assert.ok(second.ok);
  assert.match(fs.readFileSync(path.join(project, '.agent-desk', 'memory.md'), 'utf8'), /- Dates are YYYY-MM-DD/);
  assert.ok(fs.existsSync(path.join(vault, 'decisions', 'Dates are YYYY-MM-DD.md')));
  assert.ok(notes.some(note => /added to memory from approved notes: Dates are YYYY-MM-DD/.test(note)));
});

test('read_notes answers from specs and decisions, never from runs or the unapproved inbox', async () => {
  const { notesLookup, noteTextOf, vaultIndexText } = await import('../src/index.ts');
  const root = tmp('svc-vault-');
  const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put('specs/Due date.md', '---\ntags: [spec]\n---\nShow the due date as YYYY-MM-DD next to the title.');
  put('decisions/Polite errors.md', 'Error messages are polite.');
  put('inbox/Use tabs.md', 'Use tabs (unapproved).');
  put('runs/0001 x.md', 'run record about due date');
  assert.equal(vaultIndexText(root).split('\n').sort().join('\n'), '- decisions/Polite errors.md\n- specs/Due date.md (#spec)');
  assert.match(notesLookup(root, { path: 'specs/Due date' }), /YYYY-MM-DD/);
  assert.match(notesLookup(root, { path: 'inbox/Use tabs.md' }), /No readable note/);
  assert.match(notesLookup(root, { search: 'due date' }), /^## specs\/Due date\.md/);
  assert.doesNotMatch(notesLookup(root, { search: 'due date' }), /runs\//);
  assert.equal(noteTextOf(root, 'runs/0001 x.md'), null);
  assert.equal(vaultIndexText(tmp('svc-empty-')), '');
});

test('import writes notes for past runs and existing memory once; run notes link roles and skills read', async () => {
  const { importHistory, runNoteText } = await import('../src/index.ts');
  const home = tmp('svc-home-');
  const project = tmp('svc-p-');
  const store = new RunStore(path.join(home, 'agent-desk.db'));
  try {
    const id = store.startRun(project, 'add a ping endpoint');
    store.finishRun(id, 'add a ping endpoint', { status: 'completed', reason: 'all gates passed', workflow: 'build', requirements: [{ id: 'R1', text: 'GET /ping' }], gates: [], redo: 1, warnings: [], unverified: [], usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 }, usageEntries: [], events: [], builder: { summary: 'added ping', changedFiles: ['src/ping.js'], commandsRun: [], requirements: [{ id: 'R1', status: 'done', evidence: 'x' }], unverified: [] }, skillsRead: [{ step: 'build', role: 'builder', skill: 'verify-before-report' }], modelsUsed: { lead: 'gpt-a', builder: 'gpt-a' } });
    fs.mkdirSync(path.join(project, '.agent-desk'), { recursive: true });
    fs.writeFileSync(path.join(project, '.agent-desk', 'memory.md'), '# Project memory\n\n- Dates are YYYY-MM-DD\n');
    const root = path.join(project, '.agent-desk', 'notes');
    assert.deepEqual(importHistory(store, project, root, 'ko'), { runs: 1, decisions: 1, skipped: 0 });
    assert.deepEqual(importHistory(store, project, root, 'ko'), { runs: 0, decisions: 0, skipped: 1 });
    const note = fs.readFileSync(path.join(root, 'runs', `${String(id).padStart(4, '0')} add a ping endpoint.md`), 'utf8');
    assert.match(note, /## 변경 파일\n\n- \[\[src\/ping\.js\]\]/);
    assert.match(note, /## 참여한 역할\n\n- \[\[team\/roles\/lead\|lead\]\] \(gpt-a\)\n- \[\[team\/roles\/builder\|builder\]\] \(gpt-a\)/);
    assert.match(note, /## 읽은 스킬\n\n- \[\[team\/skills\/verify-before-report\|verify-before-report\]\]/);
    assert.ok(fs.existsSync(path.join(root, 'decisions', 'Dates are YYYY-MM-DD.md')));
    assert.equal(typeof runNoteText, 'function');
  } finally { store.close(); }
});
