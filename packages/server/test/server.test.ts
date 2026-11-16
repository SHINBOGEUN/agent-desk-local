import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FakeRuntime } from '#runtime-fake';
import type { FakeScript } from '#runtime-fake';
import { createServer, isBenchWorkspace } from '../src/index.ts';

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
    assert.equal(typeof (JSON.parse((await call(port, 'GET', '/api/state')).body) as { installed?: { codex: boolean } }).installed?.codex, 'boolean');
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
    assert.equal((await call(port, 'POST', '/api/runs', { token, body: { project, request: 'x', language: 'fr' } })).status, 400);
    assert.equal((await call(port, 'POST', '/api/runs', { token, body: { project, request: 'x', mode: 'gpt+claude' } })).status, 400);
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

test('serves the built dashboard: shell for app routes, assets by type, no path traversal, API untouched', async () => {
  const dist = tmp();
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>desk</title>');
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(path.dirname(dist), 'secret.txt'), 'nope');
  const home = tmp();
  const server = createServer({ env: { AGENT_DESK_HOME: home }, platform: 'linux', createRuntime: () => new FakeRuntime({ scripts: {} }), port: 0, staticDir: dist });
  const { port } = await server.listen();
  try {
    const root = await call(port, 'GET', '/');
    assert.equal(root.status, 200);
    assert.match(String(root.headers['content-type']), /text\/html/);
    assert.match(root.body, /<title>desk<\/title>/);
    assert.match(String(root.headers['content-security-policy']), /script-src 'self'/);
    assert.match((await call(port, 'GET', '/runs/12')).body, /<title>desk<\/title>/);
    const asset = await call(port, 'GET', '/assets/app.js');
    assert.match(String(asset.headers['content-type']), /javascript/);
    assert.equal((await call(port, 'GET', '/assets/missing.js')).status, 404);
    assert.equal((await call(port, 'GET', '/..%2fsecret.txt')).status, 404);
    assert.equal((await call(port, 'GET', '/%2e%2e/secret.txt')).status, 404);
    assert.equal((await call(port, 'GET', '/api/nothing')).status, 404);
    assert.equal((await call(port, 'GET', '/api/health')).status, 200);
  } finally { await server.close(); }
  const bare = createServer({ env: { AGENT_DESK_HOME: tmp() }, platform: 'linux', createRuntime: () => new FakeRuntime({ scripts: {} }), port: 0 });
  const started = await bare.listen();
  try { assert.equal((await call(started.port, 'GET', '/')).status, 404); } finally { await bare.close(); }
});

test('folder picker lists only subfolders, hides dot folders, rejects relative paths', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'app', 'package.json'), '{}');
  fs.mkdirSync(path.join(root, 'plain'));
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'file.txt'), 'x');
  const { server, port } = await start(new FakeRuntime({ scripts: {} }));
  try {
    const listed = JSON.parse((await call(port, 'GET', `/api/fs?path=${encodeURIComponent(root)}`)).body) as { entries: { name: string; isProject: boolean }[]; parent: string };
    assert.deepEqual(listed.entries.map(entry => [entry.name, entry.isProject]), [['app', true], ['plain', false]]);
    assert.equal(listed.parent, path.dirname(root));
    assert.equal((await call(port, 'GET', '/api/fs?path=relative')).status, 400);
    assert.equal((await call(port, 'GET', `/api/fs?path=${encodeURIComponent(path.join(root, 'missing'))}`)).status, 400);
    const roots = JSON.parse((await call(port, 'GET', '/api/fs')).body) as { entries: unknown[] };
    assert.ok(roots.entries.length >= 1);
  } finally { await server.close(); }
});

test('pick-folder needs the token and returns the chosen folder or a cancel', async () => {
  const chosen = tmp();
  let answer: { supported: boolean; path?: string | null } = { supported: true, path: chosen };
  const server = createServer({ env: { AGENT_DESK_HOME: tmp() }, platform: 'linux', createRuntime: () => new FakeRuntime({ scripts: {} }), port: 0, pickFolder: async () => answer as never });
  const { port, token } = await server.listen();
  try {
    assert.equal((await call(port, 'POST', '/api/pick-folder', { body: {} })).status, 403);
    assert.deepEqual(JSON.parse((await call(port, 'POST', '/api/pick-folder', { token, body: {} })).body), { supported: true, path: chosen });
    answer = { supported: true, path: null };
    assert.deepEqual(JSON.parse((await call(port, 'POST', '/api/pick-folder', { token, body: {} })).body), { supported: true, path: null });
    answer = { supported: false };
    assert.deepEqual(JSON.parse((await call(port, 'POST', '/api/pick-folder', { token, body: {} })).body), { supported: false });
  } finally { await server.close(); }
});

test('usage endpoint reports the Codex window, and says why when it cannot', async () => {
  const ok = createServer({ env: { AGENT_DESK_HOME: tmp() }, platform: 'linux', createRuntime: () => new FakeRuntime({ scripts: {} }), port: 0, readRateLimits: async () => ({ rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 2000000000 } } }) });
  const { port } = await ok.listen();
  try {
    const answer = JSON.parse((await call(port, 'GET', '/api/usage')).body) as { limits: { windows: { usedPercent: number }[] } | null };
    assert.equal(answer.limits?.windows[0]?.usedPercent, 40);
  } finally { await ok.close(); }
  const broken = createServer({ env: { AGENT_DESK_HOME: tmp() }, platform: 'linux', createRuntime: () => new FakeRuntime({ scripts: {} }), port: 0, readRateLimits: async () => { throw new Error('offline'); } });
  const second = await broken.listen();
  try {
    const answer = JSON.parse((await call(second.port, 'GET', '/api/usage')).body) as { limits: unknown; reason: string };
    assert.equal(answer.limits, null);
    assert.match(answer.reason, /offline/);
  } finally { await broken.close(); }
});

test('bench endpoint summarizes saved benchmark runs and skips environment failures', async () => {
  const runs = tmp();
  const label = path.join(runs, 'v2-x');
  fs.mkdirSync(label);
  const result = (taskId: string, success: boolean, tokens: number, extra: object = {}) => JSON.stringify({ taskId, claimedSuccess: true, grade: { success }, falseCompletion: !success, metrics: { usage: { totalTokens: tokens }, durationSec: 60, agentCount: 2 }, ...extra });
  fs.writeFileSync(path.join(label, 'T01-r1.json'), result('T01', true, 100));
  fs.writeFileSync(path.join(label, 'T01-r2.json'), result('T01', false, 300));
  fs.writeFileSync(path.join(label, 'T02-r1.json'), result('T02', true, 999, { cancelReason: 'blocked_on_approval' }));
  fs.writeFileSync(path.join(label, '_config.json'), JSON.stringify({ agents: [{ enabled: true }, { enabled: true }, { enabled: false }] }));
  const server = createServer({ env: { AGENT_DESK_HOME: tmp() }, platform: 'linux', createRuntime: () => new FakeRuntime({ scripts: {} }), port: 0, benchDir: runs });
  const { port } = await server.listen();
  try {
    const { summaries } = JSON.parse((await call(port, 'GET', '/api/bench')).body) as { summaries: { label: string; runs: number; excluded: number; successRate: number; meanTokens: number; enabledAgents: number; meanMinutes: number; perTask: Record<string, { success: number }> }[] };
    assert.equal(summaries.length, 1);
    const [summary] = summaries;
    assert.equal(summary!.runs, 2);
    assert.equal(summary!.excluded, 1);
    assert.equal(summary!.successRate, 0.5);
    assert.equal(summary!.meanTokens, 200);
    assert.equal(summary!.enabledAgents, 2);
    assert.equal(summary!.meanMinutes, 1);
    assert.equal(summary!.perTask.T01!.success, 1);
  } finally { await server.close(); }
  const empty = createServer({ env: { AGENT_DESK_HOME: tmp() }, platform: 'linux', createRuntime: () => new FakeRuntime({ scripts: {} }), port: 0 });
  const second = await empty.listen();
  try { assert.deepEqual(JSON.parse((await call(second.port, 'GET', '/api/bench')).body), { summaries: [] }); } finally { await empty.close(); }
});

test('history delete forgets one project or every benchmark workspace, never the files', async () => {
  const root = tmp();
  const bench = path.join(root, 'agent-desk-bench', 'v2-x', 'T01-r1-2026');
  const mine = path.join(root, 'mine');
  fs.mkdirSync(bench, { recursive: true }); fs.mkdirSync(mine);
  fs.writeFileSync(path.join(mine, 'keep.txt'), 'x');
  const { server, port, token } = await start(new FakeRuntime({ scripts: { lead: [script([{ report: answerReport }]), script([{ report: answerReport }])], builder: [] } }));
  try {
    for (const project of [bench, mine]) {
      const { runId } = JSON.parse((await call(port, 'POST', '/api/runs', { token, body: { project, request: 'Which port?', runtime: 'fake' } })).body) as { runId: number };
      await call(port, 'GET', `/api/runs/${runId}/events`);
    }
    assert.equal((await call(port, 'POST', '/api/history/delete', { token, body: {} })).status, 400);
    const benchOnly = JSON.parse((await call(port, 'POST', '/api/history/delete', { token, body: { benchWorkspaces: true } })).body) as { deleted: number };
    assert.equal(benchOnly.deleted, 1);
    const left = JSON.parse((await call(port, 'GET', '/api/runs')).body) as { runs: { project: string }[] };
    assert.deepEqual(left.runs.map(run => run.project), [mine]);
    const one = JSON.parse((await call(port, 'POST', '/api/history/delete', { token, body: { project: mine } })).body) as { deleted: number };
    assert.equal(one.deleted, 1);
    assert.ok(fs.existsSync(path.join(mine, 'keep.txt')));
    assert.equal(isBenchWorkspace('C:\\Users\\me\\AppData\\Local\\Temp\\agent-desk-bench\\v1-13\\T01-r1-x'), true);
    assert.equal(isBenchWorkspace('D:\\work\\agent-desk-local'), false);
  } finally { await server.close(); }
});

test('runs carry images, record their settings, can be resumed; project files and memory are edited through the API', async () => {
  const project = tmp();
  const { server, port, token, home } = await start(new FakeRuntime({ scripts: { lead: [script([{ report: answerReport }]), script([{ report: answerReport }])], builder: [] } }));
  try {
    const png = `data:image/png;base64,${Buffer.from('fake-png').toString('base64')}`;
    assert.equal((await call(port, 'POST', '/api/runs', { token, body: { project, request: 'x', runtime: 'fake', images: ['data:text/plain;base64,AAAA'] } })).status, 400);
    const first = JSON.parse((await call(port, 'POST', '/api/runs', { token, body: { project, request: 'Which port?', runtime: 'fake', images: [png] } })).body) as { runId: number };
    await call(port, 'GET', `/api/runs/${first.runId}/events`);
    const detail = JSON.parse((await call(port, 'GET', `/api/runs/${first.runId}`)).body) as { settings: { images: number; runtimes: Record<string, string> } };
    assert.equal(detail.settings.images, 1);
    assert.equal(detail.settings.runtimes.builder, 'fake');
    assert.ok(fs.readdirSync(path.join(home, 'attachments')).length === 1);
    const second = JSON.parse((await call(port, 'POST', '/api/runs', { token, body: { project, request: 'Which port?', runtime: 'fake', resumeOf: first.runId } })).body) as { runId: number };
    await call(port, 'GET', `/api/runs/${second.runId}/events`);
    const resumed = JSON.parse((await call(port, 'GET', `/api/runs/${second.runId}`)).body) as { settings: { resumeOf: number } };
    assert.equal(resumed.settings.resumeOf, first.runId);

    const files = JSON.parse((await call(port, 'GET', `/api/project/files?path=${encodeURIComponent(project)}`)).body) as { config: { exists: boolean }; roles: Record<string, { text: string }> };
    assert.equal(files.config.exists, false);
    const bad = await call(port, 'POST', '/api/project/files', { token, body: { project, kind: 'config', text: '{ "mode": 1 }' } });
    assert.equal(bad.status, 422);
    assert.match(JSON.parse(bad.body).error, /config\.mode/);
    assert.equal((await call(port, 'POST', '/api/project/files', { token, body: { project, kind: 'config', text: '{ "mode": "codex" }' } })).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(project, '.agent-desk', 'config.json'), 'utf8')).mode, 'codex');
    assert.equal((await call(port, 'POST', '/api/project/memory', { token, body: { project, fact: 'Port is 3000' } })).status, 200);
    assert.match(fs.readFileSync(path.join(project, '.agent-desk', 'memory.md'), 'utf8'), /Port is 3000/);
    const init = JSON.parse((await call(port, 'POST', '/api/project/init', { token, body: { project } })).body) as { written: string[] };
    assert.ok(init.written.includes('.agent-desk/agents/builder.md'));
    const usage = JSON.parse((await call(port, 'GET', '/api/usage')).body) as { claude: { last5h: number } };
    assert.equal(usage.claude.last5h, 0);
  } finally { await server.close(); }
});
