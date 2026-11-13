import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appWith, load, read, tempFile } from './harness.mjs';

const clock = iso => ({ now: () => new Date(iso) });
const add = (app, body) => app.call('POST', '/api/todos', body);

test('migrates schemaVersion 1 data', async () => {
  const { openDb } = await load('src/db.mjs');
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, nextId: 2, todos: [{ id: 1, title: 'a', done: false, createdAt: 'x' }] }));
  const db = openDb(file);
  assert.equal(db.list()[0].dueDate, null);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, 2);
});

test('accepts only real calendar dates and null', async t => {
  const app = await appWith(t);
  for (const dueDate of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-3-5', '2026/03/05', 20260305, '', '2026-03-05T00:00:00Z']) {
    const response = await add(app, { title: 'x', dueDate });
    assert.equal(response.status, 400, JSON.stringify(dueDate));
    assert.equal(typeof response.body?.error, 'string');
  }
  assert.equal(app.db.list().length, 0);
  assert.equal((await add(app, { title: 'leap', dueDate: '2028-02-29' })).status, 201);
  assert.equal((await add(app, { title: 'not leap', dueDate: '2027-02-29' })).status, 400);
  const plain = await add(app, { title: 'plain' });
  assert.equal(plain.body.dueDate, null);
  const set = await app.call('PATCH', `/api/todos/${plain.body.id}`, { dueDate: '2030-01-01' });
  assert.equal(set.body.dueDate, '2030-01-01');
  const cleared = await app.call('PATCH', `/api/todos/${plain.body.id}`, { dueDate: null });
  assert.equal(cleared.body.dueDate, null);
});

test('an invalid patch changes nothing', async t => {
  const app = await appWith(t);
  const todo = (await add(app, { title: 'keep', dueDate: '2030-01-01' })).body;
  const rejected = await app.call('PATCH', `/api/todos/${todo.id}`, { title: 'changed', done: true, dueDate: '2030-02-31' });
  assert.equal(rejected.status, 400);
  const after = app.db.get(todo.id);
  assert.deepEqual([after.title, after.done, after.dueDate], ['keep', false, '2030-01-01']);
});

test('overdue uses the injected clock (UTC date), ignores done todos and is not stored', async t => {
  const { openDb } = await load('src/db.mjs');
  const file = tempFile();
  const db = openDb(file, clock('2026-03-10T23:30:00Z'));
  const app = await appWith(t, { db });
  const ids = {};
  for (const [name, dueDate] of [['past', '2026-03-09'], ['today', '2026-03-10'], ['future', '2026-03-11'], ['none', null], ['donePast', '2026-01-01']]) {
    ids[name] = (await add(app, { title: name, ...(dueDate ? { dueDate } : {}) })).body.id;
  }
  await app.call('PATCH', `/api/todos/${ids.donePast}`, { done: true });
  const overdue = Object.fromEntries((await app.call('GET', '/api/todos')).body.map(todo => [todo.title, todo.overdue]));
  assert.deepEqual(overdue, { past: true, today: false, future: false, none: false, donePast: false });
  const only = await app.call('GET', '/api/todos?overdue=true');
  assert.deepEqual(only.body.map(todo => todo.title), ['past']);
  const finished = await app.call('PATCH', `/api/todos/${ids.past}`, { done: true });
  assert.equal(finished.body.overdue, false);
  assert.equal((await app.call('GET', '/api/todos?overdue=true')).body.length, 0);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /overdue/);
  const created = await add(app, { title: 'late', dueDate: '2000-01-01' });
  assert.equal(created.body.overdue, true);
});

test('sort=due orders by date, nulls last, ties by id', async t => {
  const app = await appWith(t);
  for (const [title, dueDate] of [['c', '2026-05-01'], ['n1', null], ['a', '2026-01-01'], ['b', '2026-05-01'], ['n2', null]]) await add(app, { title, ...(dueDate ? { dueDate } : {}) });
  const sorted = await app.call('GET', '/api/todos?sort=due');
  assert.deepEqual(sorted.body.map(todo => todo.title), ['a', 'c', 'b', 'n1', 'n2']);
  assert.equal((await app.call('GET', '/api/todos?sort=title')).status, 400);
  assert.deepEqual((await app.call('GET', '/api/todos')).body.map(todo => todo.title), ['c', 'n1', 'a', 'b', 'n2']);
});

test('page and renderer show due dates and overdue state', async () => {
  const page = read('public/index.html');
  assert.match(page, /name=["']dueDate["']/);
  assert.match(page, /type=["']date["']/);
  assert.match(read('public/app.js'), /dueDate/);
  const { renderTodoList } = await load('public/render.js');
  const html = renderTodoList([{ id: 1, title: 't', done: false, dueDate: '2020-01-01', overdue: true }, { id: 2, title: 'u', done: true, dueDate: '2030-01-01', overdue: false }]);
  assert.match(html, /<li data-id="1" class="[^"]*\boverdue\b[^"]*"/);
  assert.doesNotMatch(html, /<li data-id="2" class="[^"]*overdue/);
  assert.match(html, /<span class="due">2020-01-01<\/span>/);
  assert.doesNotThrow(() => renderTodoList([{ id: 3, title: 'old', done: false }]));
});
