import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appWith, load, read, tempFile } from './harness.mjs';

const keys = { 'tok-alice': 'alice', 'tok-bob': 'bob' };
const as = token => ({ Authorization: `Bearer ${token}` });
const add = (app, token, body) => app.call('POST', '/api/todos', body, as(token));

test('loadConfig parses API_KEYS and server.mjs passes it on', async () => {
  const { loadConfig } = await load('src/config.mjs');
  assert.deepEqual(loadConfig({}).apiKeys, {});
  assert.deepEqual(loadConfig({ API_KEYS: '' }).apiKeys, {});
  assert.deepEqual(loadConfig({ API_KEYS: ' t1:alice , t2 : bob ,broken,:nobody,tok:,' }).apiKeys, { t1: 'alice', t2: 'bob' });
  assert.deepEqual(loadConfig({ API_KEYS: 't1:alice' }).port, 3100, 'other settings unchanged');
  assert.match(read('src/server.mjs'), /apiKeys/);
});

test('without apiKeys nothing changes', async t => {
  const app = await appWith(t);
  const created = await app.call('POST', '/api/todos', { title: 'open' });
  assert.equal(created.status, 201);
  assert.equal(created.body.owner, null);
  assert.equal((await app.call('GET', '/api/todos')).body.length, 1);
  assert.equal((await app.call('DELETE', `/api/todos/${created.body.id}`)).status, 204);
});

test('requires a valid bearer token for every API route but not for the page', async t => {
  const app = await appWith(t, { app: { apiKeys: keys } });
  for (const [method, url, body] of [['GET', '/api/todos'], ['POST', '/api/todos', { title: 'x' }], ['PATCH', '/api/todos/1', { done: true }], ['DELETE', '/api/todos/1'], ['GET', '/api/unknown']]) {
    for (const headers of [{}, as('wrong'), { Authorization: 'tok-alice' }, { Authorization: 'Basic tok-alice' }, as('')]) {
      const response = await app.call(method, url, body, headers);
      assert.equal(response.status, 401, `${method} ${url} ${JSON.stringify(headers)}`);
      assert.equal(typeof response.body?.error, 'string');
    }
  }
  assert.equal(app.db.list().length, 0);
  const page = await fetch(`${app.base}/`);
  assert.equal(page.status, 200);
  assert.equal((await fetch(`${app.base}/app.js`)).status, 200);
  assert.equal((await app.call('GET', '/api/todos', undefined, as('tok-bob'))).status, 200);
});

test('each user only sees and changes their own todos', async t => {
  const app = await appWith(t, { app: { apiKeys: keys } });
  const a1 = (await add(app, 'tok-alice', { title: 'alice one' })).body;
  await add(app, 'tok-alice', { title: 'alice two' });
  const b1 = (await add(app, 'tok-bob', { title: 'bob one' })).body;
  assert.equal(a1.owner, 'alice');
  assert.equal(b1.owner, 'bob');
  assert.deepEqual((await app.call('GET', '/api/todos', undefined, as('tok-alice'))).body.map(todo => todo.title), ['alice one', 'alice two']);
  assert.deepEqual((await app.call('GET', '/api/todos', undefined, as('tok-bob'))).body.map(todo => todo.title), ['bob one']);
  for (const [method, body] of [['PATCH', { title: 'hacked', done: true }], ['DELETE', undefined]]) {
    const response = await app.call(method, `/api/todos/${a1.id}`, body, as('tok-bob'));
    assert.equal(response.status, 404, method);
    assert.equal(typeof response.body?.error, 'string');
  }
  assert.deepEqual([app.db.get(a1.id).title, app.db.get(a1.id).done], ['alice one', false]);
  const own = await app.call('PATCH', `/api/todos/${a1.id}`, { done: true }, as('tok-alice'));
  assert.equal(own.status, 200);
  assert.equal((await app.call('DELETE', `/api/todos/${b1.id}`, undefined, as('tok-bob'))).status, 204);
  assert.equal((await app.call('DELETE', `/api/todos/${b1.id}`, undefined, as('tok-bob'))).status, 404);
});

test('the owner cannot be chosen through the request body', async t => {
  const app = await appWith(t, { app: { apiKeys: keys } });
  const created = await add(app, 'tok-alice', { title: 'x', owner: 'bob' });
  assert.equal(created.body.owner, 'alice');
  const patched = await app.call('PATCH', `/api/todos/${created.body.id}`, { owner: 'bob', title: 'y' }, as('tok-alice'));
  assert.equal(patched.body.owner, 'alice');
  assert.equal(app.db.get(created.body.id).owner, 'alice');
  assert.deepEqual((await app.call('GET', '/api/todos', undefined, as('tok-bob'))).body, []);
});

test('legacy todos without an owner are hidden while auth is on and visible when it is off', async t => {
  const { openDb } = await load('src/db.mjs');
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, nextId: 3, todos: [{ id: 1, title: 'legacy', done: false, createdAt: 'x' }] }));
  const db = openDb(file);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, 2);
  assert.equal(db.list()[0].owner, null);
  const secured = await appWith(t, { db, app: { apiKeys: keys } });
  assert.deepEqual((await secured.call('GET', '/api/todos', undefined, as('tok-alice'))).body, []);
  assert.equal((await secured.call('PATCH', '/api/todos/1', { done: true }, as('tok-alice'))).status, 404);
  await add(secured, 'tok-alice', { title: 'mine' });
  const open = await appWith(t, { db });
  assert.deepEqual((await open.call('GET', '/api/todos')).body.map(todo => todo.title), ['legacy', 'mine']);
});

test('the page sends the stored token', () => {
  const app = read('public/app.js');
  assert.match(app, /localStorage/);
  assert.match(app, /Authorization/);
  assert.match(app, /Bearer/);
});
