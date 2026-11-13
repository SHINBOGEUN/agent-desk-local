// Reproductions of the failures recorded for v1 (bench v1-13), run against
// scripted runtimes. Each test states the end state v2 must reach.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FakeRuntime } from '#runtime-fake';
import type { FakeScript } from '#runtime-fake';
import { runRequest } from '#orchestrator';
import type { RunConfig } from '#orchestrator';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v1fail-'));
const script = (...turns: FakeScript['turns']): FakeScript => ({ turns });
const VERIFY = `node -e "process.exit(require('fs').existsSync('ok.txt')?0:1)"`;
const classify = { workflow: 'build', requirements: [{ id: 'R1', text: 'create ok.txt' }], reason: 'one file' };
const report = (changedFiles: string[], extra: Record<string, unknown> = {}) => ({
  summary: 'created ok.txt', changedFiles, commandsRun: [{ command: 'node --test', exitCode: 0 }],
  requirements: [{ id: 'R1', status: 'done', evidence: 'ok.txt' }], unverified: [], ...extra,
});
const go = (runtime: FakeRuntime, cwd: string, config: Partial<RunConfig> = {}) => runRequest('create ok.txt', { cwd, runtime, review: 'never', ...config });
const builderTurns = (runtime: FakeRuntime) => runtime.turns.filter(turn => turn.role === 'builder');

test('false completion: "done, tests pass" with nothing changed never ends as completed', async () => {
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ report: classify }])], builder: [
    script([{ report: report(['ok.txt']) }], [{ report: report(['ok.txt']) }]),
    script([{ report: report(['ok.txt']) }]),
  ] } });
  const cwd = tmp();
  const result = await go(runtime, cwd, { verify: [VERIFY] });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.redo, 2);
  assert.ok(!fs.existsSync(path.join(cwd, 'ok.txt')));
});

test('false completion: a builder-reported passing test does not replace the harness verify result', async () => {
  const cwd = tmp();
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ report: classify }])], builder: [
    script([{ writeFile: { path: 'other.txt', content: 'x' } }, { report: report(['other.txt']) }], [{ report: report(['other.txt']) }]),
    script([{ report: report(['other.txt']) }]),
  ] } });
  const result = await go(runtime, cwd, { verify: [VERIFY] });
  assert.notEqual(result.status, 'completed');
  assert.ok(result.gates.some(gate => gate.gate === 'G3' && !gate.ok));
});

test('environment error: a missing tool stops at once with a failure type, no REDO', async () => {
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ report: classify }])], builder: [script([{ writeFile: { path: 'ok.txt', content: 'x' } }, { report: report(['ok.txt']) }])] } });
  const result = await go(runtime, tmp(), { verify: ['definitely-not-a-command-xyz'] });
  assert.equal(result.status, 'failed');
  assert.equal(result.failureType, 'environment');
  assert.equal(result.redo, 0);
  assert.equal(builderTurns(runtime).length, 1);
});

test('environment error: a runtime that cannot start is reported as failed with the cause', async () => {
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ fail: 'codex: command not found' }])], builder: [] } });
  const result = await go(runtime, tmp());
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /command not found/);
  assert.equal(builderTurns(runtime).length, 0);
});

test('REDO exceeded: two failed fixes end as needs_review with the failing gate named', async () => {
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ report: classify }])], builder: [
    script([{ writeFile: { path: 'a.txt', content: 'x' } }, { report: report(['a.txt']) }], [{ writeFile: { path: 'b.txt', content: 'x' } }, { report: report(['a.txt', 'b.txt']) }]),
    script([{ writeFile: { path: 'c.txt', content: 'x' } }, { report: report(['a.txt', 'b.txt', 'c.txt']) }]),
  ] } });
  const result = await go(runtime, tmp(), { verify: [VERIFY] });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.redo, 2);
  assert.match(result.reason, /Still failing after 2 redo/);
  assert.equal(runtime.remaining('builder'), 0);
});

test('false alarm (v1: 4 of 10 correct runs ended as needs-review): unverified claims plus a passing G3 complete', async () => {
  const unverified = report(['ok.txt'], { unverified: ['could not open a browser to look at it'] });
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ report: classify }])], builder: [script([{ writeFile: { path: 'ok.txt', content: 'x' } }, { report: unverified }])] } });
  const result = await go(runtime, tmp(), { verify: [VERIFY] });
  assert.equal(result.status, 'completed', result.reason);
  assert.ok(result.unverified.some(item => item.includes('browser')));
  assert.equal(result.redo, 0);
});

test('false alarm: a reviewer that cannot check something but gives a reason does not block a G3-passing run', async () => {
  const verdict = { verdict: 'BLOCKED', blocking: [{ reason: 'could not run the browser to check rendering', evidence: 'no display' }], optional: [] };
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ report: classify }])], builder: [script([{ writeFile: { path: 'ok.txt', content: 'x' } }, { report: report(['ok.txt']) }])], verifier: [script([{ report: verdict }])] } });
  const result = await runRequest('create ok.txt', { cwd: tmp(), runtime, verify: [VERIFY], review: 'always' });
  assert.equal(result.status, 'completed', result.reason);
  assert.ok(result.unverified.some(item => item.includes('browser')));
});
