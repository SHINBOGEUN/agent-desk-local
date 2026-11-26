// Design: one read-only model session reads the project (its goal and planning documents, notes, the code) and
// drafts a development plan as an ordered checklist. Each item is one request the harness can run. For an
// existing project the items that are already built come back marked done, with the evidence. Nothing is written
// here; the user reviews the draft and saves it (replaceTodo).

import type { HarnessTools, Runtime } from '#core';
import { platformNote } from '#orchestrator';
import type { NewTodo } from '#project';

export interface DesignDraft { goal: string; items: NewTodo[] }
export interface DesignResult { ok: boolean; draft?: DesignDraft; error?: string; raw?: string }

const MAX_ITEMS = 40;

function instructions(language: 'en' | 'ko'): string {
  return [
    'Role: you design the development plan of this project for Agent Desk, a harness that builds software one request at a time (a lead plans each request, a builder changes files, a verifier reviews).',
    'Read the project first: the goal and planning documents (README, docs/, AGENTS.md, CLAUDE.md, the project notes under .agent-desk/notes (specs/ and decisions/) if any), then the code, narrowly, to see what is already built.',
    'The plan is an ordered checklist grouped into phases (for example foundation, core flow, sharing, polish). Each item is one task a builder can finish in one request: small enough to review, large enough to matter. Order items so each one builds on the earlier ones.',
    'Stay within the goal the documents and the user state. Do not add features nobody asked for; a missing decision becomes an item of its own ("decide ...").',
    'For a project that already has code, mark items that are already built as done and give the evidence (a file:line or a document line). Unfinished or unverified work stays not done.',
    'Do not change any file.',
    platformNote(),
    language === 'ko' ? 'Language: write the goal, phases, titles, details and requests in Korean, in the polite 합니다 style. Keep code, identifiers, paths and commands as they are.' : '',
  ].filter(Boolean).join('\n');
}

function prompt(brief: string): string {
  return `${brief ? `What the user wants (their own words; this decides the direction):\n${brief}\n\n` : ''}Design the development plan.

Reply with JSON only, no other text:
{"goal": "the product goal in one or two sentences",
 "phases": [{"name": "phase name", "items": [{"title": "a few words", "detail": "what done means: the acceptance condition", "request": "the request to send to have it built, concrete, naming the screens, files or notes it concerns", "done": false, "evidence": "only when done: file:line or document line"}]}]}
At most 6 phases and ${MAX_ITEMS} items in all.`;
}

/** Reads the model's JSON reply into a plan draft; malformed items are dropped. */
export function parseDesign(reply: string): DesignDraft | null {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try { raw = JSON.parse(reply.slice(start, end + 1)); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const items: NewTodo[] = [];
  for (const phase of Array.isArray(record.phases) ? record.phases : []) {
    if (!phase || typeof phase !== 'object') continue;
    const name = text((phase as Record<string, unknown>).name);
    for (const entry of Array.isArray((phase as Record<string, unknown>).items) ? (phase as Record<string, unknown>).items as unknown[] : []) {
      if (!entry || typeof entry !== 'object' || items.length >= MAX_ITEMS) continue;
      const item = entry as Record<string, unknown>;
      const title = text(item.title);
      if (!title) continue;
      const detail = text(item.detail);
      const evidence = text(item.evidence);
      items.push({ title, request: text(item.request) || title, ...(detail ? { detail } : {}), ...(name ? { phase: name } : {}), status: item.done === true ? 'done' : 'todo', ...(item.done === true && evidence ? { evidence } : {}) });
    }
  }
  if (!items.length) return null;
  return { goal: text(record.goal), items };
}

const noTools: HarnessTools = {
  submitReport: async () => ({ ok: false, message: 'Do not submit a report here. Reply with the JSON plan as your final message.' }),
  requestUserInput: async () => 'Decide from what you read; the user reviews the plan before it is kept.',
};

export async function runDesign(options: { project: string; runtime: Runtime; brief?: string; language?: 'en' | 'ko'; signal?: AbortSignal }): Promise<DesignResult> {
  const session = await options.runtime.startSession({ role: 'lead', cwd: options.project, access: 'read-only', instructions: instructions(options.language ?? 'en'), skills: [], tools: noTools, effort: 'medium' });
  let reply = '';
  let failure = '';
  try {
    for await (const event of session.runTurn({ text: prompt((options.brief ?? '').trim().slice(0, 4000)) }, options.signal ?? new AbortController().signal)) {
      if (event.type === 'message' && typeof event.text === 'string') reply = event.final ? event.text : reply || event.text;
      if (event.type === 'turn_end' && event.status === 'failed') failure = event.error ?? 'the model turn failed';
    }
  } finally {
    await session.close().catch(() => {});
    await (options.runtime as Runtime & { close?: () => Promise<void> }).close?.().catch(() => {});
  }
  const draft = parseDesign(reply);
  if (draft) return { ok: true, draft };
  return { ok: false, error: failure || 'The reply could not be read as a plan.', ...(reply ? { raw: reply.slice(0, 4000) } : {}) };
}
