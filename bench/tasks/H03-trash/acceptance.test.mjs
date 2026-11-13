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

test('trash persists across restarts and is purged after more than 30 days', async t => {
  const { openDb } = await load('src/db.mjs');
  const file = tempFile();
  const first = await appWith(t, { db: openDb(file, at(T0)) });
  for (const title of ['old', 'recent', 'live']) await add(first, title);
  assert.equal((await first.call('DELETE', '/api/todos/1')).status, 204);
  const later = await appWith(t, { db: openDb(file, at(T0 + 20 * DAY)) });
  assert.equal((await later.call('DELETE', '/api/todos/2')).status, 204);
  assert.deepEqual((await later.call('GET', '/api/todos')).body.map(todo => todo.title), ['live']);
  const day29 = await appWith(t, { db: openDb(file, at(T0 + 29 * DAY)) });
  assert.deepEqual((await day29.call('GET', '/api/trash')).body.map(todo => todo.title).sort(), ['old', 'recent'], 'kept at 29 days');
  const day31 = await appWith(t, { db: openDb(file, at(T0 + 31 * DAY)) });
  assert.deepEqual((await day31.call('GET', '/api/trash')).body.map(todo => todo.title), ['recent'], 'old purged after 30 days, recent kept');
  assert.deepEqual((await day31.call('GET', '/api/todos')).body.map(todo => todo.title), ['live']);
  assert.equal((await add(day31, 'next')).body.id, 4, 'purged ids are not reused');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(onDisk.todos.every(todo => todo.title !== 'old'), 'purged todo is gone from the file');
});

test('migrates schemaVersion 1 data and keeps the trash across restarts', async t => {
  const { openDb } = await load('src/db.mjs');
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, nextId: 3, todos: [{ id: 1, title: 'a', done: false, createdAt: 'x' }, { id: 2, title: 'b', done: false, createdAt: 'y' }] }));
  const app = await appWith(t, { db: openDb(file) });
  const listed = (await app.call('GET', '/api/todos')).body;
  assert.deepEqual(listed.map(todo => todo.deletedAt), [null, null]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, 2);
  assert.equal((await app.call('DELETE', '/api/todos/1')).status, 204);
  const reopened = await appWith(t, { db: openDb(file) });
  assert.deepEqual((await reopened.call('GET', '/api/todos')).body.map(todo => todo.id), [2]);
  assert.deepEqual((await reopened.call('GET', '/api/trash')).body.map(todo => todo.id), [1]);
});
