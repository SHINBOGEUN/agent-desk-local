// Thin client for the local Agent Desk server. Every POST carries the per-start token from /api/state.

import type { StoredEvent } from './model.ts';

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
export interface ServerState { csrf: string; active: ActiveRun | null }
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
}

export interface RunDetail {
  run: RunRow;
  steps: { step: string; role: string; ok: boolean | null; detail: string | null }[];
  usage: { stepId: string; turn: number; usage: { totalTokens: number } }[];
  usageTotal: number;
  report: RunReport | null;
}
export interface ProjectConfigView { runtimes?: { primary?: string; review?: string }; verify?: string[]; review?: string; skills?: string[]; limits?: { redo?: number; tokens?: number; minutes?: number; codexUsagePercent?: number } }
export interface ProjectInfo { config: ProjectConfigView; errors: string[]; warnings: string[]; memory: string[]; skills: { id: string; description: string }[]; skillFindings: { level: string; skill: string; message: string }[] }
export interface LimitWindowView { kind: string; windowDurationMins: number | null; usedPercent: number; remainingPercent: number; resetsAt: number | null }
export interface UsageInfo { limits: { windows: LimitWindowView[]; checkedAt: string } | null; reason?: string }
export interface StartRequest { project: string; request: string; runtime?: 'codex' | 'claude'; review?: 'always' | 'auto' | 'never'; verify?: string[] }
export interface RevertPlan { applied: boolean; restore: string[]; remove: string[] }

export interface FolderEntry { name: string; path: string; isProject: boolean }
export interface FolderListing { path: string; parent: string | null; home: string; entries: FolderEntry[] }

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
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
  if (!response.ok) throw new ApiError(response.status, (data as { error?: string }).error ?? `request failed (${response.status})`);
  return data as T;
}

export const api = {
  state: async (): Promise<ServerState> => { const state = await request<ServerState>('GET', '/api/state'); setToken(state.csrf); return state; },
  runs: (project?: string): Promise<{ runs: RunRow[] }> => request('GET', `/api/runs${project ? `?project=${encodeURIComponent(project)}` : ''}`),
  run: (id: number): Promise<RunDetail> => request('GET', `/api/runs/${id}`),
  pickFolder: (start: string, title: string): Promise<{ supported: boolean; path?: string | null }> => request('POST', '/api/pick-folder', { start, title }),
  usage: (): Promise<UsageInfo> => request('GET', '/api/usage'),
  folder: (path: string): Promise<FolderListing> => request('GET', `/api/fs?path=${encodeURIComponent(path)}`),
  project: (path: string): Promise<ProjectInfo> => request('GET', `/api/project?path=${encodeURIComponent(path)}`),
  start: (body: StartRequest): Promise<{ runId: number }> => request('POST', '/api/runs', body),
  cancel: (): Promise<{ ok: boolean }> => request('POST', '/api/runs/active/cancel', {}),
  answer: (answer: string): Promise<{ ok: boolean }> => request('POST', '/api/runs/active/answer', { answer }),
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
