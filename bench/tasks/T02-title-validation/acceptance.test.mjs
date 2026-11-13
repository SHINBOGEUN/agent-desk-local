import test from 'node:test';
import assert from 'node:assert/strict';
import { appWith } from './harness.mjs';

test('title is trimmed and length-checked', async t => {
  const app = await appWith(t);
  for (const title of ['   ', '', 'x'.repeat(101)]) {
    const response = await app.call('POST', '/api/todos', { title });
    assert.equal(response.status, 400, `title of length ${title.length} should be rejected`);
    assert.equal(typeof response.body?.error, 'string');
  }
  assert.equal((await app.call('POST', '/api/todos', {})).status, 400);
  assert.equal((await app.call('POST', '/api/todos', { title: 42 })).status, 400);
  const trimmed = await app.call('POST', '/api/todos', { title: '  우유  ' });
  assert.equal(trimmed.status, 201);
  assert.equal(trimmed.body.title, '우유');
  const longest = await app.call('POST', '/api/todos', { title: ` ${'y'.repeat(100)} ` });
  assert.equal(longest.status, 201);
  assert.equal((await app.call('GET', '/api/todos')).body.length, 2);
});
