import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FakeRuntime } from '#runtime-fake';
import type { FakeScript } from '#runtime-fake';
import { DEFAULT_AUTO_LIMITS, decideReview, renderDiff, runRequest, takeSnapshot, diffSnapshots } from '#orchestrator';
import type { ReviewFacts, RunConfig } from '#orchestrator';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
const script = (...turns: FakeScript['turns']): FakeScript => ({ turns });
const write = (file: string, content = 'x') => ({ writeFile: { path: file, content } });
const NODE_OK = `node -e "process.exit(0)"`;
const classify = { workflow: 'build', requirements: [{ id: 'R1', text: 'create feature.txt', quote: 'feature.txt' }], reason: 'one file' };
const builderReport = (changedFiles: string[], extra: Record<string, unknown> = {}) => ({ summary: 'SECRET-BUILDER-SUMMARY', changedFiles, commandsRun: [], requirements: [{ id: 'R1', status: 'done', evidence: 'file' }], unverified: [], ...extra });
const pass = { verdict: 'PASS', blocking: [], optional: ['rename later'] };
const redo = { verdict: 'REDO', blocking: [{ file: 'feature.txt', line: 1, reason: 'wrong content', evidence: 'expected "a"' }], optional: [] };

function setup(builder: FakeScript[], verifier: FakeScript[]) {
  return new FakeRuntime({ scripts: { lead: [script([{ report: classify }])], builder, verifier } });
}
const run = (runtime: FakeRuntime, config: Partial<RunConfig> = {}) => runRequest('make feature.txt say a', { cwd: tmp(), runtime, verify: [NODE_OK], ...config });

// ---------- policy ----------

const facts = (over: Partial<ReviewFacts> = {}): ReviewFacts => ({ policy: 'auto', verifySkipped: false, changedFiles: ['src/a.js'], changedLines: 10, linesUnknown: false, limits: DEFAULT_AUTO_LIMITS, ...over });

test('review policy decisions', () => {
  assert.equal(decideReview(facts({ policy: 'never' })).review, false);
  assert.equal(decideReview(facts({ policy: 'always', changedLines: 0 })).review, true);
  assert.equal(decideReview(facts()).review, false);
  assert.equal(decideReview(facts({ verifySkipped: true })).review, true);
  assert.match(decideReview(facts({ changedFiles: ['src/a.js', 'test/a.test.js'] })).reason, /test or check files/);
  assert.match(decideReview(facts({ changedFiles: ['src/auth.js'] })).reason, /security/);
  assert.match(decideReview(facts({ changedFiles: ['a', 'b', 'c', 'd'] })).reason, /4 files changed/);
  assert.match(decideReview(facts({ changedLines: 61 })).reason, /61 lines/);
  assert.equal(decideReview(facts({ changedLines: 60 })).review, false);
  assert.match(decideReview(facts({ linesUnknown: true })).reason, /could not be measured/);
  assert.equal(decideReview(facts({ policy: 'never', verifySkipped: true })).review, false);
});

test('diff rendering shows added, deleted and modified lines', () => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, 'm.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n');
  fs.writeFileSync(path.join(cwd, 'gone.txt'), 'bye\n');
  const before = takeSnapshot(cwd, { keepContent: true });
  fs.writeFileSync(path.join(cwd, 'm.txt'), 'one\ntwo\nthree\nFOUR\nfive\nsix\nseven\n');
  fs.rmSync(path.join(cwd, 'gone.txt'));
  fs.writeFileSync(path.join(cwd, 'new.txt'), 'a\nb\n');
  const diff = diffSnapshots(before, takeSnapshot(cwd));
  const rendered = renderDiff({ cwd, before, diff });
  assert.match(rendered.text, /added: new\.txt\n\+a\n\+b/);
  assert.match(rendered.text, /deleted: gone\.txt\n-bye/);
  assert.match(rendered.text, /modified: m\.txt[\s\S]*-four\n\+FOUR/);
  assert.equal(rendered.lines, 2 + 1 + 2);
  assert.equal(rendered.unknown, false);
});

// ---------- G4 in the run ----------

test('always: an independent read-only verifier session reviews and PASS completes', async () => {
  const runtime = setup([script([write('feature.txt', 'a'), { report: builderReport(['feature.txt']) }])], [script([{ report: pass }])]);
  const result = await run(runtime);
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.review?.verdict, 'PASS');
  const turn = runtime.turns.find(item => item.role === 'verifier')!;
  assert.equal(turn.options.access, 'read-only');
  assert.notEqual(turn.sessionId, runtime.turns.find(item => item.role === 'builder')!.sessionId);
  assert.match(turn.input.text, /R1: create feature\.txt/);
  assert.match(turn.input.text, /make feature\.txt say a/);
  assert.match(turn.input.text, /added: feature\.txt\n\+a/);
  assert.match(turn.input.text, /`node -e .*` passed/);
  assert.doesNotMatch(turn.input.text, /SECRET-BUILDER-SUMMARY/);
  assert.ok(result.gates.some(gate => gate.gate === 'G4' && gate.ok));
});

test('a REDO verdict sends the finding back to the builder, then a new verifier session passes', async () => {
  const runtime = setup(
    [script([write('feature.txt', 'b'), { report: builderReport(['feature.txt']) }], [write('feature.txt', 'a'), { report: builderReport(['feature.txt']) }])],
    [script([{ report: redo }]), script([{ report: pass }])],
  );
  const result = await run(runtime);
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.redo, 1);
  const builderTexts = runtime.turns.filter(turn => turn.role === 'builder').map(turn => turn.input.text);
  assert.match(builderTexts[1] ?? '', /Review: wrong content \(feature\.txt:1\)\. Evidence: expected "a"/);
  const verifierSessions = new Set(runtime.turns.filter(turn => turn.role === 'verifier').map(turn => turn.sessionId));
  assert.equal(verifierSessions.size, 2);
});

test('BLOCKED needs a reason; with passing verify it completes with a note, without verify it needs review', async () => {
  const blocked = { verdict: 'BLOCKED', blocking: [{ reason: 'could not run the browser', evidence: 'no display' }], optional: [] };
  const withVerify = setup([script([write('feature.txt', 'a'), { report: builderReport(['feature.txt']) }])], [script([{ report: { verdict: 'BLOCKED', blocking: [], optional: [] } }, { report: blocked }])]);
  const done = await run(withVerify);
  assert.equal(done.status, 'completed', done.reason);
  assert.deepEqual(withVerify.turns.find(turn => turn.role === 'verifier')?.toolResults.map(item => item.ok), [false, true]);
  assert.ok(done.unverified.some(item => item.includes('Review could not decide: could not run the browser')));

  const noVerify = setup([script([write('feature.txt', 'a'), { report: builderReport(['feature.txt']) }])], [script([{ report: blocked }])]);
  const review = await run(noVerify, { verify: [] });
  assert.equal(review.status, 'needs_review');
  assert.match(review.reason, /could not decide/);
});

test('never skips the review; auto skips only small verified changes', async () => {
  const small = () => [script([write('feature.txt', 'a'), { report: builderReport(['feature.txt']) }])];
  const never = setup(small(), []);
  const skipped = await run(never, { review: 'never' });
  assert.equal(skipped.status, 'completed');
  assert.match(skipped.reviewSkipped ?? '', /never/);
  assert.equal(never.turns.some(turn => turn.role === 'verifier'), false);

  const auto = setup(small(), []);
  const autoDone = await run(auto, { review: 'auto' });
  assert.equal(autoDone.status, 'completed');
  assert.match(autoDone.reviewSkipped ?? '', /small change/);

  const withTests = setup([script([write('feature.txt', 'a'), write('feature.test.js', 'assert'), { report: builderReport(['feature.txt', 'feature.test.js']) }])], [script([{ report: pass }])]);
  const reviewed = await run(withTests, { review: 'auto' });
  assert.equal(reviewed.status, 'completed');
  assert.equal(reviewed.review?.verdict, 'PASS');
  const text = withTests.turns.find(turn => turn.role === 'verifier')!.input.text;
  assert.match(text, /weakens a check/);
  assert.ok(reviewed.warnings.some(item => item.includes('feature.test.js')));

  const noVerify = setup(small(), [script([{ report: pass }])]);
  const forced = await run(noVerify, { review: 'auto', verify: [] });
  assert.equal(forced.review?.verdict, 'PASS');
});

test('a verifier that changes files or fails to report ends the run for review', async () => {
  const builder = () => [script([write('feature.txt', 'a'), { report: builderReport(['feature.txt']) }])];
  const changed = await run(setup(builder(), [script([write('sneaky.txt'), { report: pass }])]));
  assert.equal(changed.status, 'needs_review');
  assert.match(changed.reason, /read-only.*sneaky\.txt/);

  const silent = await run(setup(builder(), [script([{ message: 'hmm' }], [{ message: 'still hmm' }])]));
  assert.equal(silent.status, 'needs_review');
  assert.match(silent.reason, /did not produce a verdict/);
});

test('the verifier can run on a different runtime than the builder', async () => {
  const lead = new FakeRuntime({ scripts: { lead: [script([{ report: classify }])] } });
  const builder = new FakeRuntime({ scripts: { builder: [script([write('feature.txt', 'a'), { report: builderReport(['feature.txt']) }])] } });
  const verifier = new FakeRuntime({ scripts: { verifier: [script([{ report: pass }])] } });
  const result = await run(lead, { runtime: { lead, builder, verifier } });
  assert.equal(result.status, 'completed');
  assert.equal(verifier.turns.length, 1);
});

test('self: the builder checks its own work in the same session, no verifier session opens', async () => {
  const runtime = setup([script([write('feature.txt', 'a'), { report: builderReport(['feature.txt']) }], [{ report: pass }])], []);
  const result = await run(runtime, { review: 'self' });
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.review?.verdict, 'PASS');
  const builderTurns = runtime.turns.filter(item => item.role === 'builder');
  assert.equal(builderTurns.length, 2);
  assert.equal(builderTurns[0]!.sessionId, builderTurns[1]!.sessionId);
  assert.match(builderTurns[1]!.input.text, /check your OWN work/);
  assert.equal(runtime.turns.some(item => item.role === 'verifier'), false);
  assert.ok(result.events.some(event => event.type === 'step_started' && event.step === 'review' && event.role === 'builder'));
});

test('attached images go with the first prompt of each step that reads the request, not the review', async () => {
  const runtime = setup([script([write('feature.txt', 'a'), { report: builderReport(['feature.txt']) }])], [script([{ report: pass }])]);
  const result = await run(runtime, { images: ['/tmp/shot.png'] });
  assert.equal(result.status, 'completed', result.reason);
  assert.deepEqual(runtime.turns.find(item => item.role === 'lead')!.input.images, ['/tmp/shot.png']);
  assert.deepEqual(runtime.turns.find(item => item.role === 'builder')!.input.images, ['/tmp/shot.png']);
  assert.equal(runtime.turns.find(item => item.role === 'verifier')!.input.images, undefined);
});
