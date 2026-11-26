// The project's development plan: a checklist the harness keeps in .agent-desk/todo.json. A design session drafts
// it, the user edits it, runs started from an item mark it "doing", and a completed run marks it done. A copy is
// written to the vault as a note so the roles (and the user in Obsidian) can read where the project stands.

import fs from 'node:fs';
import path from 'node:path';

export type TodoStatus = 'todo' | 'doing' | 'done';

export interface TodoItem {
  id: string;
  title: string;
  /** What "done" means for this item: the acceptance condition. */
  detail?: string;
  /** The request to send when the item is started. */
  request: string;
  phase?: string;
  status: TodoStatus;
  /** Runs started from this item, oldest first. */
  runs: number[];
  /** Why the item was already done when the plan was drafted (file:line or a note). */
  evidence?: string;
}

export interface TodoPlan {
  goal: string;
  items: TodoItem[];
  updatedAt: string | null;
}

export interface NewTodo { title: string; request: string; detail?: string; phase?: string; status?: TodoStatus; evidence?: string }

const MAX_ITEMS = 200;
const STATUSES: readonly TodoStatus[] = ['todo', 'doing', 'done'];

export const todoPath = (project: string): string => path.join(project, '.agent-desk', 'todo.json');

const clean = (value: unknown, max: number): string => (typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim().slice(0, max) : '');

export function loadTodo(project: string): TodoPlan {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(todoPath(project), 'utf8')); } catch { return { goal: '', items: [], updatedAt: null }; }
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const items: TodoItem[] = [];
  for (const entry of Array.isArray(record.items) ? record.items : []) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const id = clean(item.id, 20);
    const title = clean(item.title, 300);
    if (!id || !title || items.some(existing => existing.id === id)) continue;
    const status = STATUSES.includes(item.status as TodoStatus) ? item.status as TodoStatus : 'todo';
    const detail = clean(item.detail, 2000);
    const phase = clean(item.phase, 120);
    const evidence = clean(item.evidence, 500);
    items.push({ id, title, request: clean(item.request, 4000) || title, status, runs: Array.isArray(item.runs) ? item.runs.filter((run): run is number => Number.isInteger(run)) : [], ...(detail ? { detail } : {}), ...(phase ? { phase } : {}), ...(evidence ? { evidence } : {}) });
  }
  return { goal: clean(record.goal, 2000), items, updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null };
}

export function saveTodo(project: string, plan: TodoPlan): TodoPlan {
  const next: TodoPlan = { goal: plan.goal, items: plan.items.slice(0, MAX_ITEMS), updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(todoPath(project)), { recursive: true });
  fs.writeFileSync(todoPath(project), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function nextId(items: readonly TodoItem[]): () => string {
  let n = items.reduce((max, item) => Math.max(max, Number(/^T(\d+)$/.exec(item.id)?.[1] ?? 0)), 0);
  return () => `T${++n}`;
}

function toItem(entry: NewTodo, id: string): TodoItem | null {
  const title = clean(entry.title, 300);
  if (!title) return null;
  const detail = clean(entry.detail, 2000);
  const phase = clean(entry.phase, 120);
  const evidence = clean(entry.evidence, 500);
  return { id, title, request: clean(entry.request, 4000) || title, status: STATUSES.includes(entry.status as TodoStatus) ? entry.status as TodoStatus : 'todo', runs: [], ...(detail ? { detail } : {}), ...(phase ? { phase } : {}), ...(evidence ? { evidence } : {}) };
}

export function addTodoItems(project: string, entries: readonly NewTodo[]): TodoPlan {
  const plan = loadTodo(project);
  const id = nextId(plan.items);
  for (const entry of entries) {
    if (plan.items.some(item => item.title === clean(entry.title, 300))) continue;
    const item = toItem(entry, id());
    if (item) plan.items.push(item);
  }
  return saveTodo(project, plan);
}

/**
 * A new design replaces the list. Items with the same title keep their status and runs, so a re-design does not
 * forget what was done; items the user had and the new design dropped are kept at the end unless they were never
 * started, so finished work does not disappear.
 */
export function replaceTodo(project: string, goal: string, entries: readonly NewTodo[]): TodoPlan {
  const old = loadTodo(project);
  const id = nextId(old.items);
  const items: TodoItem[] = [];
  for (const entry of entries) {
    const title = clean(entry.title, 300);
    if (!title || items.some(item => item.title === title)) continue;
    const before = old.items.find(item => item.title === title);
    const fresh = toItem(entry, before?.id ?? id());
    if (!fresh) continue;
    items.push(before ? { ...fresh, status: before.status === 'todo' ? fresh.status : before.status, runs: before.runs } : fresh);
  }
  for (const item of old.items) if (!items.some(kept => kept.title === item.title) && (item.status !== 'todo' || item.runs.length)) items.push(item);
  return saveTodo(project, { goal: clean(goal, 2000) || old.goal, items, updatedAt: null });
}

export type TodoEdit = { id: string; status?: TodoStatus; title?: string; detail?: string; request?: string; phase?: string; remove?: boolean };

export function editTodo(project: string, edit: TodoEdit): TodoPlan {
  const plan = loadTodo(project);
  const index = plan.items.findIndex(item => item.id === edit.id);
  if (index < 0) throw new Error(`no todo item "${edit.id}"`);
  if (edit.remove) plan.items.splice(index, 1);
  else {
    const item = { ...plan.items[index]! };
    if (edit.status && STATUSES.includes(edit.status)) item.status = edit.status;
    if (edit.title !== undefined && clean(edit.title, 300)) item.title = clean(edit.title, 300);
    if (edit.request !== undefined) item.request = clean(edit.request, 4000) || item.title;
    if (edit.detail !== undefined) { const detail = clean(edit.detail, 2000); if (detail) item.detail = detail; else delete item.detail; }
    if (edit.phase !== undefined) { const phase = clean(edit.phase, 120); if (phase) item.phase = phase; else delete item.phase; }
    plan.items[index] = item;
  }
  return saveTodo(project, plan);
}

/** A run started from an item: the item is in progress and remembers the run. */
export function linkTodoRun(project: string, id: string, runId: number): TodoPlan | null {
  const plan = loadTodo(project);
  const item = plan.items.find(entry => entry.id === id);
  if (!item) return null;
  if (!item.runs.includes(runId)) item.runs.push(runId);
  if (item.status !== 'done') item.status = 'doing';
  return saveTodo(project, plan);
}

/** A run finished: a completed run marks its item done. Anything else leaves it in progress for the user to judge. */
export function finishTodoRun(project: string, runId: number, status: string): TodoItem | null {
  if (status !== 'completed') return null;
  const plan = loadTodo(project);
  const item = plan.items.find(entry => entry.runs.includes(runId) && entry.status === 'doing');
  if (!item) return null;
  item.status = 'done';
  saveTodo(project, plan);
  return item;
}

/** The vault copy: the plan as Markdown checkboxes grouped by phase. */
export function todoNoteText(plan: TodoPlan, lang: 'en' | 'ko'): { path: string; text: string } {
  const ko = lang === 'ko';
  const lines = [
    '---', 'type: spec', 'generated: agent-desk', '---',
    `# ${ko ? '개발 계획' : 'Development plan'}`, '',
    `_${ko ? 'Agent Desk의 할 일 목록에서 자동으로 만들어집니다. 수정은 할 일 목록에서 하세요.' : 'Generated from the Agent Desk to-do list; edit it there.'}_`, '',
  ];
  if (plan.goal) lines.push(`${ko ? '목표' : 'Goal'}: ${plan.goal}`, '');
  const done = plan.items.filter(item => item.status === 'done').length;
  lines.push(`${ko ? '진행' : 'Progress'}: ${done}/${plan.items.length}`, '');
  const phases = [...new Set(plan.items.map(item => item.phase ?? ''))];
  for (const phase of phases) {
    if (phase) lines.push(`## ${phase}`, '');
    for (const item of plan.items.filter(entry => (entry.phase ?? '') === phase)) {
      const mark = item.status === 'done' ? 'x' : item.status === 'doing' ? '/' : ' ';
      lines.push(`- [${mark}] ${item.id} ${item.title}${item.detail ? ` — ${item.detail}` : ''}`);
    }
    lines.push('');
  }
  return { path: `specs/${ko ? '개발 계획' : 'Development plan'}.md`, text: `${lines.join('\n').trimEnd()}\n` };
}
