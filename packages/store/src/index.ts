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

const SCHEMA_VERSION = 2;
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
`];

/** What the dashboard shows as the run's report: the reports the agents submitted, not the raw event log. */
export function reportOf(result: RunResult): Record<string, unknown> {
  const { answer, builder, plan, research, review, reviewSkipped, requirements, warnings, unverified, failureType, redo, restorePoint } = result;
  return { answer, builder, plan, research, review, reviewSkipped, requirements, warnings, unverified, failureType, redo, restorePoint: restorePoint ? { files: restorePoint.files, bytes: restorePoint.bytes } : undefined };
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
  latestBrief(project: string): string | null {
    const row = this.#db.prepare("SELECT brief FROM runs WHERE project = ? AND status != 'running' AND brief IS NOT NULL ORDER BY id DESC LIMIT 1").get(project) as { brief: string } | undefined;
    return row?.brief ?? null;
  }
}
