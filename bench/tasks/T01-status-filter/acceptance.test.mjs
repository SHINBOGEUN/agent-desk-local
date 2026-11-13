import test from 'node:test';
import assert from 'node:assert/strict';
import { appWith } from './harness.mjs';

test('status filter returns done and open todos', async t => {
  const app = await appWith(t);
  for (const title of ['a', 'b', 'c']) await app.call('POST', '/api/todos', { title });
  await app.call('PATCH', '/api/todos/2', { done: true });
  const done = await app.call('GET', '/api/todos?status=done');
  assert.equal(done.status, 200);
  assert.deepEqual(done.body.map(todo => todo.id), [2]);
  const open = await app.call('GET', '/api/todos?status=open');
  assert.deepEqual(open.body.map(todo => todo.id).sort(), [1, 3]);
  assert.equal((await app.call('GET', '/api/todos')).body.length, 3);
});
