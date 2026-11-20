// Local HTTP + SSE server for the dashboard. Same security stance as v1:
// loopback only, Host/Origin checks, a per-start CSRF token on every POST,
// strict response headers, secrets masked in anything shown. One run at a time.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Runtime, UserQuestion } from '#core';
import { revertToRestorePoint } from '#orchestrator';
import type { ReviewPolicy } from '#orchestrator';
import { addMemory, checkSkills, draftFromInspection, inspectProject, loadMemory, loadProject, memoryFacts, modeOf, projectFiles, RUNTIME_MODES, saveProjectFile, writeDraft } from '#project';
import type { RuntimeKind, RuntimeMode } from '#project';
import { dataDirectory, executeRun, locate, normalizeRateLimits, readMachineSettings } from '#service';
import type { Limits } from '#service';
import { summarizeBench } from './bench-results.ts';
import { pickFolderNative } from './pick-folder.ts';
import type { PickResult } from './pick-folder.ts';
import { FEEDBACK_CAUSES, RunStore, redactSecrets } from '#store';
import type { FeedbackCause, QualityRow } from '#store';
import { qualityCsv, qualitySummary } from './quality.ts';

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
  /** Opens the OS folder dialog (tests replace it). Default: the native dialog on Windows and macOS. */
  pickFolder?: (startPath: string, title: string) => Promise<PickResult>;
  /** Folder with saved benchmark runs (bench/results/runs). Omitted: the benchmark screen is empty. */
  benchDir?: string;
  /** Reads the Codex account rate limits (tests replace it). Default: a short-lived Codex app-server. */
  readRateLimits?: () => Promise<unknown>;
  /** Lists the models the Codex account can use (tests replace it). Default: "model/list" on a short-lived Codex app-server. */
  listCodexModels?: () => Promise<ModelChoice[]>;
}

interface ModelChoice { id: string; label: string; isDefault: boolean }
// Claude Code takes these aliases for its current models; the default depends on the account, so it is shown as the model last seen running.
const CLAUDE_MODELS: ModelChoice[] = [{ id: 'opus', label: 'Opus', isDefault: false }, { id: 'sonnet', label: 'Sonnet', isDefault: false }, { id: 'haiku', label: 'Haiku', isDefault: false }];

interface ActiveRun {
  runId: number;
  project: string;
  request: string;
  controller: AbortController;
  pending: { question: UserQuestion; resolve(answer: string): void } | null;
}

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const REVIEWS = new Set(['always', 'auto', 'never', 'self']);
const RUNTIMES = new Set(['codex', 'claude', 'fake']);
const MODES = new Set<string>(RUNTIME_MODES);
/** Workspaces made by bench/run.mjs live under <tmp>/agent-desk-bench/<label>/<task>-r<n>-<stamp>. */
export const isBenchWorkspace = (project: string): boolean => /[\\/]agent-desk-bench(?:-validate-[^\\/]*)?[\\/]/.test(project);
const MAX_BODY = 256 * 1024;
/** Run requests may carry images (data URLs): up to 4, 5 MB each. */
const MAX_RUN_BODY = 28 * 1024 * 1024;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
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
  const readBody = async (req: http.IncomingMessage, limit = MAX_BODY): Promise<Record<string, unknown>> => {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'JSON body required');
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) throw new HttpError(413, 'request too large');
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
    const mode = body.mode;
    if (mode !== undefined && !(typeof mode === 'string' && MODES.has(mode))) throw new HttpError(400, 'unknown mode');
    const review = body.review;
    if (review !== undefined && !(typeof review === 'string' && REVIEWS.has(review))) throw new HttpError(400, 'review must be always, auto, never or self');
    const language = body.language;
    if (language !== undefined && language !== 'en' && language !== 'ko') throw new HttpError(400, 'language must be en or ko');
    const verify = Array.isArray(body.verify) ? body.verify.filter((item): item is string => typeof item === 'string') : [];
    const resumeOf = body.resumeOf;
    if (resumeOf !== undefined && !(Number.isInteger(resumeOf) && (resumeOf as number) > 0)) throw new HttpError(400, 'resumeOf must be a run id');
    const images = saveImages(body.images);
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
        ...(mode ? { mode: mode as RuntimeMode } : {}),
        ...(review ? { review: review as ReviewPolicy } : {}),
        ...(language ? { language } : {}),
        ...(images.length ? { images } : {}),
        ...(resumeOf ? { resumeOf: resumeOf as number } : {}),
        verify, ask, signal: controller.signal,
        onStarted: ({ runId }) => { started = true; active = { runId, project, request, controller, pending: null }; resolveId(runId); },
      }).then(outcome => {
        if (!outcome.ok && !started) rejectId(new HttpError(outcome.code === 64 ? 400 : 500, outcome.message));
      }).catch(error => {
        if (!started) rejectId(error as Error);
      }).finally(() => { active = null; });
    });
  }

  /** Writes attached images (data URLs) to the data folder and returns their paths. */
  function saveImages(raw: unknown): string[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) throw new HttpError(400, 'images must be a list');
    if (raw.length > MAX_IMAGES) throw new HttpError(400, `at most ${MAX_IMAGES} images`);
    const folder = path.join(dir, 'attachments', `${Date.now()}-${randomBytes(4).toString('hex')}`);
    return raw.map((item, index) => {
      const match = typeof item === 'string' ? /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(item) : null;
      if (!match) throw new HttpError(400, 'images must be PNG, JPEG, WebP or GIF data URLs');
      const bytes = Buffer.from(match[2]!, 'base64');
      if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(400, 'an image is larger than 5 MB');
      fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, `image-${index + 1}${IMAGE_EXT[match[1]!]}`);
      fs.writeFileSync(file, bytes);
      return file;
    });
  }

  /** Tokens Agent Desk spent on Claude from this PC (Claude Code does not report the account's limit share). */
  function claudeUsage(): { last5h: number; last7d: number; runs5h: number } {
    const roleOf = (stepId: string, settings: Record<string, unknown>): string => {
      const step = stepId.split(/[#:]/)[0];
      if (step === 'build') return 'builder';
      if (step === 'review') return settings.review === 'self' ? 'builder' : 'verifier';
      if (step === 'research') return 'researcher';
      return 'lead';
    };
    const total = (sinceMs: number): { tokens: number; runs: number } => {
      const runs = new Set<number>();
      let tokens = 0;
      for (const row of withStore(store => store.usageSince(new Date(Date.now() - sinceMs).toISOString()))) {
        let settings: Record<string, unknown> = {};
        try { settings = row.settings ? JSON.parse(row.settings) as Record<string, unknown> : {}; } catch { /* old run */ }
        const runtimes = (settings.runtimes ?? {}) as Record<string, string>;
        if (runtimes[roleOf(row.stepId, settings)] === 'claude') { tokens += row.tokens; runs.add(row.runId); }
      }
      return { tokens, runs: runs.size };
    };
    const recent = total(5 * 3600_000);
    return { last5h: recent.tokens, runs5h: recent.runs, last7d: total(7 * 24 * 3600_000).tokens };
  }

  const projectDir = (value: unknown): string => {
    const project = typeof value === 'string' ? value : '';
    if (!path.isAbsolute(project) || !fs.existsSync(project) || !fs.statSync(project).isDirectory()) throw new HttpError(400, 'path must be an existing absolute folder');
    return project;
  };
  const notWhileRunning = (project: string): void => { if (active && active.project === project) throw new HttpError(409, 'another run is active; wait for it to finish'); };

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
    if (method === 'GET' && p === '/api/state') {
      const saved = readMachineSettings(dataDirectory(options.env, options.platform));
      const installed = { codex: !!locate('codex', options.env, options.platform, saved), claude: !!locate('claude', options.env, options.platform, saved) };
      return send(res, 200, { csrf: token, active: activeView(), installed });
    }
    if (method === 'GET' && p === '/api/runs') {
      const project = url.searchParams.get('project') ?? undefined;
      return send(res, 200, { runs: withStore(store => store.listRuns(project, 100)).map(run => ({ ...run, request: redactSecrets(run.request), brief: run.brief ? redactSecrets(run.brief) : null })) });
    }
    const runMatch = /^\/api\/runs\/(\d+)(?:\/(events|revert))?$/.exec(p);
    if (runMatch) {
      const runId = Number(runMatch[1]);
      const sub = runMatch[2];
      if (method === 'GET' && !sub) {
        const detail = withStore(store => { const run = store.getRun(runId); return run ? { run, steps: store.steps(runId), usage: store.usage(runId), usageTotal: store.usageTotal(runId), report: store.getReport(runId), settings: store.getSettings(runId), feedback: store.getFeedback(runId) } : null; });
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
    if (method === 'GET' && (p === '/api/quality' || p === '/api/quality/export')) {
      const project = url.searchParams.get('project') ?? undefined;
      const rows: QualityRow[] = withStore(store => store.qualityRows(project)).map(row => ({ ...row, request: redactSecrets(row.request), note: row.note ? redactSecrets(row.note) : null }));
      if (p === '/api/quality') return send(res, 200, { rows, summary: qualitySummary(rows) });
      const stamp = new Date().toISOString().slice(0, 10);
      if (url.searchParams.get('format') === 'json') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="agent-desk-quality-${stamp}.json"`, 'Cache-Control': 'no-store' });
        return void res.end(JSON.stringify({ exportedAt: new Date().toISOString(), project: project ?? null, summary: qualitySummary(rows), rows }, null, 2));
      }
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="agent-desk-quality-${stamp}.csv"`, 'Cache-Control': 'no-store' });
      return void res.end(qualityCsv(rows));
    }
    if (method === 'POST' && p === '/api/feedback') {
      const body = await readBody(req);
      const runId = Number(body.runId);
      if (!Number.isInteger(runId)) throw new HttpError(400, 'runId must be a run number');
      const row = withStore(store => store.getRun(runId));
      if (!row) throw new HttpError(404, 'run not found');
      if (row.status === 'running') throw new HttpError(409, 'rate the run after it finishes');
      if (body.rating === 0) { withStore(store => store.clearFeedback(runId)); return send(res, 200, { feedback: null }); }
      if (body.rating !== 1 && body.rating !== -1) throw new HttpError(400, 'rating must be 1, -1 or 0 (clear)');
      const cause = body.cause === undefined || body.cause === null ? null : String(body.cause);
      if (cause !== null && !(FEEDBACK_CAUSES as readonly string[]).includes(cause)) throw new HttpError(400, `cause must be one of ${FEEDBACK_CAUSES.join(', ')}`);
      const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
      const target = text(body.target);
      if (target && (path.isAbsolute(target) || target.split(/[\\/]/).includes('..'))) throw new HttpError(400, 'target must be a path inside the project');
      const feedback = withStore(store => store.setFeedback({ runId, rating: body.rating as 1 | -1, cause: cause as FeedbackCause | null, target, note: text(body.note) }));
      return send(res, 200, { feedback });
    }
    if (method === 'POST' && p === '/api/history/delete') {
      // Forgets runs: one project's ({ project }) or every benchmark workspace's ({ benchWorkspaces: true }).
      // Only the dashboard history goes; project files and bench/results are not touched.
      const body = await readBody(req);
      const project = typeof body.project === 'string' ? body.project : null;
      if (!project && body.benchWorkspaces !== true) throw new HttpError(400, 'say which history to delete');
      if (active && (!project || active.project === project)) throw new HttpError(409, 'another run is active; wait for it to finish');
      const deleted = withStore(store => {
        const projects = project ? [project] : store.projects().map(entry => entry.project).filter(isBenchWorkspace);
        return store.deleteRuns(projects.flatMap(name => store.runIdsForProject(name)));
      });
      for (const id of deleted) fs.rmSync(path.join(dir, 'restore', String(id)), { recursive: true, force: true });
      return send(res, 200, { deleted: deleted.length });
    }
    if (method === 'POST' && p === '/api/runs') {
      const runId = await startRun(await readBody(req, MAX_RUN_BODY));
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
      const skills = checkSkills(project, loaded.config, loaded.roles);
      return send(res, 200, { config: loaded.config, mode: modeOf(loaded.config), errors: loaded.errors, warnings: loaded.warnings, memory: memoryFacts(loadMemory(project)).map(redactSecrets), skills: skills.skills.map(skill => ({ id: skill.id, description: skill.description })), skillFindings: skills.findings });
    }
    if (method === 'GET' && p === '/api/project/files') return send(res, 200, projectFiles(projectDir(url.searchParams.get('path'))));
    if (method === 'POST' && p === '/api/project/files') {
      const body = await readBody(req);
      const project = projectDir(body.project);
      notWhileRunning(project);
      if (body.kind !== 'config' && body.kind !== 'role' && body.kind !== 'skill') throw new HttpError(400, 'kind must be config, role or skill');
      const result = saveProjectFile(project, { kind: body.kind, ...(typeof body.id === 'string' ? { id: body.id } : {}), ...(typeof body.text === 'string' ? { text: body.text } : {}), ...(body.remove === true ? { remove: true } : {}) });
      return send(res, result.ok ? 200 : 422, result.ok ? { ok: true, warnings: result.warnings } : { ok: false, errors: result.errors, error: result.errors[0] });
    }
    if (method === 'POST' && p === '/api/project/init') {
      const body = await readBody(req);
      const project = projectDir(body.project);
      notWhileRunning(project);
      const saved = readMachineSettings(dir);
      const available = (['codex', 'claude'] as const).filter(kind => locate(kind, options.env, options.platform, saved));
      const draft = draftFromInspection(inspectProject(project), available);
      return send(res, 200, { written: writeDraft(project, draft), rationale: draft.rationale });
    }
    if (method === 'POST' && p === '/api/project/memory') {
      const body = await readBody(req);
      const project = projectDir(body.project);
      const result = addMemory(project, typeof body.fact === 'string' ? body.fact : '');
      if (!result.ok) throw new HttpError(400, result.error);
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && p === '/api/pick-folder') {
      const body = await readBody(req);
      const start = typeof body.start === 'string' && path.isAbsolute(body.start) && fs.existsSync(body.start) ? body.start : '';
      const title = typeof body.title === 'string' ? body.title.slice(0, 100) : 'Select project folder';
      const result = await (options.pickFolder ?? ((startPath, label) => pickFolderNative(options.platform, startPath, label, options.env)))(start, title);
      if (result.supported && result.path && (!path.isAbsolute(result.path) || !fs.existsSync(result.path))) throw new HttpError(400, 'the chosen folder does not exist');
      return send(res, 200, result);
    }
    if (method === 'GET' && p === '/api/bench') return send(res, 200, { summaries: options.benchDir ? summarizeBench(options.benchDir) : [] });
    if (method === 'GET' && p === '/api/models') return send(res, 200, await modelChoices());
    if (method === 'GET' && p === '/api/usage') return send(res, 200, { ...await codexLimits(), claude: claudeUsage() });
    if (method === 'GET' && p === '/api/fs') return send(res, 200, listFolder(url.searchParams.get('path') ?? ''));
    if (method === 'GET' && !p.startsWith('/api/') && options.staticDir) return serveStatic(res, p);
    throw new HttpError(404, 'not found');
  }

  let limitsCache: { at: number; value: { limits: Limits | null; reason?: string } } | null = null;
  /** Codex 5-hour account usage. Starts a short-lived Codex process, so the answer is cached for 20 seconds. */
  async function codexLimits(): Promise<{ limits: Limits | null; reason?: string }> {
    if (limitsCache && Date.now() - limitsCache.at < 20_000) return limitsCache.value;
    let value: { limits: Limits | null; reason?: string };
    try {
      let read = options.readRateLimits;
      if (!read) {
        const found = locate('codex', options.env, options.platform, readMachineSettings(dir));
        if (!found) throw new Error('Codex was not found');
        const runtime = options.createRuntime('codex', found.path) as Runtime & { readRateLimits?: () => Promise<unknown> };
        if (!runtime.readRateLimits) throw new Error('this runtime cannot report usage');
        read = () => runtime.readRateLimits!();
      }
      const limits = normalizeRateLimits(await read());
      value = limits.status === 'available' ? { limits } : { limits: null, reason: 'Codex did not report usage' };
    } catch (error) { value = { limits: null, reason: error instanceof Error ? error.message : String(error) }; }
    limitsCache = { at: Date.now(), value };
    return value;
  }

  let modelsCache: { at: number; value: unknown } | null = null;
  /** Models to choose per role and runtime. The Codex list comes from the account (cached 10 minutes); the default shown
   *  is the account default, or else the model last seen running. */
  async function modelChoices(): Promise<{ codex: { models: ModelChoice[]; default: string | null; reason?: string }; claude: { models: ModelChoice[]; default: string | null } }> {
    if (modelsCache && Date.now() - modelsCache.at < 600_000) return modelsCache.value as Awaited<ReturnType<typeof modelChoices>>;
    const last = withStore(store => store.lastModels());
    let codex: ModelChoice[] = [];
    let reason: string | undefined;
    try {
      let list = options.listCodexModels;
      if (!list) {
        const found = locate('codex', options.env, options.platform, readMachineSettings(dir));
        if (!found) throw new Error('Codex was not found');
        const runtime = options.createRuntime('codex', found.path) as Runtime & { listModels?: () => Promise<ModelChoice[]> };
        if (!runtime.listModels) throw new Error('this runtime cannot list models');
        list = () => runtime.listModels!();
      }
      codex = await list();
      if (!codex.length) reason = 'Codex returned no models';
    } catch (error) { reason = error instanceof Error ? error.message : String(error); }
    const value = {
      codex: { models: codex, default: codex.find(model => model.isDefault)?.id ?? last.codex ?? null, ...(reason ? { reason } : {}) },
      claude: { models: CLAUDE_MODELS, default: last.claude ?? null },
    };
    if (!reason) modelsCache = { at: Date.now(), value };
    return value;
  }

  /** Folder picker for the dashboard: subfolders only, never file names or contents. An empty path lists the roots (drives on Windows). */
  function listFolder(requested: string): { path: string; parent: string | null; home: string; entries: { name: string; path: string; isProject: boolean }[] } {
    const home = os.homedir();
    if (requested === '') {
      const roots = options.platform === 'win32'
        ? Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`).filter(root => fs.existsSync(root))
        : ['/'];
      return { path: '', parent: null, home, entries: roots.map(root => ({ name: root, path: root, isProject: false })) };
    }
    if (!path.isAbsolute(requested)) throw new HttpError(400, 'path must be absolute');
    let names: fs.Dirent[];
    try { names = fs.readdirSync(requested, { withFileTypes: true }); } catch { throw new HttpError(400, 'cannot open this folder'); }
    const entries = names
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 500)
      .map(name => {
        const full = path.join(requested, name);
        return { name, path: full, isProject: fs.existsSync(path.join(full, '.agent-desk')) || fs.existsSync(path.join(full, '.git')) || fs.existsSync(path.join(full, 'package.json')) };
      });
    const parent = path.dirname(requested);
    return { path: requested, parent: parent === requested ? '' : parent, home, entries };
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
