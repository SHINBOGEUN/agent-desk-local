import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReport, reportConsistencyErrors } from '#core';

const builder = {
  summary: '상태 필터 수정',
  changedFiles: ['src/app.mjs'],
  commandsRun: [{ command: 'npm test', exitCode: 0 }],
  requirements: [{ id: 'R1', status: 'done', evidence: 'test/app.test.mjs passes' }],
  unverified: [],
};

test('a well-formed builder report passes', () => {
  const result = validateReport('builder', builder);
  assert.equal(result.ok, true);
});

test('errors name the exact field to fix', () => {
  const result = validateReport('builder', { ...builder, requirements: [{ id: 'R1', status: 'finished', evidence: 'x' }], extra: 1 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some(error => error.startsWith('builder.requirements[0].status: expected one of done, not_done, unverified')), result.errors.join('\n'));
  assert.ok(result.errors.includes('builder.extra: unknown field'));
});

test('missing fields and wrong types are reported', () => {
  const result = validateReport('builder', { summary: '', changedFiles: 'src/app.mjs', commandsRun: [{ command: 'npm test', exitCode: 1.5 }] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.errors.sort(), [
    'builder.changedFiles: expected array, got string',
    'builder.commandsRun[0].exitCode: expected integer, got number',
    'builder.requirements: required',
    'builder.summary: must not be empty',
    'builder.unverified: required',
  ].sort());
  assert.equal(validateReport('builder', null).ok, false);
});

test('verifier report rules: PASS has no blocking findings, REDO needs one', () => {
  const pass = validateReport('verifier', { verdict: 'PASS', blocking: [], optional: ['이름을 더 명확하게'] });
  assert.equal(pass.ok, true);
  if (pass.ok) assert.deepEqual(reportConsistencyErrors('verifier', pass.value), []);

  const contradictory = validateReport('verifier', { verdict: 'PASS', blocking: [{ reason: '필터 누락', evidence: 'GET ?status=open returns []' }], optional: [] });
  assert.equal(contradictory.ok, true);
  if (contradictory.ok) assert.deepEqual(reportConsistencyErrors('verifier', contradictory.value), ['verifier.verdict: PASS cannot have blocking findings']);

  const emptyRedo = validateReport('verifier', { verdict: 'REDO', blocking: [], optional: [] });
  if (emptyRedo.ok) assert.deepEqual(reportConsistencyErrors('verifier', emptyRedo.value), ['verifier.blocking: REDO needs at least one blocking finding']);

  const located = validateReport('verifier', { verdict: 'REDO', blocking: [{ file: 'src/app.mjs', line: 42, reason: 'x', evidence: 'y' }], optional: [] });
  assert.equal(located.ok, true);
  assert.equal(validateReport('verifier', { verdict: 'REDO', blocking: [{ file: 'a', line: 'x', reason: 'x', evidence: 'y' }], optional: [] }).ok, false);
});

test('classification needs requirements for build workflows and unique ids', () => {
  const answer = validateReport('classify', { workflow: 'answer', requirements: [], reason: '질문' });
  assert.equal(answer.ok, true);
  if (answer.ok) assert.deepEqual(reportConsistencyErrors('classify', answer.value), []);

  const build = validateReport('classify', { workflow: 'build', requirements: [], reason: '변경' });
  if (build.ok) assert.deepEqual(reportConsistencyErrors('classify', build.value), ['classify.requirements: build workflows need at least one requirement']);

  const duplicated = validateReport('classify', { workflow: 'build', requirements: [{ id: 'R1', text: 'a' }, { id: 'R1', text: 'b' }], reason: 'x' });
  if (duplicated.ok) assert.deepEqual(reportConsistencyErrors('classify', duplicated.value), ['classify.requirements: ids must be unique']);

  assert.equal(validateReport('classify', { workflow: 'deploy', requirements: [], reason: 'x' }).ok, false);
});
