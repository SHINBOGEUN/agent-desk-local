// Local HTTP + SSE server for the dashboard. Same security stance as v1:
// loopback only, Host/Origin checks, a per-start CSRF token on every POST,
// strict response headers, secrets masked in anything shown. One run at a time.

import fs from 'node:fs';
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Runtime, UserQuestion } from '#core';
import { revertToRestorePoint } from '#orchestrator';
import type { ReviewPolicy } from '#orchestrator';
import { loadMemory, loadProject, memoryFacts } from '#project';
import type { RuntimeKind } from '#project';
import { dataDirectory, executeRun } from '#service';
import { RunStore, redactSecrets } from '#store';

export interface ServerOptions {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  createRuntime(kind: RuntimeKind, command?: string): Runtime;
  /** 0 picks a free port (tests). */
  port?: number;
  /** How often SSE streams look for new events. */
  pollMs?: number;
  /** Folder with the built dashboard (index.html and assets). Omitted: only the API is served. */
  staticDir?: string;
}

interface ActiveRun {
  runId: number;
  project: string;
  request: string;
  controller: AbortController;
  pending: { question: UserQuestion; resolve(answer: string): void } | null;
}

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const REVIEWS = new Set(['always', 'auto', 'never']);
const RUNTIMES = new Set(['codex', 'claude', 'fake']);
const MAX_BODY = 256 * 1024;
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8' };

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface LocalServer {
  listen(): Promise<{ port: number; token: string }>;
  close(): Promise<void>;
  readonly token: string;
}

export function createServer(options: ServerOptions): LocalServer {
  const token = randomBytes(32).toString('hex');
  const dir = dataDirectory(options.env, options.platform);
  const dbFile = path.join(dir, 'agent-desk.db');
  const pollMs = options.pollMs ?? 400;
  let active: ActiveRun | null = null;
  let host = '';
  let origin = '';
  const streams = new Set<http.ServerResponse>();

  const withStore = <T>(fn: (store: RunStore) => T): T => {
    fs.mkdirSync(dir, { recursive: true });
    const store = new RunStore(dbFile);
    try { return fn(store); } finally { store.close(); }
  };
  const send = (res: http.ServerResponse, status: number, data: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  const tokenOk = (given: string | string[] | undefined): boolean => {
    if (typeof given !== 'string' || given.length !== token.length) return false;
    return timingSafeEqual(Buffer.from(given), Buffer.from(token));
  };
  const readBody = async (req: http.IncomingMessage): Promise<Record<string, unknown>> => {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'JSON body required');
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new HttpError(413, 'request too large');
      chunks.push(chunk as Buffer);
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch { throw new HttpError(400, 'invalid JSON'); }
  };
  const pendingView = () => active?.pending ? { question: redactSecrets(active.pending.question.question), ...(active.pending.question.options ? { options: active.pending.question.options } : {}) } : null;
  const activeView = () => active ? { runId: active.runId, project: active.project, request: redactSecrets(active.request), pending: pendingView() } : null;

  function startRun(body: Record<string, unknown>): Promise<number> {
    if (active) throw new HttpError(409, `run ${active.runId} is still active`);
    const project = typeof body.project === 'string' ? body.project : '';
    const request = typeof body.request === 'string' ? body.request : '';
    if (!path.isAbsolute(project)) throw new HttpError(400, 'project must be an absolute path');
    if (!request.trim()) throw new HttpError(400, 'request is empty');
    const runtime = body.runtime;
    if (runtime !== undefined && !(typeof runtime === 'string' && RUNTIMES.has(runtime))) throw new HttpError(400, 'unknown runtime');
    const review = body.review;
    if (review !== undefined && !(typeof review === 'string' && REVIEWS.has(review))) throw new HttpError(400, 'review must be always, auto or never');
    const verify = Array.isArray(body.verify) ? body.verify.filter((item): item is string => typeof item === 'string') : [];
    const controller = new AbortController();
    const ask = (question: UserQuestion): Promise<string> => new Promise(resolve => {
      const done = (answer: string): void => { if (active) active.pending = null; resolve(answer); };
      if (controller.signal.aborted) return done('');
      controller.signal.addEventListener('abort', () => done(''), { once: true });
      if (active) active.pending = { question, resolve: done };
    });
    return new Promise<number>((resolveId, rejectId) => {
      let started = false;
      executeRun({
        project, request, env: options.env, platform: options.platform, createRuntime: options.createRuntime,
        ...(runtime ? { runtime: runtime as RuntimeKind } : {}),
        ...(review ? { review: review as ReviewPolicy } : {}),
        verify, ask, signal: controller.signal,
        onStarted: ({ runId }) => { started = true; active = { runId, project, request, controller, pending: null }; resolveId(runId); },
      }).then(outcome => {
        if (!outcome.ok && !started) rejectId(new HttpError(outcome.code === 64 ? 400 : 500, outcome.message));
      }).catch(error => {
        if (!started) rejectId(error as Error);
      }).finally(() => { active = null; });
    });
  }

  function streamEvents(req: http.IncomingMessage, res: http.ServerResponse, runId: number, url: URL): void {
    const header = req.headers['last-event-id'];
    let last = Number(url.searchParams.get('afterSeq') ?? (typeof header === 'string' ? header : 0)) || 0;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    streams.add(res);
    let lastPending = '';
    const tick = (): void => {
      try {
        const { events, status } = withStore(store => ({ events: store.events(runId, last), status: store.getRun(runId)?.status ?? 'missing' }));
        for (const stored of events) { res.write(`id: ${stored.seq}\nevent: run-event\ndata: ${JSON.stringify(stored)}\n\n`); last = stored.seq; }
        const pending = JSON.stringify(active?.runId === runId ? pendingView() : null);
        if (pending !== lastPending) { lastPending = pending; res.write(`event: pending\ndata: ${pending}\n\n`); }
        if (status !== 'running' && !events.length) { res.write(`event: done\ndata: ${JSON.stringify({ status })}\n\n`); cleanup(); res.end(); }
      } catch { cleanup(); res.end(); }
    };
    const timer = setInterval(tick, pollMs);
    const cleanup = (): void => { clearInterval(timer); streams.delete(res); };
    req.on('close', cleanup);
    tick();
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const p = url.pathname;
    if (method === 'POST' && !tokenOk(req.headers['x-agent-desk-token'])) throw new HttpError(403, 'reload the page and try again');
    if (method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, activeRunId: active?.runId ?? null, pid: process.pid });
    if (method === 'GET' && p === '/api/state') return send(res, 200, { csrf: token, active: activeView() });
    if (method === 'GET' && p === '/api/runs') {
      const project = url.searchParams.get('project') ?? undefined;
      return send(res, 200, { runs: withStore(store => store.listRuns(project, 100)).map(run => ({ ...run, request: redactSecrets(run.request), brief: run.brief ? redactSecrets(run.brief) : null })) });
    }
    const runMatch = /^\/api\/runs\/(\d+)(?:\/(events|revert))?$/.exec(p);
    if (runMatch) {
      const runId = Number(runMatch[1]);
      const sub = runMatch[2];
      if (method === 'GET' && !sub) {
        const detail = withStore(store => { const run = store.getRun(runId); return run ? { run, steps: store.steps(runId), usage: store.usage(runId), usageTotal: store.usageTotal(runId) } : null; });
        if (!detail) throw new HttpError(404, 'run not found');
        return send(res, 200, { ...detail, run: { ...detail.run, request: redactSecrets(detail.run.request), brief: detail.run.brief ? redactSecrets(detail.run.brief) : null } });
      }
      if (method === 'GET' && sub === 'events') {
        if (!withStore(store => store.getRun(runId))) throw new HttpError(404, 'run not found');
        return streamEvents(req, res, runId, url);
      }
      if (method === 'POST' && sub === 'revert') {
        const body = await readBody(req);
        const row = withStore(store => store.getRun(runId));
        if (!row) throw new HttpError(404, 'run not found');
        if (row.status === 'running') throw new HttpError(409, 'run is still running');
        if (active) throw new HttpError(409, 'another run is active; wait for it to finish');
        const ignore = loadProject(row.project).config.ignore;
        const point = path.join(dir, 'restore', String(runId));
        const result = revertToRestorePoint(row.project, point, { ...(ignore ? { ignore } : {}), ...(body.yes === true ? {} : { dryRun: true }) });
        if (!result.ok) throw new HttpError(404, result.error ?? 'no restore point');
        return send(res, 200, { applied: body.yes === true, restore: result.restore, remove: result.remove });
      }
    }
    if (method === 'POST' && p === '/api/runs') {
      const runId = await startRun(await readBody(req));
      return send(res, 202, { runId });
    }
    if (method === 'POST' && p === '/api/runs/active/cancel') {
      if (!active) throw new HttpError(409, 'no active run');
      active.controller.abort();
      return send(res, 202, { ok: true });
    }
    if (method === 'POST' && p === '/api/runs/active/answer') {
      const body = await readBody(req);
      if (!active?.pending) throw new HttpError(409, 'no question is waiting');
      if (typeof body.answer !== 'string') throw new HttpError(400, 'answer must be text');
      active.pending.resolve(body.answer);
      return send(res, 200, { ok: true });
    }
    if (method === 'GET' && p === '/api/project') {
      const project = url.searchParams.get('path') ?? '';
      if (!path.isAbsolute(project) || !fs.existsSync(project) || !fs.statSync(project).isDirectory()) throw new HttpError(400, 'path must be an existing absolute folder');
      const loaded = loadProject(project);
      return send(res, 200, { config: loaded.config, errors: loaded.errors, warnings: loaded.warnings, memory: memoryFacts(loadMemory(project)).map(redactSecrets) });
    }
    if (method === 'GET' && !p.startsWith('/api/') && options.staticDir) return serveStatic(res, p);
    throw new HttpError(404, 'not found');
  }

  function serveStatic(res: http.ServerResponse, urlPath: string): void {
    const root = path.resolve(options.staticDir!);
    let relative: string;
    try { relative = decodeURIComponent(urlPath); } catch { throw new HttpError(400, 'bad path'); }
    if (relative.includes('\0')) throw new HttpError(400, 'bad path');
    let file = path.resolve(root, `.${relative}`);
    if (file !== root && !file.startsWith(root + path.sep)) throw new HttpError(404, 'not found');
    const isFile = (candidate: string): boolean => { try { return fs.statSync(candidate).isFile(); } catch { return false; } };
    if (!isFile(file)) {
      // Single-page app: unknown paths without an extension get the shell; missing assets stay 404.
      if (path.extname(relative)) throw new HttpError(404, 'not found');
      file = path.join(root, 'index.html');
      if (!isFile(file)) throw new HttpError(404, 'The dashboard is not built. Run "npm run web:build" first.');
    }
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=3600' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', CSP);
    if (req.headers.host !== host) return send(res, 403, { error: 'use the local address' });
    if (req.headers.origin && req.headers.origin !== origin) return send(res, 403, { error: 'requests from other sites are not allowed' });
    const url = new URL(req.url ?? '/', origin);
    route(req, res, url).catch((error: unknown) => {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof HttpError) return send(res, error.status, { error: error.message });
      send(res, 500, { error: 'internal error' });
    });
  });

  return {
    token,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 4317, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        host = `127.0.0.1:${port}`;
        origin = `http://${host}`;
        resolve({ port, token });
      });
    }),
    close: () => new Promise(resolve => {
      active?.controller.abort();
      for (const stream of streams) stream.end();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
