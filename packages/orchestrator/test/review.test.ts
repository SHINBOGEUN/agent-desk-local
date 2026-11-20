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

// ---------- finding checks (ADR 0012) ----------

import { findingLocationErrors, staleFindingErrors } from '../src/evidence.ts';

test('verifier findings must cite real files and lines, and REDO without a file must name a requirement', () => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, 'a.js'), 'one\ntwo\n');
  const ctx = { deleted: ['gone.js'], requirementIds: ['R1', 'R2'] };
  const at = (finding: Record<string, unknown>, verdict = 'REDO') => findingLocationErrors(cwd, { verdict, blocking: [{ reason: 'x', evidence: 'y', ...finding }] }, ctx);
  assert.deepEqual(at({ file: 'a.js', line: 2 }), []);
  assert.deepEqual(at({ file: './a.js:2' }), []);
  assert.deepEqual(at({ file: 'gone.js', line: 40 }), []);
  assert.match(at({ file: 'missing.js' })[0] ?? '', /not a file in the project/);
  assert.match(at({ file: 'a.js', line: 9 })[0] ?? '', /outside "a\.js" \(3 lines\)/);
  assert.match(at({ file: '../outside.js' })[0] ?? '', /not a file in the project/);
  assert.match(at({})[0] ?? '', /needs a "file"/);
  assert.deepEqual(at({ reason: 'R2 is not met' }), []);
  assert.deepEqual(at({ reason: 'the request asks for a button' }), []);
  assert.deepEqual(at({}, 'BLOCKED'), []);
  assert.match(at({ reason: 'R10 missing' })[0] ?? '', /needs a "file"/);
});

test('a re-review may only block on earlier findings or files changed since', () => {
  const ctx = { changedSince: ['b.js'], earlierFiles: ['a.js'] };
  assert.deepEqual(staleFindingErrors([{ file: 'a.js' }, { file: './b.js:3' }, {}], ctx), []);
  assert.match(staleFindingErrors([{ file: 'c.js' }], ctx)[0] ?? '', /has not changed since your last review/);
});

test('a made-up finding location is rejected and corrected in the same verifier turn', async () => {
  const fake = { verdict: 'REDO', blocking: [{ file: 'nowhere.txt', line: 3, reason: 'bug', evidence: 'saw it' }], optional: [] };
  const runtime = setup([script([write('feature.txt', 'a'), { report: builderReport(['feature.txt']) }])], [script([{ report: fake }, { report: pass }])]);
  const result = await run(runtime);
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.redo, 0);
  const results = runtime.turns.find(turn => turn.role === 'verifier')?.toolResults ?? [];
  assert.deepEqual(results.map(item => item.ok), [false, true]);
  assert.match(results[0]?.message ?? '', /"nowhere\.txt" is not a file in the project/);
});

test('after a REDO the re-review gets the earlier findings and only the diff since then', async () => {
  const runtime = setup(
    [script([write('feature.txt', 'b'), write('other.txt', 'untouched'), { report: builderReport(['feature.txt', 'other.txt']) }], [write('feature.txt', 'a'), { report: builderReport(['feature.txt', 'other.txt']) }])],
    [script([{ report: redo }]), script([{ report: { verdict: 'REDO', blocking: [{ file: 'other.txt', reason: 'new idea', evidence: 'saw it' }], optional: [] } }, { report: pass }])],
  );
  const result = await run(runtime);
  assert.equal(result.status, 'completed', result.reason);
  const second = runtime.turns.filter(turn => turn.role === 'verifier')[1]!;
  assert.match(second.input.text, /re-review after a redo/);
  assert.match(second.input.text, /1\. wrong content \(feature\.txt:1\)/);
  assert.match(second.input.text, /Files changed since that review: feature\.txt/);
  assert.match(second.input.text, /modified: feature\.txt[\s\S]*-b\n\+a/);
  assert.doesNotMatch(second.input.text, /untouched/);
  assert.match(second.toolResults[0]?.message ?? '', /"other\.txt" has not changed since your last review/);
});

test('once a report is accepted the harness ends the turn instead of waiting for the model to finish talking', async () => {
  // "hang" stands for the model's closing call after the report: without the stop the run would never end.
  const runtime = setup([script([write('feature.txt', 'a'), { report: builderReport(['feature.txt']) }, { hang: true }])], [script([{ report: pass }, { hang: true }])]);
  const result = await run(runtime);
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.review?.verdict, 'PASS');
});

test('a rejected report does not end the turn, so the model can fix it in the same turn', async () => {
  const fake = { verdict: 'REDO', blocking: [{ file: 'nowhere.txt', reason: 'bug', evidence: 'saw it' }], optional: [] };
  const runtime = setup([script([write('feature.txt', 'a'), { report: builderReport(['feature.txt']) }])], [script([{ report: fake }, { report: pass }, { hang: true }])]);
  const result = await run(runtime);
  assert.equal(result.status, 'completed', result.reason);
  assert.deepEqual(runtime.turns.find(turn => turn.role === 'verifier')?.toolResults.map(item => item.ok), [false, true]);
});

// ---------- project history ----------

import { projectHistory } from '#orchestrator';

test('project history: latest runs in full, older ones one line each, under the cap', () => {
  const brief = (n: number) => `요청: 요청 ${n}\n결과: completed — 완료 ${n}\n처리: build\n변경 파일: src/f${n}.js`;
  const runs = Array.from({ length: 40 }, (_, i) => ({ id: 40 - i, startedAt: `2026-11-${String(10 + (i % 9)).padStart(2, '0')}T00:00:00Z`, brief: brief(40 - i) }));
  const text = projectHistory(runs);
  assert.ok(text.length <= 2000 + 80, String(text.length));
  assert.match(text, /^#40 2026-11-10\n요청: 요청 40\n결과: completed — 완료 40\n처리: build\n변경 파일: src\/f40\.js/);
  assert.match(text, /\n- #38 \S+ 요청 38 → completed \(변경: src\/f38\.js\)/);
  assert.match(text, /older run\(s\) not shown; use read_history/);
  assert.equal(projectHistory([]), '');
  assert.doesNotMatch(projectHistory(runs.slice(0, 3)), /not shown/);
});

test('the lead and the builder get the history, the verifier does not; read_history reaches the harness', async () => {
  const queries: unknown[] = [];
  const runtime = setup([script([{ history: { search: 'login' } }, write('feature.txt', 'a'), { report: builderReport(['feature.txt']) }])], [script([{ report: pass }])]);
  const result = await run(runtime, { projectHistory: '#3 2026-11-18\n요청: 로그인 버튼 추가', readHistory: query => { queries.push(query); return 'run #3 details'; } });
  assert.equal(result.status, 'completed', result.reason);
  const instructions = (role: string) => runtime.turns.find(turn => turn.role === role)?.options.instructions ?? '';
  assert.match(instructions('lead'), /Earlier runs in this project[\s\S]*로그인 버튼 추가/);
  assert.match(instructions('builder'), /로그인 버튼 추가/);
  assert.doesNotMatch(instructions('verifier'), /로그인 버튼 추가/);
  assert.deepEqual(queries, [{ search: 'login' }]);
  assert.deepEqual(runtime.turns.find(turn => turn.role === 'builder')?.answers, ['run #3 details']);
  assert.ok(result.events.some(event => event.type === 'runtime' && event.event.type === 'tool' && event.event.name === 'read_history:login'));
});

test('after a REDO the result keeps each attempt and why it was sent back', async () => {
  const runtime = setup(
    [script([write('feature.txt', 'b'), { report: builderReport(['feature.txt'], { summary: 'first try' }) }], [write('feature.txt', 'a'), { report: builderReport(['feature.txt'], { summary: 'checked, nothing more to change' }) }])],
    [script([{ report: redo }]), script([{ report: pass }])],
  );
  const result = await run(runtime);
  assert.equal(result.status, 'completed', result.reason);
  assert.deepEqual(result.attempts?.map(entry => [entry.attempt, entry.summary, entry.sentBackFor.length]), [[1, 'first try', 1], [2, 'checked, nothing more to change', 0]]);
  assert.match(result.attempts?.[0]?.sentBackFor[0] ?? '', /Review: wrong content \(feature\.txt:1\)/);
  const single = await run(setup([script([write('feature.txt', 'a'), { report: builderReport(['feature.txt']) }])], [script([{ report: pass }])]));
  assert.equal(single.attempts, undefined);
});

test('a decision stated in a question is offered for the project memory by the lead', async () => {
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ report: { workflow: 'answer', requirements: [], reason: 'a rule, nothing to change', answer: '알겠습니다.', sources: [], memorySuggestions: ['결제는 토스를 쓴다 (수수료 때문에 사용자가 정함)'] } }])] } });
  const result = await runRequest('앞으로 결제는 토스로 하자, 수수료가 싸서', { cwd: tmp(), runtime });
  assert.equal(result.status, 'completed', result.reason);
  assert.deepEqual(result.memorySuggestions, ['결제는 토스를 쓴다 (수수료 때문에 사용자가 정함)']);
  const bad = new FakeRuntime({ scripts: { lead: [script([{ report: { workflow: 'answer', requirements: [], reason: 'r', answer: 'a', sources: [], memorySuggestions: 'not a list' } }, { report: { workflow: 'answer', requirements: [], reason: 'r', answer: 'a', sources: [] } }])] } });
  const fixed = await runRequest('hi', { cwd: tmp(), runtime: bad });
  assert.equal(fixed.status, 'completed');
  assert.match(bad.turns[0]?.toolResults[0]?.message ?? '', /memorySuggestions: up to 5/);
});

test('the model each role ran on is recorded', async () => {
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ model: 'gpt-lead' }, { report: classify }])], builder: [script([{ model: 'gpt-build' }, write('feature.txt', 'a'), { report: builderReport(['feature.txt']) }])], verifier: [script([{ model: 'claude-review' }, { report: pass }])] } });
  const result = await run(runtime);
  assert.deepEqual(result.modelsUsed, { lead: 'gpt-lead', builder: 'gpt-build', verifier: 'claude-review' });
});

test('text lost to a wrong encoding is sent back before the review; "??" in code is not', async () => {
  const runtime = setup(
    [script([write('feature.txt', 'a'), write('page.html', '<label>??? <input></label>'), write('code.js', 'const v = a ?? b;'), { report: builderReport(['code.js', 'feature.txt', 'page.html']) },
      write('page.html', '<label>마감일 <input></label>'), { report: builderReport(['code.js', 'feature.txt', 'page.html']) }])],
    [script([{ report: pass }])],
  );
  const result = await run(runtime);
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.redo, 0);
  const results = runtime.turns.find(turn => turn.role === 'builder')?.toolResults ?? [];
  assert.deepEqual(results.map(item => item.ok), [false, true]);
  assert.match(results[0]?.message ?? '', /page\.html:1: a line you wrote contains "\?\?\?"/);
  assert.doesNotMatch(results[0]?.message ?? '', /code\.js/);
});

test('a rule stated together with a change is still offered for memory, merged with the builder\'s suggestions', async () => {
  const runtime = new FakeRuntime({ scripts: {
    lead: [script([{ report: { ...classify, memorySuggestions: ['Dates are written as YYYY-MM-DD (the user asked)'] } }])],
    builder: [script([write('feature.txt', 'a'), { report: builderReport(['feature.txt'], { memorySuggestions: ['Tests run with node --test'] }) }])],
    verifier: [script([{ report: pass }])],
  } });
  const result = await run(runtime);
  assert.equal(result.status, 'completed', result.reason);
  assert.deepEqual(result.memorySuggestions, ['Dates are written as YYYY-MM-DD (the user asked)', 'Tests run with node --test']);
});
