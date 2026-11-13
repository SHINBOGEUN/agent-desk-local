import test from 'node:test';
import assert from 'node:assert/strict';
import { appWith, read } from './harness.mjs';

test('delete requires the exact admin bearer token', async t => {
  const app = await appWith(t, { app: { adminToken: 's3cret' } });
  const created = await app.call('POST', '/api/todos', { title: 'protected' });
  const path = `/api/todos/${created.body.id}`;
  for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: 's3cret' }, { Authorization: 'Bearer s3cret-extra' }]) {
    const response = await app.call('DELETE', path, null, headers);
    assert.equal(response.status, 401, JSON.stringify(headers));
    assert.equal(typeof response.body?.error, 'string');
  }
  assert.equal((await app.call('GET', '/api/todos')).body.length, 1);
  assert.equal((await app.call('DELETE', path, null, { Authorization: 'Bearer s3cret' })).status, 204);
  assert.equal((await app.call('GET', '/api/todos')).body.length, 0);
});

test('delete is always rejected when no admin token is configured', async t => {
  const app = await appWith(t);
  const created = await app.call('POST', '/api/todos', { title: 'x' });
  for (const headers of [{}, { Authorization: 'Bearer undefined' }, { Authorization: 'Bearer ' }, { Authorization: 'Bearer null' }]) {
    assert.equal((await app.call('DELETE', `/api/todos/${created.body.id}`, null, headers)).status, 401, JSON.stringify(headers));
  }
});

test('server reads ADMIN_TOKEN from the environment', () => {
  assert.match(read('src/server.mjs') + read('src/config.mjs'), /ADMIN_TOKEN/);
});
