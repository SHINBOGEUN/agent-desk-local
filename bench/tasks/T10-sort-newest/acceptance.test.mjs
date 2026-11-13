import test from 'node:test';
import assert from 'node:assert/strict';
import { appWith } from './harness.mjs';

test('list is sorted newest first with id as tie breaker', async t => {
  const times = ['2026-01-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'];
  let index = 0;
  const app = await appWith(t, { dbOptions: { now: () => new Date(times[index++]) } });
  for (const title of ['A', 'B', 'C', 'D']) await app.call('POST', '/api/todos', { title });
  const listed = await app.call('GET', '/api/todos');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.map(todo => todo.title), ['B', 'C', 'D', 'A']);
});
