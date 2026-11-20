// SQLite store for runs, events and token usage (node:sqlite, no dependencies).
// Events are append-only; run status is updated on every state change so a
// server that died mid-run can mark the run as interrupted on the next start.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RunStatus, TokenUsage } from '#core';
import { buildRunBrief } from '#orchestrator';
import type { RunEvent, RunResult } from '#orchestrator';
import { sanitize } from './redact.ts';

export { redactSecrets, sanitize } from './redact.ts';

const SCHEMA_VERSION = 4;
const MAX_STRING = 4000;

export interface RunRow {
  id: number;
  project: string;
  request: string;
  workflow: string | null;
  status: RunStatus | 'running';
  reason: string | null;
  brief: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface StoredEvent {
  seq: number;
  at: string;
  type: string;
  data: RunEvent;
}

export interface UsageRow {
  stepId: string;
  turn: number;
  usage: TokenUsage;
}

const MIGRATIONS: string[] = [`
  CREATE TABLE runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    request TEXT NOT NULL,
    workflow TEXT,
    status TEXT NOT NULL,
    reason TEXT,
    brief TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE TABLE steps (
    run_id INTEGER NOT NULL REFERENCES runs(id),
    step TEXT NOT NULL,
    role TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    ok INTEGER,
    detail TEXT
  );
  CREATE TABLE events (
    run_id INTEGER NOT NULL REFERENCES runs(id),
    seq INTEGER NOT NULL,
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
  );
  CREATE TABLE usage (
    run_id INTEGER NOT NULL REFERENCES runs(id),
    step_id TEXT NOT NULL,
    turn INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    cached_input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    reasoning_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL
  );
  CREATE INDEX runs_project ON runs(project, id);
  CREATE INDEX usage_run ON usage(run_id);
`, `
  ALTER TABLE runs ADD COLUMN report TEXT;
`, `
  ALTER TABLE runs ADD COLUMN settings TEXT;
`, `
  CREATE TABLE feedback (
    run_id INTEGER PRIMARY KEY REFERENCES runs(id),
    rating INTEGER NOT NULL,
    cause TEXT,
    target TEXT,
    note TEXT,
    at TEXT NOT NULL
  );
`];

/** Where a bad result should be fixed (the book's improvement loop): result quality -> skill, role confusion -> role file, order or routing -> workflow/config. */
export const FEEDBACK_CAUSES = ['skill', 'role', 'workflow', 'other'] as const;
export type FeedbackCause = typeof FEEDBACK_CAUSES[number];

export interface Feedback { runId: number; rating: 1 | -1; cause: FeedbackCause | null; target: string | null; note: string | null; at: string }

/** One run in the quality log: the user's rating next to what the harness measured. */
export interface QualityRow {
  runId: number;
  project: string;
  request: string;
  workflow: string | null;
  status: string;
  startedAt: string;
  tokens: number;
  redo: number;
  rejectedReports: number;
  rating: 1 | -1 | null;
  cause: FeedbackCause | null;
  target: string | null;
  note: string | null;
}

/** What the dashboard shows as the run's report: the reports the agents submitted, not the raw event log. */
export function reportOf(result: RunResult): Record<string, unknown> {
  const { answer, builder, plan, research, review, reviewSkipped, requirements, warnings, unverified, failureType, redo, restorePoint, memorySuggestions, resume, skillsRead, attempts, modelsUsed } = result;
  return { answer, builder, plan, research, review, reviewSkipped, requirements, warnings, unverified, failureType, redo, restorePoint: restorePoint ? { files: restorePoint.files, bytes: restorePoint.bytes } : undefined, memorySuggestions, resume, skillsRead, attempts, modelsUsed };
}

export class RunStore {
  readonly #db: DatabaseSync;

  constructor(location: string) {
    if (location !== ':memory:') fs.mkdirSync(path.dirname(location), { recursive: true });
    this.#db = new DatabaseSync(location);
    if (location !== ':memory:') this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#migrate();
  }

  #migrate(): void {
    const version = (this.#db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > SCHEMA_VERSION) throw new Error(`database schema version ${version} is newer than this program supports (${SCHEMA_VERSION})`);
    for (let next = version; next < SCHEMA_VERSION; next++) {
      this.#db.exec('BEGIN');
      try { this.#db.exec(MIGRATIONS[next]!); this.#db.exec(`PRAGMA user_version = ${next + 1}`); this.#db.exec('COMMIT'); }
      catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    }
  }

  close(): void {
    this.#db.close();
  }

  startRun(project: string, request: string): number {
    const row = this.#db.prepare('INSERT INTO runs (project, request, status, started_at) VALUES (?, ?, ?, ?)').run(project, request, 'running', new Date().toISOString());
    return Number(row.lastInsertRowid);
  }

  /** Returns a callback for RunConfig.onEvent that stores every event. */
  recorder(runId: number): (event: RunEvent) => void {
    const insert = this.#db.prepare('INSERT INTO events (run_id, seq, at, type, data) VALUES (?, ?, ?, ?, ?)');
    const openStep = this.#db.prepare('INSERT INTO steps (run_id, step, role, started_at) VALUES (?, ?, ?, ?)');
    const closeStep = this.#db.prepare('UPDATE steps SET finished_at = ?, ok = ?, detail = ? WHERE rowid = (SELECT rowid FROM steps WHERE run_id = ? AND step = ? AND finished_at IS NULL ORDER BY rowid DESC LIMIT 1)');
    return event => {
      insert.run(runId, event.seq, event.at, event.type, JSON.stringify(sanitize(event, MAX_STRING)));
      if (event.type === 'step_started') openStep.run(runId, event.step, event.role, event.at);
      if (event.type === 'step_finished') closeStep.run(event.at, event.ok ? 1 : 0, event.detail, runId, event.step);
    };
  }

  finishRun(runId: number, request: string, result: RunResult): string {
    const brief = buildRunBrief(request, result);
    this.#db.exec('BEGIN');
    try {
      this.#db.prepare('UPDATE runs SET status = ?, reason = ?, workflow = ?, brief = ?, report = ?, finished_at = ? WHERE id = ?')
        .run(result.status, result.reason, result.workflow ?? null, brief, JSON.stringify(sanitize(reportOf(result), MAX_STRING)), new Date().toISOString(), runId);
      const insert = this.#db.prepare('INSERT INTO usage (run_id, step_id, turn, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const entry of result.usageEntries) {
        const delta = entry.delta;
        insert.run(runId, entry.stepId, entry.turn, delta.inputTokens, delta.cachedInputTokens, delta.outputTokens, delta.reasoningTokens, delta.totalTokens);
      }
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    return brief;
  }

  /**
   * Call once at startup. Runs still marked "running" belong to a process that
   * died; mark them interrupted (never re-run them automatically).
   */
  recoverInterrupted(): number[] {
    const stale = this.#db.prepare("SELECT id FROM runs WHERE status = 'running'").all() as { id: number }[];
    const now = new Date().toISOString();
    for (const { id } of stale) {
      const last = this.#db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE run_id = ?').get(id) as { seq: number };
      const reason = 'The program stopped while this run was in progress. Nothing was re-run; check the project folder, then start a new run if needed.';
      this.#db.exec('BEGIN');
      this.#db.prepare('INSERT INTO events (run_id, seq, at, type, data) VALUES (?, ?, ?, ?, ?)').run(id, last.seq + 1, now, 'run_finished', JSON.stringify({ type: 'run_finished', status: 'interrupted', reason, seq: last.seq + 1, at: now }));
      this.#db.prepare("UPDATE runs SET status = 'interrupted', reason = ?, finished_at = ? WHERE id = ?").run(reason, now, id);
      this.#db.prepare('UPDATE steps SET finished_at = ?, ok = 0, detail = ? WHERE run_id = ? AND finished_at IS NULL').run(now, 'interrupted', id);
      this.#db.exec('COMMIT');
    }
    return stale.map(row => row.id);
  }

  #toRun(row: Record<string, unknown>): RunRow {
    return { id: Number(row.id), project: String(row.project), request: String(row.request), workflow: (row.workflow as string | null) ?? null, status: row.status as RunRow['status'], reason: (row.reason as string | null) ?? null, brief: (row.brief as string | null) ?? null, startedAt: String(row.started_at), finishedAt: (row.finished_at as string | null) ?? null };
  }

  /** Tokens per step for runs started since `sinceIso`, with each run's settings (for per-runtime usage). */
  usageSince(sinceIso: string): { runId: number; stepId: string; tokens: number; settings: string | null }[] {
    const rows = this.#db.prepare('SELECT u.run_id AS runId, u.step_id AS stepId, u.total_tokens AS tokens, r.settings AS settings FROM usage u JOIN runs r ON r.id = u.run_id WHERE r.started_at >= ?').all(sinceIso) as { runId: number; stepId: string; tokens: number; settings: string | null }[];
    return rows.map(row => ({ runId: Number(row.runId), stepId: String(row.stepId), tokens: Number(row.tokens), settings: row.settings ?? null }));
  }

  /** The settings a run started with (mode, runtimes per role, review policy, skills, verify, limits ...). */
  setSettings(runId: number, settings: Record<string, unknown>): void {
    this.#db.prepare('UPDATE runs SET settings = ? WHERE id = ?').run(JSON.stringify(sanitize(settings, MAX_STRING)), runId);
  }

  getSettings(runId: number): Record<string, unknown> | null {
    const row = this.#db.prepare('SELECT settings FROM runs WHERE id = ?').get(runId) as { settings: string | null } | undefined;
    return row?.settings ? JSON.parse(row.settings) as Record<string, unknown> : null;
  }

  /** The report saved when the run finished; null for runs that are still running or were recorded before reports were kept. */
  getReport(runId: number): Record<string, unknown> | null {
    const row = this.#db.prepare('SELECT report FROM runs WHERE id = ?').get(runId) as { report: string | null } | undefined;
    if (!row?.report) return null;
    try { return JSON.parse(row.report) as Record<string, unknown>; } catch { return null; }
  }

  getRun(runId: number): RunRow | null {
    const row = this.#db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    return row ? this.#toRun(row) : null;
  }

  /** Run ids recorded for a project folder (exact path as stored). */
  runIdsForProject(project: string): number[] {
    return (this.#db.prepare('SELECT id FROM runs WHERE project = ?').all(project) as { id: number }[]).map(row => row.id);
  }

  /** Every distinct project path with its run count. */
  projects(): { project: string; runs: number }[] {
    return (this.#db.prepare('SELECT project, COUNT(*) AS runs FROM runs GROUP BY project').all() as { project: string; runs: number }[]).map(row => ({ project: row.project, runs: Number(row.runs) }));
  }

  /** Saves (or replaces) the user's rating of a finished run. */
  setFeedback(feedback: Omit<Feedback, 'at'>): Feedback {
    if (!this.getRun(feedback.runId)) throw new Error(`run ${feedback.runId} not found`);
    if (feedback.rating !== 1 && feedback.rating !== -1) throw new Error('rating must be 1 or -1');
    if (feedback.cause !== null && !FEEDBACK_CAUSES.includes(feedback.cause)) throw new Error(`cause must be one of ${FEEDBACK_CAUSES.join(', ')}`);
    const clip = (value: string | null) => (value === null ? null : value.slice(0, MAX_STRING));
    const saved: Feedback = { runId: feedback.runId, rating: feedback.rating, cause: feedback.rating === 1 ? null : feedback.cause, target: feedback.rating === 1 ? null : clip(feedback.target), note: clip(feedback.note), at: new Date().toISOString() };
    this.#db.prepare('INSERT OR REPLACE INTO feedback (run_id, rating, cause, target, note, at) VALUES (?, ?, ?, ?, ?, ?)').run(saved.runId, saved.rating, saved.cause, saved.target, saved.note, saved.at);
    return saved;
  }

  getFeedback(runId: number): Feedback | null {
    const row = this.#db.prepare('SELECT * FROM feedback WHERE run_id = ?').get(runId) as Record<string, unknown> | undefined;
    return row ? { runId: Number(row.run_id), rating: Number(row.rating) as 1 | -1, cause: (row.cause as FeedbackCause | null) ?? null, target: (row.target as string | null) ?? null, note: (row.note as string | null) ?? null, at: String(row.at) } : null;
  }

  clearFeedback(runId: number): void {
    this.#db.prepare('DELETE FROM feedback WHERE run_id = ?').run(runId);
  }

  /** Finished runs with their rating (if any), tokens, REDO rounds and reports the evidence checks sent back. */
  qualityRows(project?: string, limit = 500): QualityRow[] {
    const sql = `SELECT r.id, r.project, r.request, r.workflow, r.status, r.started_at, r.report,
        f.rating, f.cause, f.target, f.note,
        (SELECT COALESCE(SUM(total_tokens), 0) FROM usage u WHERE u.run_id = r.id) AS tokens,
        (SELECT COUNT(*) FROM events e WHERE e.run_id = r.id AND e.type = 'report' AND json_extract(e.data, '$.accepted') = 0) AS rejected
      FROM runs r LEFT JOIN feedback f ON f.run_id = r.id
      WHERE r.status != 'running' ${project ? 'AND r.project = ?' : ''} ORDER BY r.id DESC LIMIT ?`;
    const rows = (project ? this.#db.prepare(sql).all(project, limit) : this.#db.prepare(sql).all(limit)) as Record<string, unknown>[];
    return rows.map(row => {
      let redo = 0;
      try { redo = Number((JSON.parse(String(row.report ?? '{}')) as { redo?: number }).redo) || 0; } catch { /* old rows */ }
      return {
        runId: Number(row.id), project: String(row.project), request: String(row.request), workflow: (row.workflow as string | null) ?? null, status: String(row.status), startedAt: String(row.started_at),
        tokens: Number(row.tokens), redo, rejectedReports: Number(row.rejected),
        rating: row.rating === null || row.rating === undefined ? null : (Number(row.rating) as 1 | -1), cause: (row.cause as FeedbackCause | null) ?? null, target: (row.target as string | null) ?? null, note: (row.note as string | null) ?? null,
      };
    });
  }

  /** Deletes runs and everything recorded for them (events, steps, usage). Running runs are skipped. Returns the ids deleted. */
  deleteRuns(ids: number[]): number[] {
    const deleted: number[] = [];
    const status = this.#db.prepare('SELECT status FROM runs WHERE id = ?');
    const statements = ['DELETE FROM feedback WHERE run_id = ?', 'DELETE FROM usage WHERE run_id = ?', 'DELETE FROM events WHERE run_id = ?', 'DELETE FROM steps WHERE run_id = ?', 'DELETE FROM runs WHERE id = ?'].map(sql => this.#db.prepare(sql));
    this.#db.exec('BEGIN');
    try {
      for (const id of ids) {
        const row = status.get(id) as { status: string } | undefined;
        if (!row || row.status === 'running') continue;
        for (const statement of statements) statement.run(id);
        deleted.push(id);
      }
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    return deleted;
  }

  listRuns(project?: string, limit = 50): RunRow[] {
    const rows = project
      ? this.#db.prepare('SELECT * FROM runs WHERE project = ? ORDER BY id DESC LIMIT ?').all(project, limit)
      : this.#db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map(row => this.#toRun(row));
  }

  events(runId: number, afterSeq = 0): StoredEvent[] {
    const rows = this.#db.prepare('SELECT seq, at, type, data FROM events WHERE run_id = ? AND seq > ? ORDER BY seq').all(runId, afterSeq) as { seq: number; at: string; type: string; data: string }[];
    return rows.map(row => ({ seq: row.seq, at: row.at, type: row.type, data: JSON.parse(row.data) as RunEvent }));
  }

  usage(runId: number): UsageRow[] {
    const rows = this.#db.prepare('SELECT * FROM usage WHERE run_id = ? ORDER BY rowid').all(runId) as Record<string, number | string>[];
    return rows.map(row => ({ stepId: String(row.step_id), turn: Number(row.turn), usage: { inputTokens: Number(row.input_tokens), cachedInputTokens: Number(row.cached_input_tokens), outputTokens: Number(row.output_tokens), reasoningTokens: Number(row.reasoning_tokens), totalTokens: Number(row.total_tokens) } }));
  }

  /** Total of the stored per-turn increments for a run. */
  usageTotal(runId: number): number {
    return (this.#db.prepare('SELECT COALESCE(SUM(total_tokens), 0) AS total FROM usage WHERE run_id = ?').get(runId) as { total: number }).total;
  }

  steps(runId: number): { step: string; role: string; ok: boolean | null; detail: string | null }[] {
    const rows = this.#db.prepare('SELECT step, role, ok, detail FROM steps WHERE run_id = ? ORDER BY rowid').all(runId) as { step: string; role: string; ok: number | null; detail: string | null }[];
    return rows.map(row => ({ step: row.step, role: row.role, ok: row.ok === null ? null : row.ok === 1, detail: row.detail }));
  }

  /** The Run Brief of the project's most recent finished run, for the next run's classify step. */
  /** Finished runs of a project with a brief, newest first. */
  recentBriefs(project: string, limit = 30): { id: number; startedAt: string; brief: string }[] {
    return (this.#db.prepare("SELECT id, started_at, brief FROM runs WHERE project = ? AND status != 'running' AND brief IS NOT NULL ORDER BY id DESC LIMIT ?").all(project, limit) as { id: number; started_at: string; brief: string }[])
      .map(row => ({ id: Number(row.id), startedAt: String(row.started_at), brief: String(row.brief) }));
  }

  /**
   * Finished runs of a project whose request, brief or stored report (work summary, requirements, review) contain
   * the words, case-insensitive, newest first. "all" needs every word; "any" ranks runs by how many words they contain.
   */
  searchRuns(project: string, words: readonly string[], limit = 5, mode: 'all' | 'any' = 'all'): number[] {
    const terms = [...new Set(words.map(word => word.trim().toLowerCase()).filter(Boolean))].slice(0, 8);
    if (!terms.length) return [];
    const hit = "(lower(request) LIKE ? ESCAPE '\\' OR lower(COALESCE(brief, '')) LIKE ? ESCAPE '\\' OR lower(COALESCE(report, '')) LIKE ? ESCAPE '\\')";
    const params = terms.flatMap(term => { const like = `%${term.replace(/[\\%_]/g, char => `\\${char}`)}%`; return [like, like, like]; });
    const sql = mode === 'all'
      ? `SELECT id FROM runs WHERE project = ? AND status != 'running' AND ${terms.map(() => hit).join(' AND ')} ORDER BY id DESC LIMIT ?`
      : `SELECT id FROM (SELECT id, (${terms.map(() => `CASE WHEN ${hit} THEN 1 ELSE 0 END`).join(' + ')}) AS score FROM runs WHERE project = ? AND status != 'running') WHERE score > 0 ORDER BY score DESC, id DESC LIMIT ?`;
    const rows = (mode === 'all' ? this.#db.prepare(sql).all(project, ...params, limit) : this.#db.prepare(sql).all(...params, project, limit)) as { id: number }[];
    return rows.map(row => Number(row.id));
  }

  /** The model each runtime last reported running on, from recent runs (role -> runtime from the run settings). */
  lastModels(): Partial<Record<'codex' | 'claude', string>> {
    const out: Partial<Record<'codex' | 'claude', string>> = {};
    const rows = this.#db.prepare("SELECT report, settings FROM runs WHERE report LIKE '%modelsUsed%' ORDER BY id DESC LIMIT 50").all() as { report: string; settings: string | null }[];
    for (const row of rows) {
      try {
        const used = (JSON.parse(row.report) as { modelsUsed?: Record<string, string> }).modelsUsed ?? {};
        const runtimes = (JSON.parse(row.settings ?? '{}') as { runtimes?: Record<string, string> }).runtimes ?? {};
        for (const [role, model] of Object.entries(used)) {
          const runtime = runtimes[role];
          if ((runtime === 'codex' || runtime === 'claude') && !out[runtime]) out[runtime] = model;
        }
      } catch { /* old rows */ }
      if (out.codex && out.claude) break;
    }
    return out;
  }

  latestBrief(project: string): string | null {
    const row = this.#db.prepare("SELECT brief FROM runs WHERE project = ? AND status != 'running' AND brief IS NOT NULL ORDER BY id DESC LIMIT 1").get(project) as { brief: string } | undefined;
    return row?.brief ?? null;
  }
}
