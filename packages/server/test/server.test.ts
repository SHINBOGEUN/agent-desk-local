import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FakeRuntime } from '#runtime-fake';
import type { FakeScript } from '#runtime-fake';
import { createServer } from '../src/index.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'srv-'));
const script = (...turns: FakeScript['turns']): FakeScript => ({ turns });
const answerReport = { workflow: 'answer', requirements: [], reason: 'plain question', answer: 'It listens on 3000.', sources: ['server.js'] };

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }
function call(port: number, method: string, url: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...(opts.token ? { 'X-Agent-Desk-Token': opts.token } : {}), ...opts.headers } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const waitFor = async (check: () => Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('timed out');
};

async function start(runtime: FakeRuntime) {
  const home = tmp();
  const server = createServer({ env: { AGENT_DESK_HOME: home }, platform: 'linux', createRuntime: () => runtime, port: 0, pollMs: 30 });
  const { port, token } = await server.listen();
  return { server, port, token, home };
}

test('security: headers, Host and Origin checks, CSRF token required for POST', async () => {
  const { server, port, token } = await start(new FakeRuntime({ scripts: {} }));
  try {
    const health = await call(port, 'GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.headers['x-content-type-options'], 'nosniff');
    assert.equal(health.headers['referrer-policy'], 'no-referrer');
    assert.match(String(health.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.equal((await call(port, 'GET', '/api/health', { headers: { Host: 'evil.example' } })).status, 403);
    assert.equal((await call(port, 'GET', '/api/health', { headers: { Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await call(port, 'POST', '/api/runs', { body: { project: '/x', request: 'hi' } })).status, 403);
    assert.equal((await call(port, 'POST', '/api/runs', { token: 'wrong', body: { project: '/x', request: 'hi' } })).status, 403);
    const state = JSON.parse((await call(port, 'GET', '/api/state')).body) as { csrf: string };
    assert.equal(state.csrf, token);
  } finally { await server.close(); }
});

test('starts a run, streams its events over SSE, and lists it', async () => {
  const project = tmp();
  const { server, port, token } = await start(new FakeRuntime({ scripts: { lead: [script([{ report: answerReport }])], builder: [] } }));
  try {
    const started = await call(port, 'POST', '/api/runs', { token, body: { project, request: 'Which port?', runtime: 'fake' } });
    assert.equal(started.status, 202);
    const { runId } = JSON.parse(started.body) as { runId: number };
    const stream = await call(port, 'GET', `/api/runs/${runId}/events`);
    assert.equal(stream.status, 200);
    assert.match(String(stream.headers['content-type']), /text\/event-stream/);
    assert.match(stream.body, /event: run-event/);
    assert.match(stream.body, /event: done\ndata: {"status":"completed"}/);
    const detail = JSON.parse((await call(port, 'GET', `/api/runs/${runId}`)).body) as { run: { status: string } };
    assert.equal(detail.run.status, 'completed');
    const list = JSON.parse((await call(port, 'GET', `/api/runs?project=${encodeURIComponent(project)}`)).body) as { runs: unknown[] };
    assert.equal(list.runs.length, 1);
    const after = await call(port, 'GET', `/api/runs/${runId}/events?afterSeq=999999`);
    assert.doesNotMatch(after.body, /event: run-event/);
  } finally { await server.close(); }
});

test('bad start requests are rejected; a second run while one is active gets 409', async () => {
  const project = tmp();
  const { server, port, token } = await start(new FakeRuntime({ scripts: { lead: [script([{ ask: { question: 'Which database?', options: ['sqlite', 'pg'] } }])], builder: [] } }));
  try {
    assert.equal((await call(port, 'POST', '/api/runs', { token, body: { project: 'relative', request: 'x' } })).status, 400);
    assert.equal((await call(port, 'POST', '/api/runs', { token, body: { project, request: '  ' } })).status, 400);
    assert.equal((await call(port, 'POST', '/api/runs', { token, body: { project, request: 'x', review: 'sometimes' } })).status, 400);
    assert.equal((await call(port, 'POST', '/api/runs', { token, body: { project: path.join(project, 'missing'), request: 'x', runtime: 'fake' } })).status, 400);
    const started = await call(port, 'POST', '/api/runs', { token, body: { project, request: 'Add storage', runtime: 'fake' } });
    assert.equal(started.status, 202);
    assert.equal((await call(port, 'POST', '/api/runs', { token, body: { project, request: 'again', runtime: 'fake' } })).status, 409);
    await waitFor(async () => (JSON.parse((await call(port, 'GET', '/api/state')).body) as { active: { pending: unknown } | null }).active?.pending != null);
    const state = JSON.parse((await call(port, 'GET', '/api/state')).body) as { active: { pending: { question: string; options: string[] } } };
    assert.equal(state.active.pending.question, 'Which database?');
    assert.deepEqual(state.active.pending.options, ['sqlite', 'pg']);
    assert.equal((await call(port, 'POST', '/api/runs/active/answer', { token, body: { answer: 3 } })).status, 400);
    assert.equal((await call(port, 'POST', '/api/runs/active/cancel', { token, body: {} })).status, 202);
    await waitFor(async () => (JSON.parse((await call(port, 'GET', '/api/state')).body) as { active: unknown }).active === null);
    assert.equal((await call(port, 'POST', '/api/runs/active/cancel', { token, body: {} })).status, 409);
  } finally { await server.close(); }
});

test('an answered question lets the run continue', async () => {
  const project = tmp();
  const runtime = new FakeRuntime({ scripts: { lead: [script([{ ask: { question: 'Which port?' } }, { report: answerReport }])], builder: [] } });
  const { server, port, token } = await start(runtime);
  try {
    const { runId } = JSON.parse((await call(port, 'POST', '/api/runs', { token, body: { project, request: 'Which port?', runtime: 'fake' } })).body) as { runId: number };
    await waitFor(async () => (JSON.parse((await call(port, 'GET', '/api/state')).body) as { active: { pending: unknown } | null }).active?.pending != null);
    assert.equal((await call(port, 'POST', '/api/runs/active/answer', { token, body: { answer: '3000' } })).status, 200);
    const stream = await call(port, 'GET', `/api/runs/${runId}/events`);
    assert.match(stream.body, /event: done/);
    assert.deepEqual(runtime.turns.flatMap(turn => turn.answers), ['3000']);
  } finally { await server.close(); }
});

test('unknown runs and routes are 404, project info reports config problems and memory', async () => {
  const project = tmp();
  fs.mkdirSync(path.join(project, '.agent-desk'));
  fs.writeFileSync(path.join(project, '.agent-desk', 'memory.md'), '- tests use node:test\n');
  const { server, port } = await start(new FakeRuntime({ scripts: {} }));
  try {
    assert.equal((await call(port, 'GET', '/api/runs/99')).status, 404);
    assert.equal((await call(port, 'GET', '/api/runs/99/events')).status, 404);
    assert.equal((await call(port, 'GET', '/api/nothing')).status, 404);
    assert.equal((await call(port, 'GET', '/api/project?path=relative')).status, 400);
    const info = JSON.parse((await call(port, 'GET', `/api/project?path=${encodeURIComponent(project)}`)).body) as { memory: string[]; errors: string[] };
    assert.deepEqual(info.memory, ['tests use node:test']);
    assert.ok(Array.isArray(info.errors));
  } finally { await server.close(); }
});
