import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appWith, load, tempFile } from './harness.mjs';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-03-01T10:00:00Z');
const at = ms => ({ now: () => new Date(ms) });
const add = (app, title) => app.call('POST', '/api/todos', { title });

test('delete moves a todo to the trash; restore brings it back unchanged', async t => {
  const app = await appWith(t);
  const a = (await add(app, 'a')).body;
  await app.call('PATCH', `/api/todos/${a.id}`, { done: true });
  const before = (await app.call('GET', '/api/todos')).body[0];
  const removed = await app.call('DELETE', `/api/todos/${a.id}`);
  assert.equal(removed.status, 204);
  assert.deepEqual((await app.call('GET', '/api/todos')).body, []);
  assert.equal((await app.call('DELETE', `/api/todos/${a.id}`)).status, 404, 'already trashed');
  assert.equal((await app.call('PATCH', `/api/todos/${a.id}`, { title: 'z' })).status, 404, 'trashed todos cannot be edited');
  const trash = (await app.call('GET', '/api/trash')).body;
  assert.equal(trash.length, 1);
  assert.equal(typeof trash[0].deletedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(trash[0].deletedAt)));
  const restored = await app.call('POST', `/api/todos/${a.id}/restore`);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.deletedAt, null);
  assert.deepEqual({ ...restored.body }, { ...before, deletedAt: null });
  assert.equal((await app.call('GET', '/api/todos')).body.length, 1);
  assert.deepEqual((await app.call('GET', '/api/trash')).body, []);
  assert.equal((await app.call('POST', `/api/todos/${a.id}/restore`)).status, 404, 'not in trash anymore');
  assert.equal((await app.call('POST', '/api/todos/999/restore')).status, 404);
  assert.equal((await app.call('DELETE', '/api/todos/999')).status, 404);
});

test('trash is ordered by deletedAt descending, then id descending', async t => {
  let clock = T0;
  const { openDb } = await load('src/db.mjs');
  const db = openDb(tempFile(), { now: () => new Date(clock) });
  const app = await appWith(t, { db });
  for (const title of ['a', 'b', 'c', 'd']) await add(app, title);
  await app.call('DELETE', '/api/todos/2');
  clock += 1000;
  await app.call('DELETE', '/api/todos/1');
  await app.call('DELETE', '/api/todos/3');
  const ids = (await app.call('GET', '/api/trash')).body.map(todo => todo.id);
  assert.deepEqual(ids, [3, 1, 2]);
});

test('emptying the trash purges permanently and ids are never reused', async t => {
  const app = await appWith(t);
  for (const title of ['a', 'b', 'c']) await add(app, title);
  await app.call('DELETE', '/api/todos/2');
  await app.call('DELETE', '/api/todos/3');
  const purged = await app.call('DELETE', '/api/trash');
  assert.equal(purged.status, 200);
  assert.deepEqual(purged.body, { purged: 2 });
  assert.deepEqual((await app.call('DELETE', '/api/trash')).body, { purged: 0 });
  assert.equal((await app.call('POST', '/api/todos/2/restore')).status, 404);
  assert.equal((await add(app, 'd')).body.id, 4);
  assert.deepEqual((await app.call('GET', '/api/todos')).body.map(todo => todo.id), [1, 4]);
});

test('trash persists across restarts and is purged after more than 30 days', async () => {
  const { openDb } = await load('src/db.mjs');
  const file = tempFile();
  const first = openDb(file, at(T0));
  first.insert({ title: 'old' });
  first.insert({ title: 'recent' });
  first.insert({ title: 'live' });
  assert.equal(first.trash(1), true);
  const later = openDb(file, at(T0 + 20 * DAY));
  assert.equal(later.trash(2), true);
  assert.deepEqual(later.list().map(todo => todo.title), ['live']);
  const day29 = openDb(file, at(T0 + 29 * DAY));
  assert.deepEqual(day29.listTrash().map(todo => todo.title).sort(), ['old', 'recent'], 'kept at 29 days');
  const day31 = openDb(file, at(T0 + 31 * DAY));
  assert.deepEqual(day31.listTrash().map(todo => todo.title), ['recent'], 'old purged after 30 days, recent kept');
  assert.deepEqual(day31.list().map(todo => todo.title), ['live']);
  assert.equal(day31.insert({ title: 'next' }).id, 4, 'purged ids are not reused');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(onDisk.todos.every(todo => !todo.title.includes('old')), 'purged todo is gone from the file');
});

test('migrates schemaVersion 1 data', async () => {
  const { openDb } = await load('src/db.mjs');
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, nextId: 3, todos: [{ id: 1, title: 'a', done: false, createdAt: 'x' }, { id: 2, title: 'b', done: false, createdAt: 'y' }] }));
  const db = openDb(file);
  assert.deepEqual(db.list().map(todo => todo.deletedAt), [null, null]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, 2);
  assert.equal(db.trash(1), true);
  assert.deepEqual(openDb(file).list().map(todo => todo.id), [2]);
});
