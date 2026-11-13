import test from 'node:test';
import assert from 'node:assert/strict';
import { appWith, read } from './harness.mjs';

test('bulk delete removes only done todos', async t => {
  const app = await appWith(t);
  for (const title of ['a', 'b', 'c']) await app.call('POST', '/api/todos', { title });
  await app.call('PATCH', '/api/todos/1', { done: true });
  await app.call('PATCH', '/api/todos/3', { done: true });
  for (const query of ['', '?status=open', '?status=all']) {
    const rejected = await app.call('DELETE', `/api/todos${query}`);
    assert.equal(rejected.status, 400, `DELETE /api/todos${query}`);
    assert.equal(typeof rejected.body?.error, 'string');
  }
  assert.equal(app.db.list().length, 3);
  const cleared = await app.call('DELETE', '/api/todos?status=done');
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body, { deleted: 2 });
  assert.deepEqual(app.db.list().map(todo => todo.id), [2]);
  assert.deepEqual((await app.call('DELETE', '/api/todos?status=done')).body, { deleted: 0 });
});

test('page has a clear-done button wired to the API', () => {
  assert.match(read('public/index.html'), /id=["']clear-done["']/);
  const app = read('public/app.js');
  assert.match(app, /clear-done/);
  assert.match(app, /status=done/);
  assert.match(app, /DELETE/);
});
