import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appWith, load, read, tempFile } from './harness.mjs';

const add = (app, body) => app.call('POST', '/api/todos', body);

test('migrates schemaVersion 1 data and persists schemaVersion 2', async () => {
  const { openDb } = await load('src/db.mjs');
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, nextId: 3, todos: [{ id: 1, title: 'a', done: false, createdAt: 'x' }, { id: 2, title: 'b', done: true, createdAt: 'y' }] }));
  const db = openDb(file);
  assert.deepEqual(db.list().map(todo => todo.tags), [[], []]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, 2);
  assert.equal(db.insert({ title: 'c' }).id, 3);
});

test('normalizes tags on create and replaces them on patch', async t => {
  const app = await appWith(t);
  const created = await add(app, { title: 'x', tags: [' Work ', 'work', 'HOME', '', '  '] });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.tags, ['work', 'home']);
  assert.deepEqual((await add(app, { title: 'no tags' })).body.tags, []);
  const patched = await app.call('PATCH', `/api/todos/${created.body.id}`, { tags: ['Solo'] });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.body.tags, ['solo']);
  const cleared = await app.call('PATCH', `/api/todos/${created.body.id}`, { tags: [] });
  assert.deepEqual(cleared.body.tags, []);
});

test('rejects invalid tags and never applies a partly invalid patch', async t => {
  const app = await appWith(t);
  for (const tags of ['work', [1], [null], { a: 1 }, ['a', 'b', 'c', 'd', 'e', 'f'], ['x'.repeat(21)]]) {
    const response = await add(app, { title: 'x', tags });
    assert.equal(response.status, 400, JSON.stringify(tags));
    assert.equal(typeof response.body?.error, 'string');
  }
  assert.equal(app.db.list().length, 0);
  assert.equal((await add(app, { title: 'ok', tags: ['a', 'A', 'b', 'c', 'd', 'e'] })).status, 201, 'duplicates collapse before the limit is checked');
  assert.equal((await add(app, { title: 'ok', tags: ['x'.repeat(20)] })).status, 201);
  const todo = (await add(app, { title: 'keep', tags: ['a'] })).body;
  const rejected = await app.call('PATCH', `/api/todos/${todo.id}`, { title: 'changed', done: true, tags: 'bad' });
  assert.equal(rejected.status, 400);
  const after = app.db.get(todo.id);
  assert.equal(after.title, 'keep');
  assert.equal(after.done, false);
  assert.deepEqual(after.tags, ['a']);
});

test('filters by one or several tags and normalizes the query', async t => {
  const app = await appWith(t);
  await add(app, { title: 'one', tags: ['work', 'urgent'] });
  await add(app, { title: 'two', tags: ['work'] });
  await add(app, { title: 'three', tags: ['home'] });
  await add(app, { title: 'four' });
  const titles = async query => (await app.call('GET', `/api/todos${query}`)).body.map(todo => todo.title);
  assert.deepEqual(await titles('?tag=work'), ['one', 'two']);
  assert.deepEqual(await titles('?tag=%20WORK'), ['one', 'two']);
  assert.deepEqual(await titles('?tag=work&tag=urgent'), ['one']);
  assert.deepEqual(await titles('?tag=missing'), []);
  assert.deepEqual(await titles(''), ['one', 'two', 'three', 'four']);
});

test('lists tag counts, most used first then alphabetical', async t => {
  const app = await appWith(t);
  await add(app, { title: 'a', tags: ['work', 'b-tag'] });
  await add(app, { title: 'b', tags: ['work', 'a-tag'] });
  await add(app, { title: 'c', tags: ['b-tag'] });
  const response = await app.call('GET', '/api/tags');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, [{ tag: 'b-tag', count: 2 }, { tag: 'work', count: 2 }, { tag: 'a-tag', count: 1 }]);
});

test('page and renderer support tags safely', async () => {
  assert.match(read('public/index.html'), /name=["']tags["']/);
  assert.match(read('public/app.js'), /tags/);
  const { renderTodoList } = await load('public/render.js');
  const html = renderTodoList([{ id: 1, title: 't', done: false, tags: ['<i>x</i>', 'ok'] }]);
  assert.match(html, /<span class="tag">ok<\/span>/);
  assert.match(html, /&lt;i&gt;x&lt;\/i&gt;/);
  assert.doesNotMatch(html, /<i>x<\/i>/);
  assert.doesNotThrow(() => renderTodoList([{ id: 2, title: 'old', done: false }]));
});
