import test from 'node:test';
import assert from 'node:assert/strict';
import { load, read } from './harness.mjs';

test('renderSummary counts open todos', async () => {
  const { renderSummary } = await load('public/render.js');
  assert.equal(typeof renderSummary, 'function');
  const todos = [{ id: 1, title: 'a', done: false }, { id: 2, title: 'b', done: true }, { id: 3, title: 'c', done: false }];
  assert.match(renderSummary(todos), /남은 할 일 2개/);
  assert.match(renderSummary([]), /남은 할 일 0개/);
  assert.match(renderSummary([{ id: 1, title: 'a', done: true }]), /남은 할 일 0개/);
});

test('page has a summary element that the app updates', () => {
  assert.match(read('public/index.html'), /id=["']summary["']/);
  const app = read('public/app.js');
  assert.match(app, /renderSummary/);
  assert.match(app, /summary/);
});
