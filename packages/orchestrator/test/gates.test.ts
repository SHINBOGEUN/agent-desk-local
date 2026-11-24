import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FakeRuntime } from '#runtime-fake';
import type { FakeScript } from '#runtime-fake';
import { detectVerify, checkBudget, checkChangeReport, checkNoChanges, classifyFailure, diffProtected, diffSnapshots, isTestPath, restoreProtected, runRequest, runVerify, takeSnapshot } from '#orchestrator';
import type { RunConfig, RunEvent } from '#orchestrator';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
const put = (cwd: string, rel: string, content = 'x') => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), content); };
const script = (...turns: FakeScript['turns']): FakeScript => ({ turns });
const write = (file: string, content = 'x') => ({ writeFile: { path: file, content } });
const NODE_OK = `node -e "process.exit(require('fs').existsSync('ok.txt')?0:1)"`;

const buildClassify = { workflow: 'build', requirements: [{ id: 'R1', text: 'create ok.txt', quote: 'create ok.txt' }], reason: 'one file' };
const report = (changedFiles: string[], status = 'done', extra: Record<string, unknown> = {}) => ({
  summary: 'did it', changedFiles, commandsRun: [], requirements: [{ id: 'R1', status, evidence: 'ok.txt' }], unverified: [], ...extra,
});
const lead = (...extra: FakeScript[]) => [script([{ report: buildClassify }]), ...extra];

function run(runtime: FakeRuntime, cwd: string, config: Partial<RunConfig> = {}) {
  return runRequest('create ok.txt', { cwd, runtime, review: 'never', ...config });
}

// ---------- snapshot and G2 ----------

test('snapshot sees added, modified and deleted files and skips ignored paths', () => {
  const cwd = tmp();
  put(cwd, 'a.txt'); put(cwd, 'b.txt'); put(cwd, 'node_modules/x/index.js'); put(cwd, 'logs/app.log'); put(cwd, 'cache/data.bin');
  const before = takeSnapshot(cwd, { ignore: ['*.log', 'cache/'] });
  put(cwd, 'a.txt', 'changed'); fs.rmSync(path.join(cwd, 'b.txt')); put(cwd, 'c.txt'); put(cwd, 'node_modules/x/new.js'); put(cwd, 'logs/new.log'); put(cwd, 'cache/more.bin');
  const diff = diffSnapshots(before, takeSnapshot(cwd, { ignore: ['*.log', 'cache/'] }));
  assert.deepEqual(diff, { added: ['c.txt'], modified: ['a.txt'], deleted: ['b.txt'], all: ['a.txt', 'b.txt', 'c.txt'] });
});

test('G2 compares the report with the real changes', () => {
  const diff = { added: ['new.js'], modified: ['old.js'], deleted: [], all: ['new.js', 'old.js'] };
  const ok = checkChangeReport({ attempt: 0, cwd: '/p', reported: ['./new.js', '/p/old.js'], diff, ignore: [] });
  assert.equal(ok.ok, true);
  const bad = checkChangeReport({ attempt: 0, cwd: '/p', reported: ['new.js', 'ghost.js', 'node_modules/y.js'], diff, ignore: ['node_modules/'] });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.data?.unreported, ['old.js']);
  assert.deepEqual(bad.data?.falseClaims, ['ghost.js']);
  const flagged = checkChangeReport({ attempt: 0, cwd: '/p', reported: ['a.test.js', 'tests/b.js', 'src/c.js'], diff: { added: [], modified: ['a.test.js', 'tests/b.js', 'src/c.js'], deleted: [], all: ['a.test.js', 'src/c.js', 'tests/b.js'] }, ignore: [] });
  assert.deepEqual(flagged.data?.testFilesChanged, ['a.test.js', 'tests/b.js']);
  assert.equal(isTestPath('src/spec.helpers.js'), false);
  assert.equal(checkNoChanges({ attempt: 0, step: 'classify', diff: { added: [], modified: [], deleted: [], all: [] } }).ok, true);
  assert.equal(checkNoChanges({ attempt: 0, step: 'classify', diff }).ok, false);
});

test('protected paths are tracked and restored; git index and objects are not', () => {
  const cwd = tmp();
  put(cwd, '.agent-desk/config.json', 'orig'); put(cwd, '.git/HEAD', 'ref: refs/heads/main'); put(cwd, '.git/index', 'i'); put(cwd, '.git/objects/aa/bb', 'o'); put(cwd, '.git/refs/heads/main', 'abc');
  const before = takeSnapshot(cwd);
  assert.deepEqual([...before.protectedFiles.keys()].sort(), ['.agent-desk/config.json', '.git/HEAD', '.git/refs/heads/main']);
  put(cwd, '.git/index', 'changed'); put(cwd, '.git/objects/cc/dd', 'o2');
  assert.deepEqual(diffProtected(before, takeSnapshot(cwd)).all, []);
  put(cwd, '.agent-desk/config.json', 'tampered'); put(cwd, '.agent-desk/new.md'); put(cwd, '.git/refs/heads/main', 'zzz'); fs.rmSync(path.join(cwd, '.git/HEAD'));
  const after = takeSnapshot(cwd);
  assert.equal(diffProtected(before, after).all.length, 4);
  const outcome = restoreProtected(cwd, before, after);
  assert.deepEqual(outcome.failed, []);
  assert.equal(fs.readFileSync(path.join(cwd, '.agent-desk/config.json'), 'utf8'), 'orig');
  assert.equal(fs.existsSync(path.join(cwd, '.agent-desk/new.md')), false);
  assert.equal(fs.readFileSync(path.join(cwd, '.git/HEAD'), 'utf8'), 'ref: refs/heads/main');
  assert.equal(fs.readFileSync(path.join(cwd, '.git/refs/heads/main'), 'utf8'), 'abc');
});

// ---------- G3 ----------

test('G3 runs verify commands: pass, fail with output, timeout, missing command, none', async () => {
  const cwd = tmp();
  const pass = await runVerify({ attempt: 0, cwd, commands: ['node -e "process.exit(0)"'], timeoutMs: 20_000 });
  assert.equal(pass.result.ok, true);
  const fail = await runVerify({ attempt: 0, cwd, commands: ['node -e "console.log(\'boom detail\');process.exit(3)"'], timeoutMs: 20_000 });
  assert.equal(fail.result.ok, false);
  assert.match(fail.result.problems[0] ?? '', /exited with code 3/);
  assert.match(fail.result.problems[0] ?? '', /boom detail/);
  const slow = await runVerify({ attempt: 0, cwd, commands: ['node -e "setTimeout(()=>{},10000)"'], timeoutMs: 300 });
  assert.equal(slow.result.ok, false);
  assert.match(slow.result.problems[0] ?? '', /timed out/);
  const missing = await runVerify({ attempt: 0, cwd, commands: ['definitely-not-a-command-xyz'], timeoutMs: 20_000 });
  assert.equal(missing.result.ok, false);
  assert.equal(missing.result.data?.unavailable, true);
  const none = await runVerify({ attempt: 0, cwd, commands: [], timeoutMs: 1000 });
  assert.deepEqual([none.result.ok, none.result.skipped], [true, true]);
});

// ---------- G5 ----------

test('G5 checks tokens and time', () => {
  const usage = { inputTokens: 900, cachedInputTokens: 0, outputTokens: 100, reasoningTokens: 0, totalTokens: 1000 };
  assert.equal(checkBudget({ attempt: 0, budget: undefined, usage, elapsedMs: 1 }).skipped, true);
  assert.equal(checkBudget({ attempt: 0, budget: { maxTokens: 1000 }, usage, elapsedMs: 1 }).ok, true);
  assert.match(checkBudget({ attempt: 0, budget: { maxTokens: 999 }, usage, elapsedMs: 1 }).problems[0] ?? '', /Token budget/);
  assert.match(checkBudget({ attempt: 0, budget: { maxMillis: 1000 }, usage, elapsedMs: 5000 }).problems[0] ?? '', /Time budget/);
});

test('budget stops a run mid-turn and records where to resume', async () => {
  const cwd = tmp();
  const runtime = new FakeRuntime({ scripts: { lead: lead(), builder: [script([write('ok.txt'), { usage: { inputTokens: 5000, outputTokens: 10 } }, { hang: true }])] } });
  const result = await run(runtime, cwd, { budget: { maxTokens: 2000 } });
  assert.equal(result.status, 'interrupted');
  assert.match(result.reason, /Token budget exceeded/);
  assert.equal(result.resume?.step, 'build');
  assert.ok(result.gates.some(gate => gate.gate === 'G5' && !gate.ok));
});

// ---------- REDO ----------

test('G3 failure triggers a REDO in the same session and a fixed result completes', async () => {
  const cwd = tmp();
  const runtime = new FakeRuntime({ scripts: { lead: lead(), builder: [script(
    [write('bad.txt'), { report: report(['bad.txt']) }],
    [write('ok.txt'), { report: report(['bad.txt', 'ok.txt']) }],
  )] } });
  const events: RunEvent[] = [];
  const result = await run(runtime, cwd, { verify: [NODE_OK], onEvent: event => events.push(event) });
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.redo, 1);
  assert.equal(runtime.turns.filter(turn => turn.role === 'builder').length, 2);
  assert.equal(new Set(runtime.turns.filter(turn => turn.role === 'builder').map(turn => turn.sessionId)).size, 1);
  assert.match(runtime.turns.at(-1)?.input.text ?? '', /Verify command/);
  assert.deepEqual(result.gates.filter(gate => gate.gate === 'G3').map(gate => gate.ok), [false, true]);
  const redo = events.find(event => event.type === 'redo') as Extract<RunEvent, { type: 'redo' }>;
  assert.equal(redo.mode, 'same-session');
});

test('the second REDO uses a new session; after the limit the run needs review', async () => {
  const cwd = tmp();
  const runtime = new FakeRuntime({ scripts: { lead: lead(), builder: [
    script([write('a.txt'), { report: report(['a.txt']) }], [write('b.txt'), { report: report(['a.txt', 'b.txt']) }]),
    script([write('c.txt'), { report: report(['a.txt', 'b.txt', 'c.txt']) }]),
  ] } });
  const result = await run(runtime, cwd, { verify: [NODE_OK] });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.redo, 2);
  assert.match(result.reason, /Still failing after 2 redo/);
  const builderTurns = runtime.turns.filter(turn => turn.role === 'builder');
  assert.equal(new Set(builderTurns.map(turn => turn.sessionId)).size, 2);
  assert.match(builderTurns.at(-1)?.input.text ?? '', /new session/);
  assert.equal(runtime.remaining('builder'), 0);
});

test('G2 mismatch and not_done requirements are REDO reasons', async () => {
  const cwd = tmp();
  const runtime = new FakeRuntime({ scripts: { lead: lead(), builder: [script(
    [write('ok.txt'), write('extra.txt'), { report: report(['ok.txt', 'ghost.txt']) }],
    [{ report: report(['ok.txt', 'extra.txt'], 'not_done') }],
  ), script([{ report: report(['ok.txt', 'extra.txt']) }])] } });
  const result = await run(runtime, cwd, { redoLimit: 2 });
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.redo, 2);
  const texts = runtime.turns.filter(turn => turn.role === 'builder').map(turn => turn.input.text);
  assert.match(texts[1] ?? '', /not in changedFiles: extra\.txt/);
  assert.match(texts[1] ?? '', /did not change: ghost\.txt/);
  assert.match(texts[2] ?? '', /reported as not done/);
});

test('false completion is caught: a report with no real change never completes', async () => {
  const cwd = tmp();
  const runtime = new FakeRuntime({ scripts: { lead: lead(), builder: [script([{ report: report(['ok.txt']) }], [{ report: report(['ok.txt']) }]), script([{ report: report(['ok.txt']) }])] } });
  const result = await run(runtime, cwd, { verify: [NODE_OK] });
  assert.equal(result.status, 'needs_review');
});

// ---------- completion policy (ADR 0005) ----------

test('unverified items complete when G3 passes, and need review when there is no G3', async () => {
  const unverified = report(['ok.txt'], 'unverified', { unverified: ['browser rendering not checked'] });
  const withVerify = new FakeRuntime({ scripts: { lead: lead(), builder: [script([write('ok.txt'), { report: unverified }])] } });
  const done = await run(withVerify, tmp(), { verify: [NODE_OK] });
  assert.equal(done.status, 'completed', done.reason);
  assert.ok(done.unverified.some(item => item.includes('browser rendering')));
  assert.ok(done.unverified.some(item => item.includes('R1')));

  const without = new FakeRuntime({ scripts: { lead: lead(), builder: [script([write('ok.txt'), { report: unverified }])] } });
  const review = await run(without, tmp());
  assert.equal(review.status, 'needs_review');
  assert.match(review.reason, /no verify command/);
  assert.ok(review.warnings.some(item => item.includes('No automatic verification')));
});

test('changed test files are flagged for review; a new test file is not', async () => {
  const cwd = tmp();
  put(cwd, 'ok.test.js', 'assert.equal(a, 1)');
  const runtime = new FakeRuntime({ scripts: { lead: lead(), builder: [script([write('ok.txt'), write('ok.test.js'), { report: report(['ok.txt', 'ok.test.js']) }])] } });
  const result = await run(runtime, cwd, { verify: [NODE_OK] });
  assert.equal(result.status, 'completed');
  assert.ok(result.warnings.some(item => item.includes('ok.test.js')));
  const fresh = new FakeRuntime({ scripts: { lead: lead(), builder: [script([write('ok.txt'), write('new.test.js'), { report: report(['ok.txt', 'new.test.js']) }])] } });
  const added = await run(fresh, tmp(), { verify: [NODE_OK] });
  assert.equal(added.warnings.some(item => item.includes('new.test.js')), false);
});

test('with no verify command, the project\'s own test script is used; npm\'s placeholder is not', () => {
  const cwd = tmp();
  assert.deepEqual(detectVerify(cwd), []);
  put(cwd, 'package.json', JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.deepEqual(detectVerify(cwd), []);
  put(cwd, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  assert.deepEqual(detectVerify(cwd), ['npm test']);
  put(cwd, 'package.json', JSON.stringify({ scripts: { check: 'node scripts/harness-check.mjs', 'test:auth': 'node --test x' } }));
  assert.deepEqual(detectVerify(cwd), ['npm run check']);
});

// ---------- protected paths, read-only, failure types ----------

test('a builder that touches a protected path is stopped and the file restored', async () => {
  const cwd = tmp();
  put(cwd, '.agent-desk/config.json', 'orig');
  const runtime = new FakeRuntime({ scripts: { lead: lead(), builder: [script([write('ok.txt'), write('.agent-desk/config.json', 'weakened checks'), { report: report(['ok.txt', '.agent-desk/config.json']) }])] } });
  const result = await run(runtime, cwd);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /protected paths/);
  assert.equal(fs.readFileSync(path.join(cwd, '.agent-desk/config.json'), 'utf8'), 'orig');
});

test('a read-only step that changes files ends as needs_review', async () => {
  const runtime = new FakeRuntime({ scripts: { lead: [script([write('oops.txt'), { report: { workflow: 'answer', requirements: [], reason: 'q', answer: 'a', sources: [] } }])], builder: [] } });
  const result = await run(runtime, tmp());
  assert.equal(result.status, 'needs_review');
  assert.match(result.reason, /read-only/);
  assert.match(result.reason, /oops\.txt/);
});

test('a verify command that cannot run is an environment failure, not a REDO', async () => {
  const runtime = new FakeRuntime({ scripts: { lead: lead(), builder: [script([write('ok.txt'), { report: report(['ok.txt']) }])] } });
  const result = await run(runtime, tmp(), { verify: ['definitely-not-a-command-xyz'] });
  assert.equal(result.status, 'failed');
  assert.equal(result.failureType, 'environment');
  assert.equal(result.redo, 0);
});

test('failure types are classified', () => {
  assert.equal(classifyFailure('spawn EPERM'), 'environment');
  assert.equal(classifyFailure("'codex' is not recognized as an internal or external command"), 'environment');
  assert.equal(classifyFailure('read ECONNRESET'), 'transient');
  assert.equal(classifyFailure('Codex app-server exited (1)'), 'transient');
  assert.equal(classifyFailure('model refused'), 'other');
  assert.equal(classifyFailure("You've hit your usage limit. To get more access now, send a request to your admin or try again at Mar 20th, 2027 3:36 PM."), 'limit');
  assert.equal(classifyFailure('turn ended [usageLimitExceeded]'), 'limit');
  assert.equal(classifyFailure("You've hit your session limit · resets 3:45pm"), 'limit');
  assert.equal(classifyFailure("You've hit your weekly limit · resets Mon 12:00am"), 'limit');
  assert.equal(classifyFailure('API Error: Server is temporarily limiting requests (not your usage limit)'), 'transient');
  assert.equal(classifyFailure('API Error: Rate limit reached'), 'transient');
  assert.equal(classifyFailure('Failed to authenticate: OAuth session expired and could not be refreshed'), 'auth');
  assert.equal(classifyFailure('Not logged in · Please run /login'), 'auth');
  assert.equal(classifyFailure('Invalid API key · Fix external API key'), 'auth');
});

test('a transient runtime error is retried once per step in a fresh session', async () => {
  const answer = { workflow: 'answer', requirements: [], reason: 'q', answer: 'a', sources: [] };
  const ok = new FakeRuntime({ scripts: { lead: [script([{ fail: 'read ECONNRESET' }]), script([{ report: answer }])], builder: [] } });
  const events: RunEvent[] = [];
  const result = await runRequest('q', { cwd: tmp(), runtime: ok, onEvent: event => events.push(event) });
  assert.equal(result.status, 'completed');
  assert.ok(events.some(event => event.type === 'retry'));

  const twice = new FakeRuntime({ scripts: { lead: [script([{ fail: 'read ECONNRESET' }]), script([{ fail: 'read ECONNRESET' }])], builder: [] } });
  const failed = await runRequest('q', { cwd: tmp(), runtime: twice });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureType, 'transient');
});

// ---------- restore points ----------

import { createRestorePoint, revertToRestorePoint } from '#orchestrator';

test('restore point: copies files, reverts modified/deleted/created, respects limits and ignore', () => {
  const cwd = tmp();
  put(cwd, 'a.txt', 'one'); put(cwd, 'dir/b.txt', 'two'); put(cwd, 'node_modules/x.js', 'dep');
  const dir = path.join(tmp(), 'point');
  const made = createRestorePoint(cwd, dir, takeSnapshot(cwd));
  assert.ok(made.ok && made.files === 2);
  put(cwd, 'a.txt', 'CHANGED'); fs.rmSync(path.join(cwd, 'dir/b.txt')); put(cwd, 'c.txt', 'new'); put(cwd, 'node_modules/x.js', 'dep2');
  const plan = revertToRestorePoint(cwd, dir, { dryRun: true });
  assert.deepEqual(plan.restore, ['a.txt', 'dir/b.txt']);
  assert.deepEqual(plan.remove, ['c.txt']);
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'CHANGED');
  assert.ok(revertToRestorePoint(cwd, dir).applied);
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'one');
  assert.equal(fs.readFileSync(path.join(cwd, 'dir/b.txt'), 'utf8'), 'two');
  assert.ok(!fs.existsSync(path.join(cwd, 'c.txt')));
  assert.equal(fs.readFileSync(path.join(cwd, 'node_modules/x.js'), 'utf8'), 'dep2');
  const over = createRestorePoint(cwd, path.join(tmp(), 'p2'), takeSnapshot(cwd), { maxFiles: 1, maxBytes: 1000 });
  assert.equal(over.ok, false);
  assert.equal(revertToRestorePoint(cwd, path.join(tmp(), 'missing')).ok, false);
});

test('a run makes a restore point before the build; too large a project only warns', async () => {
  const cwd = tmp(); put(cwd, 'orig.txt', 'before');
  const dir = path.join(tmp(), 'rp');
  const runtime = new FakeRuntime({ scripts: { lead: lead(), builder: [script([write('ok.txt'), { writeFile: { path: 'orig.txt', content: 'after' } }, { report: report(['ok.txt', 'orig.txt']) }])] } });
  const result = await run(runtime, cwd, { restorePointDir: dir, verify: [NODE_OK] });
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.restorePoint?.files, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'files', 'orig.txt'), 'utf8'), 'before');
  const without = new FakeRuntime({ scripts: { lead: lead(), builder: [script([write('ok.txt'), { report: report(['ok.txt']) }])] } });
  assert.equal((await run(without, tmp(), { verify: [NODE_OK] })).restorePoint, undefined);
});

test('gate messages follow the run language', () => {
  const diff = { all: ['a.txt'], added: ['a.txt'], modified: [], deleted: [] } as never;
  const english = checkChangeReport({ attempt: 0, cwd: '/p', reported: [], diff, ignore: [] });
  const korean = checkChangeReport({ attempt: 0, cwd: '/p', reported: [], diff, ignore: [], language: 'ko' });
  assert.match(english.problems[0]!, /changed but were not in changedFiles/);
  assert.match(korean.problems[0]!, /changedFiles에 없습니다/);
  assert.match(checkBudget({ attempt: 0, budget: undefined, usage: { totalTokens: 0 } as never, elapsedMs: 0, language: 'ko' }).detail, /예산/);
});

test('a requirement may quote a project note named in "source"', async () => {
  const { requirementQuoteErrors } = await import('../src/evidence.ts');
  const notes: Record<string, string> = { 'specs/Login.md': 'Lock the account after 5 failed attempts.' };
  const noteText = (rel: string) => notes[rel] ?? null;
  assert.deepEqual(requirementQuoteErrors('build specs/Login', [{ id: 'R1', text: 'lock after 5 failures', quote: 'after 5 failed attempts', source: 'specs/Login.md' }], noteText), []);
  assert.match(requirementQuoteErrors('build specs/Login', [{ id: 'R1', text: 'x', quote: 'after 3 failed attempts', source: 'specs/Login.md' }], noteText)[0]!, /is not in specs\/Login\.md/);
  assert.match(requirementQuoteErrors('build it', [{ id: 'R1', text: 'x', quote: 'q', source: 'specs/None.md' }], noteText)[0]!, /is not a project note/);
  assert.match(requirementQuoteErrors('build it', [{ id: 'R1', text: 'x', quote: 'q', source: 'specs/Login.md' }])[0]!, /is not a project note/);
});
