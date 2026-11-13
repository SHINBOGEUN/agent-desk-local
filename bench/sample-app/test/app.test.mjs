import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { openDb } from '../src/db.mjs';
import { startServer, tempFile } from './helpers.mjs';

test('creates, updates, lists and deletes todos', async t => {
  const server = await startServer(createApp({ db: openDb(tempFile()) }));
  t.after(server.close);
  const created = await server.call('POST', '/api/todos', { title: '우유 사기' });
  assert.equal(created.status, 201);
  assert.equal(created.body.title, '우유 사기');
  assert.equal(created.body.done, false);
  const updated = await server.call('PATCH', `/api/todos/${created.body.id}`, { done: true });
  assert.equal(updated.body.done, true);
  const listed = await server.call('GET', '/api/todos');
  assert.equal(listed.body.length, 1);
  assert.equal((await server.call('DELETE', `/api/todos/${created.body.id}`)).status, 204);
  assert.equal((await server.call('DELETE', `/api/todos/${created.body.id}`)).status, 404);
});

test('rejects a missing title', async t => {
  const server = await startServer(createApp({ db: openDb(tempFile()) }));
  t.after(server.close);
  const response = await server.call('POST', '/api/todos', {});
  assert.equal(response.status, 400);
  assert.equal(typeof response.body.error, 'string');
});

test('persists todos to the data file', async () => {
  const file = tempFile();
  openDb(file).insert({ title: '저장 확인' });
  assert.equal(openDb(file).list()[0].title, '저장 확인');
});

test('serves the page', async t => {
  const server = await startServer(createApp({ db: openDb(tempFile()) }));
  t.after(server.close);
  const page = await fetch(`${server.base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="list"/);
});
