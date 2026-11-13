import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTodoList } from '../public/render.js';

test('renders todos and escapes titles', () => {
  const html = renderTodoList([{ id: 1, title: '<b>x</b>', done: true }]);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /class="done"/);
});

test('renders an empty state', () => {
  assert.match(renderTodoList([]), /할 일이 없습니다/);
});
