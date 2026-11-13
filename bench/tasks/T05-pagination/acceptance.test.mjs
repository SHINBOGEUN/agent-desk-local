import test from 'node:test';
import assert from 'node:assert/strict';
import { appWith } from './harness.mjs';

test('list is paginated with a total count header', async t => {
  const app = await appWith(t);
  for (let index = 1; index <= 105; index++) app.db.insert({ title: `item ${index}` });
  const first = await app.call('GET', '/api/todos');
  assert.equal(first.status, 200);
  assert.equal(first.body.length, 20);
  assert.equal(first.headers.get('x-total-count'), '105');
  const third = await app.call('GET', '/api/todos?page=3&limit=10');
  assert.equal(third.body.length, 10);
  assert.equal(third.body[0].title, 'item 21');
  const last = await app.call('GET', '/api/todos?page=6');
  assert.deepEqual(last.body.map(todo => todo.title), ['item 101', 'item 102', 'item 103', 'item 104', 'item 105']);
  const capped = await app.call('GET', '/api/todos?limit=1000');
  assert.equal(capped.status, 200);
  assert.equal(capped.body.length, 100);
  for (const query of ['limit=0', 'page=0', 'page=abc', 'limit=2.5', 'page=-1']) {
    const response = await app.call('GET', `/api/todos?${query}`);
    assert.equal(response.status, 400, query);
    assert.equal(typeof response.body?.error, 'string');
  }
});
