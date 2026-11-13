import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appWith, load, tempFile } from './harness.mjs';

const siblings = file => fs.readdirSync(path.dirname(file));

test('saves atomically and leaves no temporary files', async () => {
  const { openDb } = await load('src/db.mjs');
  const file = tempFile();
  const db = openDb(file);
  for (let index = 0; index < 20; index++) db.insert({ title: `t${index}` });
  db.update(1, { done: true });
  db.remove(2);
  assert.deepEqual(siblings(file).filter(name => name.endsWith('.tmp')), []);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.todos.length, 19);
  assert.equal(db.recoveredFrom, null);
});

test('recovers from unreadable or malformed files without losing the original', async () => {
  const { openDb, SCHEMA_VERSION } = await load('src/db.mjs');
  for (const content of ['not json {', '', '[1,2,3]', '{"todos": "nope"}', 'null', '{"schemaVersion":1,"nextId":1}']) {
    const file = tempFile();
    fs.writeFileSync(file, content);
    const db = openDb(file);
    assert.deepEqual(db.list(), [], JSON.stringify(content));
    assert.equal(typeof db.recoveredFrom, 'string', JSON.stringify(content));
    assert.ok(path.basename(db.recoveredFrom).startsWith(`${path.basename(file)}.corrupt-`), db.recoveredFrom);
    assert.equal(path.dirname(db.recoveredFrom), path.dirname(file));
    assert.equal(fs.readFileSync(db.recoveredFrom, 'utf8'), content, 'original content preserved');
    const fresh = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(fresh.schemaVersion, SCHEMA_VERSION);
    assert.equal(fresh.nextId, 1);
    assert.deepEqual(fresh.todos, []);
    assert.equal(db.insert({ title: 'works' }).id, 1);
  }
});

test('refuses to touch data written by a newer version', async () => {
  const { openDb, SCHEMA_VERSION } = await load('src/db.mjs');
  const file = tempFile();
  const content = JSON.stringify({ schemaVersion: SCHEMA_VERSION + 50, nextId: 2, todos: [{ id: 1, title: 'future' }] });
  fs.writeFileSync(file, content);
  assert.throws(() => openDb(file), error => /newer/i.test(error.message));
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  assert.deepEqual(siblings(file), [path.basename(file)], 'no backup or temp files created');
});

test('repairs a stale nextId', async () => {
  const { openDb } = await load('src/db.mjs');
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, nextId: 2, todos: [{ id: 1, title: 'a', done: false, createdAt: 'x' }, { id: 7, title: 'b', done: false, createdAt: 'y' }, { id: 3, title: 'c', done: false, createdAt: 'z' }] }));
  const db = openDb(file);
  assert.equal(db.recoveredFrom, null);
  assert.equal(db.insert({ title: 'new' }).id, 8);
  assert.deepEqual(db.list().map(todo => todo.id), [1, 7, 3, 8]);
  const healthy = tempFile();
  fs.writeFileSync(healthy, JSON.stringify({ schemaVersion: 1, nextId: 20, todos: [{ id: 5, title: 'a', done: false, createdAt: 'x' }] }));
  assert.equal(openDb(healthy).insert({ title: 'n' }).id, 20, 'a healthy larger nextId is kept');
});

test('rejects request bodies over 100KB and accepts those just under', async t => {
  const app = await appWith(t);
  const huge = await app.call('POST', '/api/todos', { title: 'x'.repeat(200 * 1024) });
  assert.equal(huge.status, 413);
  assert.equal(typeof huge.body?.error, 'string');
  assert.equal(app.db.list().length, 0);
  const overhead = JSON.stringify({ title: '' }).length;
  const edge = await app.call('POST', '/api/todos', { title: 'y'.repeat(100 * 1024 - overhead) });
  assert.equal(edge.status, 201, 'exactly 100KB is allowed');
  const over = await app.call('POST', '/api/todos', { title: 'y'.repeat(100 * 1024 - overhead + 1) });
  assert.equal(over.status, 413, 'one byte over is rejected');
  assert.equal(app.db.list().length, 1);
  const patched = await app.call('PATCH', '/api/todos/1', { title: 'z'.repeat(150 * 1024) });
  assert.equal(patched.status, 413);
  assert.equal(app.db.get(1).title.startsWith('y'), true);
});
