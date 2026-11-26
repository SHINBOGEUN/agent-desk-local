import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { addTodoItems, editTodo, finishTodoRun, linkTodoRun, loadTodo, replaceTodo, todoNoteText, todoPath } from '#project';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'todo-'));

test('a new project has an empty plan; items get ids and default to todo', () => {
  const project = tmp();
  assert.deepEqual(loadTodo(project), { goal: '', items: [], updatedAt: null });
  const plan = addTodoItems(project, [{ title: 'Login screen', request: 'Build the login screen' }, { title: '' , request: 'x' }, { title: 'Login screen', request: 'again' }]);
  assert.deepEqual(plan.items.map(item => [item.id, item.title, item.status]), [['T1', 'Login screen', 'todo']]);
  assert.ok(fs.existsSync(todoPath(project)));
});

test('a run started from an item marks it doing; a completed run marks it done, anything else leaves it', () => {
  const project = tmp();
  addTodoItems(project, [{ title: 'A', request: 'do A' }, { title: 'B', request: 'do B' }]);
  linkTodoRun(project, 'T1', 7);
  assert.equal(loadTodo(project).items[0]!.status, 'doing');
  assert.equal(finishTodoRun(project, 7, 'needs_review'), null);
  assert.equal(loadTodo(project).items[0]!.status, 'doing');
  linkTodoRun(project, 'T1', 8);
  assert.equal(finishTodoRun(project, 8, 'completed')?.id, 'T1');
  assert.deepEqual(loadTodo(project).items[0]!.runs, [7, 8]);
  assert.equal(loadTodo(project).items[0]!.status, 'done');
  assert.equal(linkTodoRun(project, 'T9', 9), null);
});

test('a re-design keeps the status and runs of items with the same title and keeps started items it dropped', () => {
  const project = tmp();
  addTodoItems(project, [{ title: 'A', request: 'do A' }, { title: 'B', request: 'do B' }, { title: 'C', request: 'do C' }]);
  linkTodoRun(project, 'T1', 3); finishTodoRun(project, 3, 'completed');
  linkTodoRun(project, 'T2', 4);
  const plan = replaceTodo(project, 'Ship v1', [{ title: 'A', request: 'do A better', phase: 'Core' }, { title: 'D', request: 'do D', status: 'done', evidence: 'src/d.ts:1' }]);
  assert.equal(plan.goal, 'Ship v1');
  assert.deepEqual(plan.items.map(item => [item.id, item.title, item.status]), [['T1', 'A', 'done'], ['T4', 'D', 'done'], ['T2', 'B', 'doing']]);
  assert.equal(plan.items[0]!.request, 'do A better');
  assert.deepEqual(plan.items[0]!.runs, [3]);
});

test('edit changes fields, toggles status and removes; the note groups items by phase with checkboxes', () => {
  const project = tmp();
  replaceTodo(project, 'Goal', [{ title: 'A', request: 'do A', phase: 'Core', detail: 'A works' }, { title: 'B', request: 'do B', phase: 'Polish' }]);
  editTodo(project, { id: 'T1', status: 'done' });
  editTodo(project, { id: 'T2', title: 'B2', detail: '' });
  let plan = loadTodo(project);
  assert.equal(plan.items[1]!.title, 'B2');
  const note = todoNoteText(plan, 'ko');
  assert.equal(note.path, 'specs/개발 계획.md');
  assert.match(note.text, /진행: 1\/2/);
  assert.match(note.text, /## Core\n\n- \[x\] T1 A — A works\n\n## Polish\n\n- \[ \] T2 B2\n/);
  plan = editTodo(project, { id: 'T1', remove: true });
  assert.deepEqual(plan.items.map(item => item.id), ['T2']);
  assert.throws(() => editTodo(project, { id: 'T1', status: 'done' }), /no todo item/);
});
