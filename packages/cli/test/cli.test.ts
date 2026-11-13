import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FakeRuntime } from '#runtime-fake';
import type { FakeScript } from '#runtime-fake';
import { RunStore } from '#store';
import { main, parseArgs } from '../src/main.ts';
import type { CliDeps } from '../src/main.ts';
import { resolveClaudeExecutable, resolveCodexExecutable, versionWarning } from '#service';
import { validateConfig } from '#project';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
const script = (...turns: FakeScript['turns']): FakeScript => ({ turns });
const answerReport = { workflow: 'answer', requirements: [], reason: 'plain question', answer: 'It listens on 3000.', sources: ['server.js'] };

function harness(project: string, runtime: FakeRuntime, extra: Partial<CliDeps> = {}) {
  const home = tmp();
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    env: { AGENT_DESK_HOME: home }, platform: 'linux', cwd: project,
    out: t => out.push(t), err: t => err.push(t),
    createRuntime: () => runtime,
    ...extra,
  };
  return { deps, home, out, err };
}

test('parseArgs reads options and rejects bad ones', () => {
  const ok = parseArgs(['run', 'fix', 'the bug', '--unattended', '--verify', 'npm test', '--max-tokens', '5000', '--review', 'auto']);
  assert.equal(ok.command, 'run');
  assert.equal(ok.request, 'fix the bug');
  assert.deepEqual(ok.verify, ['npm test']);
  assert.equal(ok.maxTokens, 5000);
  assert.equal(ok.review, 'auto');
  const bad = parseArgs(['run', 'x', '--review', 'sometimes', '--nope', '--max-tokens', '-1']);
  assert.equal(bad.errors.length, 3);
});

test('run answers a question, stores the run and exits 0', async () => {
  const project = tmp();
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ report: answerReport }])], builder: [] } });
  const { deps, home, out } = harness(project, runtime);
  const code = await main(['run', 'Which port?', '--runtime', 'fake', '--project', project], deps);
  assert.equal(code, 0);
  assert.match(out.join(''), /Status: completed/);
  assert.match(out.join(''), /It listens on 3000\./);
  const store = new RunStore(path.join(home, 'agent-desk.db'));
  try {
    const runs = store.listRuns(project);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, 'completed');
    assert.ok(store.latestBrief(project));
  } finally { store.close(); }
});

test('second run receives the previous run brief', async () => {
  const project = tmp();
  const home = tmp();
  const make = () => new FakeRuntime({ scripts: { lead: [script([{ report: answerReport }])], builder: [] } });
  const first = make();
  await main(['run', 'Which port?', '--runtime', 'fake'], { env: { AGENT_DESK_HOME: home }, platform: 'linux', cwd: project, out: () => {}, err: () => {}, createRuntime: () => first });
  const second = make();
  await main(['run', 'And the host?', '--runtime', 'fake'], { env: { AGENT_DESK_HOME: home }, platform: 'linux', cwd: project, out: () => {}, err: () => {}, createRuntime: () => second });
  assert.match(second.turns[0]?.input.text ?? '', /Which port\?/);
});

test('--unattended turns an agent question into needs_user (exit 3) and never prompts', async () => {
  const project = tmp();
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ ask: { question: 'Which database?' } }])], builder: [] } });
  let asked = 0;
  const { deps } = harness(project, runtime, { ask: async () => { asked++; return 'sqlite'; } });
  const code = await main(['run', 'Add storage', '--runtime', 'fake', '--unattended'], deps);
  assert.equal(asked, 0);
  assert.equal(code, 3);
});

test('interactive run passes the answer back to the agent', async () => {
  const project = tmp();
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ ask: { question: 'Which database?', options: ['sqlite', 'postgres'] } }, { report: answerReport }])], builder: [] } });
  const { deps } = harness(project, runtime, { ask: async () => 'sqlite' });
  const code = await main(['run', 'Add storage', '--runtime', 'fake'], deps);
  assert.equal(code, 0);
});

test('invalid project config stops the run with exit 64', async () => {
  const project = tmp();
  fs.mkdirSync(path.join(project, '.agent-desk'));
  fs.writeFileSync(path.join(project, '.agent-desk', 'config.json'), JSON.stringify({ verfy: ['x'] }));
  const { deps, err } = harness(project, new FakeRuntime({ scripts: {} }));
  assert.equal(await main(['run', 'x', '--runtime', 'fake'], deps), 64);
  assert.match(err.join(''), /config\.verfy: unknown key/);
});

test('doctor reports a missing verify command and a healthy fake runtime', async () => {
  const project = tmp();
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const { deps, out } = harness(project, new FakeRuntime({ scripts: {} }));
  const code = await main(['doctor', '--runtime', 'fake'], deps);
  assert.equal(code, 1);
  assert.match(out.join(''), /ok\s+fake runtime/);
  assert.match(out.join(''), /FAIL verify commands/);
  assert.match(out.join(''), /candidate: "npm test"/);
});

test('doctor reports an unhealthy runtime', async () => {
  const project = tmp();
  const { deps, out } = harness(project, new FakeRuntime({ scripts: {}, healthy: false }));
  assert.equal(await main(['doctor', '--runtime', 'fake'], deps), 1);
  assert.match(out.join(''), /FAIL fake runtime/);
});

test('doctor without Codex explains the fix; with Codex it saves the path', async () => {
  const project = tmp();
  const none = harness(project, new FakeRuntime({ scripts: {} }), {});
  none.deps.env = { AGENT_DESK_HOME: none.home, PATH: '' };
  assert.equal(await main(['doctor'], none.deps), 1);
  assert.match(none.out.join(''), /codex executable: not found/);

  const bin = tmp();
  const exe = path.join(bin, 'codex');
  fs.writeFileSync(exe, '#!/bin/sh\n');
  const found = harness(project, new FakeRuntime({ scripts: {} }), { readVersion: async () => 'codex-cli 0.167.2' });
  found.deps.env = { AGENT_DESK_HOME: found.home, PATH: bin };
  await main(['doctor'], found.deps);
  assert.match(found.out.join(''), /ok\s+codex executable/);
  assert.match(found.out.join(''), /ok\s+codex version/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(found.home, 'machine.json'), 'utf8')).codex.path, exe);
});

test('Windows npm shim is followed to the real codex.exe', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'codex.cmd'), '@echo off');
  const real = path.join(root, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'codex.exe');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '');
  // path.join uses the host separator; the search logic is the same on every platform.
  const found = resolveCodexExecutable({ env: { PATH: root }, platform: 'win32' });
  assert.equal(found?.path, real);
});

test('version warning and config validation', () => {
  assert.equal(versionWarning('codex-cli 0.167.4'), null);
  assert.match(versionWarning('codex-cli 0.201.0') ?? '', /not been checked/);
  assert.match(versionWarning('garbage') ?? '', /could not read/);
  const bad = validateConfig({ runtime: 'x', verify: [''], review: 'maybe', limits: { redo: -1, foo: 1 } });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.errors.length, 5);
  assert.equal(validateConfig({ verify: ['npm test'], review: 'auto', limits: { redo: 1, tokens: 1000 } }).ok, true);
});

test('revert: needs_review run leaves changes; revert shows a plan, then --yes restores the files', async () => {
  const project = tmp();
  fs.writeFileSync(path.join(project, 'keep.txt'), 'original');
  const classify = { workflow: 'build', requirements: [{ id: 'R1', text: 'edit' }], reason: 'x' };
  const builderReport = { summary: 's', changedFiles: ['keep.txt', 'new.txt'], commandsRun: [], requirements: [{ id: 'R1', status: 'done', evidence: 'keep.txt' }], unverified: [] };
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ report: classify }])], builder: [script([{ writeFile: { path: 'keep.txt', content: 'changed' } }, { writeFile: { path: 'new.txt', content: 'x' } }, { report: builderReport }])] } });
  const { deps, home, out, err } = harness(project, runtime);
  const code = await main(['run', 'edit it', '--runtime', 'fake'], deps);
  assert.equal(code, 2); // no verify command -> needs_review
  assert.match(err.join(''), /agent-desk revert 1/);
  assert.equal(fs.readFileSync(path.join(project, 'keep.txt'), 'utf8'), 'changed');

  out.length = 0;
  assert.equal(await main(['revert', '1'], deps), 0);
  assert.match(out.join(''), /restore: 1 file\(s\) - keep\.txt/);
  assert.match(out.join(''), /remove:  1 file\(s\) - new\.txt/);
  assert.match(out.join(''), /Not applied/);
  assert.equal(fs.readFileSync(path.join(project, 'keep.txt'), 'utf8'), 'changed');

  assert.equal(await main(['revert', '1', '--yes'], deps), 0);
  assert.equal(fs.readFileSync(path.join(project, 'keep.txt'), 'utf8'), 'original');
  assert.ok(!fs.existsSync(path.join(project, 'new.txt')));
  assert.ok(fs.existsSync(path.join(home, 'restore', '1')));
  out.length = 0;
  await main(['revert', '1'], deps);
  assert.match(out.join(''), /Nothing to undo/);
});

test('revert of an unknown run or missing restore point fails clearly', async () => {
  const project = tmp();
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ report: answerReport }])], builder: [] } });
  const { deps, err } = harness(project, runtime);
  assert.equal(await main(['revert', '1'], deps), 64);
  await main(['run', 'Which port?', '--runtime', 'fake'], deps);
  assert.equal(await main(['revert', '9'], deps), 64);
  assert.equal(await main(['revert', '1'], deps), 1); // answer runs make no restore point
  assert.match(err.join(''), /no restore point/);
});

test('mixed runtimes: config.runtimes picks a runtime per role, each found by its own discovery', async () => {
  const project = tmp();
  fs.mkdirSync(path.join(project, '.agent-desk'));
  fs.writeFileSync(path.join(project, '.agent-desk', 'config.json'), JSON.stringify({ runtimes: { primary: 'codex', review: 'claude' } }));
  const bin = tmp();
  for (const name of ['codex', 'claude']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n');
  const created: Array<[string, string | undefined]> = [];
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ report: answerReport }])], builder: [] } });
  const { deps, home } = harness(project, runtime, { createRuntime: (kind, command) => { created.push([kind, command]); return runtime; } });
  deps.env = { AGENT_DESK_HOME: home, PATH: bin };
  assert.equal(await main(['run', 'Which port?'], deps), 0);
  assert.deepEqual(created.map(([kind]) => kind).sort(), ['claude', 'codex']);
  assert.equal(created.find(([kind]) => kind === 'claude')?.[1], path.join(bin, 'claude'));
  created.length = 0;
  await main(['run', 'Which port?', '--runtime', 'fake'], deps);
  assert.deepEqual(created, [['fake', undefined]]);
});

test('doctor checks every runtime in use; claude is found in ~/.local/bin', async () => {
  const project = tmp();
  fs.mkdirSync(path.join(project, '.agent-desk'));
  fs.writeFileSync(path.join(project, '.agent-desk', 'config.json'), JSON.stringify({ runtimes: { primary: 'codex', review: 'claude' }, verify: ['npm test'] }));
  const bin = tmp();
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n');
  const home = tmp();
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '#!/bin/sh\n');
  const found = resolveClaudeExecutable({ env: { PATH: '' }, platform: 'linux', home });
  assert.equal(found?.source, '~/.local/bin');
  const { deps, out } = harness(project, new FakeRuntime({ scripts: {} }), { readVersion: async exe => (exe.endsWith('claude') ? '2.1.322 (Claude Code)' : 'codex-cli 0.167.2') });
  deps.env = { AGENT_DESK_HOME: tmp(), PATH: bin, HOME: home };
  await main(['doctor'], deps);
  assert.match(out.join(''), /ok\s+codex executable/);
  assert.match(out.join(''), /ok\s+claude executable/);
  assert.match(out.join(''), /ok\s+claude version: 2\.1\.322/);
});

test('config validation covers runtimes, roles and allowCommands', () => {
  assert.equal(validateConfig({ runtimes: { primary: 'codex', review: 'claude' }, roles: { verifier: { runtime: 'review' } }, allowCommands: ['make test'], skills: ['api'] }).ok, true);
  const bad = validateConfig({ runtimes: { primary: 'gpt', extra: 'codex' }, roles: { boss: { runtime: 'primary' }, builder: { effort: 'high' } }, allowCommands: [1] });
  assert.equal(bad.ok, false);
  if (!bad.ok) { assert.equal(bad.errors.length, 5); assert.ok(bad.errors.some(error => /agents\/builder\.md/.test(error))); }
});

test('plan-build in the CLI: interactive runs ask to confirm the plan; unattended runs go on', async () => {
  const classify = { workflow: 'plan-build', requirements: [{ id: 'R1', text: 'edit' }], reason: 'x' };
  const plan = { approach: 'edit it', steps: ['edit a.txt'], files: ['a.txt'], risks: [] };
  const builderReport = { summary: 's', changedFiles: ['a.txt'], commandsRun: [], requirements: [{ id: 'R1', status: 'done', evidence: 'a.txt' }], unverified: [] };
  const make = () => new FakeRuntime({ scripts: { lead: [script([{ report: classify }]), script([{ report: plan }])], builder: [script([{ writeFile: { path: 'a.txt', content: 'x' } }, { report: builderReport }])] } });

  const questions: string[] = [];
  const stopped = harness(tmp(), make(), { ask: async q => { questions.push(q.question); return 'stop'; } });
  assert.equal(await main(['run', 'edit', '--runtime', 'fake'], stopped.deps), 3);
  assert.match(questions[0] ?? '', /Plan:\nApproach: edit it/);

  const unattended = harness(tmp(), make(), { ask: async () => { throw new Error('must not ask'); } });
  assert.equal(await main(['run', 'edit', '--runtime', 'fake', '--unattended', '--review', 'never', '--verify', 'node -e "0"'], unattended.deps), 0);
  assert.match(unattended.out.join(''), /Plan: edit it \(1 step\(s\)\)/);
});

test('init previews by default, writes with --yes, never overwrites, and doctor then sees the role files', async () => {
  const project = tmp();
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const bin = tmp();
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n');
  const { deps, out } = harness(project, new FakeRuntime({ scripts: {} }));
  deps.env = { AGENT_DESK_HOME: tmp(), PATH: bin };
  assert.equal(await main(['init'], deps), 0);
  assert.match(out.join(''), /Stack: Node\.js/);
  assert.match(out.join(''), /runtimes\.primary = codex/);
  assert.match(out.join(''), /Not written/);
  assert.ok(!fs.existsSync(path.join(project, '.agent-desk')));

  out.length = 0;
  assert.equal(await main(['init', '--yes'], deps), 0);
  assert.match(out.join(''), /Created 5 file\(s\)/);
  assert.ok(fs.existsSync(path.join(project, '.agent-desk', 'agents', 'builder.md')));
  const config = JSON.parse(fs.readFileSync(path.join(project, '.agent-desk', 'config.json'), 'utf8'));
  assert.deepEqual(config.verify, ['npm test']);

  out.length = 0;
  assert.equal(await main(['init', '--yes'], deps), 0);
  assert.match(out.join(''), /Nothing to create/);
  out.length = 0;
  await main(['doctor', '--runtime', 'fake'], deps);
  assert.match(out.join(''), /ok\s+role files: all 4 present/);
  assert.match(out.join(''), /ok\s+verify commands: 1 configured/);
});

test('skills check prints findings and exits 1 on errors', async () => {
  const project = tmp();
  const { deps, out } = harness(project, new FakeRuntime({ scripts: {} }));
  assert.equal(await main(['skills', 'check'], deps), 0);
  assert.match(out.join(''), /No skills yet/);
  fs.mkdirSync(path.join(project, '.agent-desk', 'skills', 'broken'), { recursive: true });
  out.length = 0;
  assert.equal(await main(['skills', 'check'], deps), 1);
  assert.match(out.join(''), /ERROR broken: missing SKILL\.md/);
  assert.equal(await main(['skills'], deps), 64);
});

test('memory: builder suggestions are printed, saved only on approval, and memory reaches every role', async () => {
  const classify = { workflow: 'build', requirements: [{ id: 'R1', text: 'edit' }], reason: 'x' };
  const builderReport = { summary: 's', changedFiles: ['a.txt'], commandsRun: [], requirements: [{ id: 'R1', status: 'done', evidence: 'a.txt' }], unverified: [], memorySuggestions: ['Emulator port is 8081', 'Tests need Docker'] };
  const make = () => new FakeRuntime({ scripts: { lead: [script([{ report: classify }])], builder: [script([{ writeFile: { path: 'a.txt', content: 'x' } }, { report: builderReport }])] } });
  const project = tmp();
  fs.mkdirSync(path.join(project, '.agent-desk'));
  fs.writeFileSync(path.join(project, '.agent-desk', 'memory.md'), '# Project memory\n\n- Migrations are applied by the user\n');

  const unattended = make();
  const first = harness(project, unattended);
  await main(['run', 'edit', '--runtime', 'fake', '--unattended', '--review', 'never', '--verify', 'node -e "0"'], first.deps);
  assert.match(first.out.join(''), /Memory suggestions \(nothing was saved\)/);
  assert.match(first.out.join(''), /agent-desk memory add/);
  assert.ok(!fs.readFileSync(path.join(project, '.agent-desk', 'memory.md'), 'utf8').includes('8081'));
  assert.match(unattended.turns[0]?.options.instructions ?? '', /Project memory[^]*Migrations are applied by the user/);
  assert.match(unattended.turns.find(turn => turn.role === 'builder')?.options.instructions ?? '', /Migrations are applied/);

  const answers: string[] = [];
  const second = harness(project, make(), { ask: async q => { answers.push(q.question); return q.question.includes('8081') ? 'add' : 'skip'; } });
  await main(['run', 'edit', '--runtime', 'fake', '--review', 'never', '--verify', 'node -e "0"'], second.deps);
  assert.equal(answers.filter(question => /Add to project memory/.test(question)).length, 2);
  const memory = fs.readFileSync(path.join(project, '.agent-desk', 'memory.md'), 'utf8');
  assert.match(memory, /Emulator port is 8081/);
  assert.ok(!memory.includes('Docker'));

  const cli = harness(project, new FakeRuntime({ scripts: {} }));
  assert.equal(await main(['memory'], cli.deps), 0);
  assert.match(cli.out.join(''), /- Emulator port is 8081/);
  assert.equal(await main(['memory', 'add', 'Tests need Docker'], cli.deps), 0);
  assert.equal(await main(['memory', 'add', 'Tests need Docker'], cli.deps), 1);
  assert.equal(await main(['memory', 'wipe'], cli.deps), 64);
});

test('serve starts the local server, reports its port and stops on abort', async () => {
  const controller = new AbortController();
  const { deps, out } = harness(tmp(), new FakeRuntime({ scripts: {} }), { signal: controller.signal });
  const done = main(['serve', '--port', '45123'], deps);
  for (let i = 0; i < 100 && !out.join('').includes('listening'); i++) await new Promise(r => setTimeout(r, 30));
  assert.match(out.join(''), /listening on http:\/\/127\.0\.0\.1:\d+/);
  controller.abort();
  assert.equal(await done, 0);
  assert.ok(parseArgs(['serve', '--port', '80']).errors.length === 1);
});
