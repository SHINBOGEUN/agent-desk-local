import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appWith, load, tempFile } from './harness.mjs';

test('version 1 data is migrated to version 2 with normal priority', async () => {
  const { openDb, SCHEMA_VERSION } = await load('src/db.mjs');
  assert.equal(SCHEMA_VERSION, 2);
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, nextId: 3, todos: [
    { id: 1, title: 'old a', done: false, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 2, title: 'old b', done: true, createdAt: '2026-01-02T00:00:00.000Z' },
  ] }));
  const db = openDb(file);
  assert.deepEqual(db.list().map(todo => todo.priority), ['normal', 'normal']);
  assert.equal(db.list()[1].done, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, 2);
});

test('POST accepts a valid priority and rejects others', async t => {
  const app = await appWith(t);
  const high = await app.call('POST', '/api/todos', { title: 'urgent', priority: 'high' });
  assert.equal(high.status, 201);
  assert.equal(high.body.priority, 'high');
  const plain = await app.call('POST', '/api/todos', { title: 'plain' });
  assert.equal(plain.body.priority, 'normal');
  const invalid = await app.call('POST', '/api/todos', { title: 'bad', priority: 'urgent' });
  assert.equal(invalid.status, 400);
  assert.equal(typeof invalid.body?.error, 'string');
  assert.equal((await app.call('GET', '/api/todos')).body.length, 2);
});
