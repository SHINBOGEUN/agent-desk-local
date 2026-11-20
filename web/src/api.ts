// Thin client for the local Agent Desk server. Every POST carries the per-start token from /api/state.

import type { BenchSummary, FeedbackCause, RuntimeMode, StoredEvent } from './model.ts';

export interface RunRow {
  id: number;
  project: string;
  request: string;
  workflow: string | null;
  status: string;
  reason: string | null;
  brief: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface Pending { question: string; options?: string[] }
export interface ActiveRun { runId: number; project: string; request: string; pending: Pending | null }
export interface ServerState { csrf: string; active: ActiveRun | null; installed?: { codex: boolean; claude: boolean } }
export interface RunReport {
  answer?: { answer: string; sources: string[] };
  builder?: { summary: string; changedFiles: string[]; commandsRun: { command: string; exitCode: number }[]; requirements: { id: string; status: string; evidence: string }[]; unverified: string[] };
  plan?: { approach: string; steps: string[]; files: string[]; risks: string[] };
  research?: { angle: string; summary: string; findings: { claim: string; evidence: string }[]; sources: string[] }[];
  review?: { verdict: string; blocking: { file?: string; line?: number; reason: string; evidence: string }[]; optional: string[] };
  reviewSkipped?: string;
  requirements?: { id: string; text: string }[];
  warnings?: string[];
  unverified?: string[];
  failureType?: string;
  redo?: number;
  restorePoint?: { files: number; bytes: number };
  memorySuggestions?: string[];
  skillsRead?: { step: string; role: string; skill: string }[];
  resume?: { step: string; redo: number; note: string };
  attempts?: { attempt: number; summary: string; changedFiles: string[]; sentBackFor: string[] }[];
}

export interface RunDetail {
  run: RunRow;
  steps: { step: string; role: string; ok: boolean | null; detail: string | null }[];
  usage: { stepId: string; turn: number; usage: { totalTokens: number; inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } }[];
  usageTotal: number;
  report: RunReport | null;
  settings?: RunSettings | null;
  feedback?: Feedback | null;
}

export interface ModelChoice { id: string; label: string; isDefault: boolean }
export interface ModelChoices { codex: { models: ModelChoice[]; default: string | null; reason?: string }; claude: { models: ModelChoice[]; default: string | null } }

export interface Feedback { runId: number; rating: 1 | -1; cause: FeedbackCause | null; target: string | null; note: string | null; at: string }
export interface QualityRow { runId: number; project: string; request: string; workflow: string | null; status: string; startedAt: string; tokens: number; redo: number; rejectedReports: number; rating: 1 | -1 | null; cause: FeedbackCause | null; target: string | null; note: string | null }
export interface QualitySummary { runs: number; rated: number; up: number; down: number; approval: number | null; byCause: Record<string, number>; targets: { target: string; count: number }[]; byWorkflow: { workflow: string; runs: number; up: number; down: number }[]; meanTokensUp: number | null; meanTokensDown: number | null; rejectedReports: number; redoRuns: number }

/** What a run started with (recorded by the server). */
export interface RunSettings { mode?: string | null; runtimes?: Record<string, string>; fallback?: string; review?: string; verify?: string[]; skills?: Record<string, string[]>; images?: number; resumeOf?: number; noSkills?: boolean; notes?: string[] }
export interface ProjectFiles { config: { exists: boolean; text: string }; roles: Record<string, { exists: boolean; text: string }>; skills: { id: string; text: string }[] }
export interface SaveReply { ok: boolean; warnings?: string[]; errors?: string[] }
export interface ProjectConfigView { mode?: string; runtimes?: { primary?: string; review?: string }; verify?: string[]; review?: string; skills?: string[]; limits?: { redo?: number; tokens?: number; minutes?: number; codexUsagePercent?: number } }
export interface ProjectInfo { config: ProjectConfigView; mode?: string | null; errors: string[]; warnings: string[]; memory: string[]; skills: { id: string; description: string }[]; skillFindings: { level: string; skill: string; message: string }[] }
export interface LimitWindowView { kind: string; windowDurationMins: number | null; usedPercent: number; remainingPercent: number; resetsAt: number | null }
export interface UsageInfo { limits: { windows: LimitWindowView[]; checkedAt: string } | null; reason?: string; claude?: { last5h: number; last7d: number; runs5h: number } }
export interface StartRequest { project: string; request: string; runtime?: 'codex' | 'claude'; mode?: RuntimeMode; images?: string[]; resumeOf?: number; review?: 'always' | 'auto' | 'never' | 'self'; language?: 'en' | 'ko'; verify?: string[] }
export interface RevertPlan { applied: boolean; restore: string[]; remove: string[] }

export interface FolderEntry { name: string; path: string; isProject: boolean }
export interface FolderListing { path: string; parent: string | null; home: string; entries: FolderEntry[] }

export class ApiError extends Error {
  readonly status: number;
  readonly details: string[];
  constructor(status: number, message: string, details: string[] = []) { super(message); this.status = status; this.details = details; }
}

let token = '';
export const setToken = (value: string): void => { token = value; };

async function request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method === 'POST' ? { 'X-Agent-Desk-Token': token } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) throw new ApiError(response.status, (data as { error?: string }).error ?? `request failed (${response.status})`, (data as { errors?: string[] }).errors ?? []);
  return data as T;
}

export const api = {
  state: async (): Promise<ServerState> => { const state = await request<ServerState>('GET', '/api/state'); setToken(state.csrf); return state; },
  runs: (project?: string): Promise<{ runs: RunRow[] }> => request('GET', `/api/runs${project ? `?project=${encodeURIComponent(project)}` : ''}`),
  run: (id: number): Promise<RunDetail> => request('GET', `/api/runs/${id}`),
  pickFolder: (start: string, title: string): Promise<{ supported: boolean; path?: string | null }> => request('POST', '/api/pick-folder', { start, title }),
  bench: (): Promise<{ summaries: BenchSummary[] }> => request('GET', '/api/bench'),
  usage: (): Promise<UsageInfo> => request('GET', '/api/usage'),
  folder: (path: string): Promise<FolderListing> => request('GET', `/api/fs?path=${encodeURIComponent(path)}`),
  project: (path: string): Promise<ProjectInfo> => request('GET', `/api/project?path=${encodeURIComponent(path)}`),
  start: (body: StartRequest): Promise<{ runId: number }> => request('POST', '/api/runs', body),
  cancel: (): Promise<{ ok: boolean }> => request('POST', '/api/runs/active/cancel', {}),
  answer: (answer: string): Promise<{ ok: boolean }> => request('POST', '/api/runs/active/answer', { answer }),
  files: (project: string): Promise<ProjectFiles> => request('GET', `/api/project/files?path=${encodeURIComponent(project)}`),
  saveFile: (body: { project: string; kind: 'config' | 'role' | 'skill'; id?: string; text?: string; remove?: boolean }): Promise<SaveReply> => request('POST', '/api/project/files', body),
  initProject: (project: string): Promise<{ written: string[]; rationale: string[] }> => request('POST', '/api/project/init', { project }),
  addMemory: (project: string, fact: string): Promise<{ ok: boolean }> => request('POST', '/api/project/memory', { project, fact }),
  deleteHistory: (body: { project: string } | { benchWorkspaces: true }): Promise<{ deleted: number }> => request('POST', '/api/history/delete', body),
  feedback: (body: { runId: number; rating: 1 | -1 | 0; cause?: FeedbackCause | null; target?: string | null; note?: string | null }): Promise<{ feedback: Feedback | null }> => request('POST', '/api/feedback', body),
  models: (): Promise<ModelChoices> => request('GET', '/api/models'),
  quality: (project?: string): Promise<{ rows: QualityRow[]; summary: QualitySummary }> => request('GET', `/api/quality${project ? `?project=${encodeURIComponent(project)}` : ''}`),
  qualityExportUrl: (format: 'csv' | 'json', project?: string): string => `/api/quality/export?format=${format}${project ? `&project=${encodeURIComponent(project)}` : ''}`,
  revert: (id: number, yes: boolean): Promise<RevertPlan> => request('POST', `/api/runs/${id}/revert`, { yes }),
};

export interface StreamHandlers {
  onEvent(event: StoredEvent): void;
  onPending(pending: Pending | null): void;
  onDone(status: string): void;
  onError(): void;
}

/** Follows a run over SSE. EventSource reconnects by itself and resends the last event id, so no event is shown twice or missed. */
export function followRun(id: number, handlers: StreamHandlers): () => void {
  const source = new EventSource(`/api/runs/${id}/events`);
  source.addEventListener('run-event', message => handlers.onEvent(JSON.parse((message as MessageEvent<string>).data) as StoredEvent));
  source.addEventListener('pending', message => handlers.onPending(JSON.parse((message as MessageEvent<string>).data) as Pending | null));
  source.addEventListener('done', message => { handlers.onDone((JSON.parse((message as MessageEvent<string>).data) as { status: string }).status); source.close(); });
  source.onerror = () => handlers.onError();
  return () => source.close();
}
