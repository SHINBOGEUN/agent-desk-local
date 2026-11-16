import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderNotes } from '../src/render.mjs';

test('renderNotes renders one li per note, newest first', () => {
  const html = renderNotes([
    { id: 1, title: 'first', createdAt: 1, pinned: false },
    { id: 2, title: 'second', createdAt: 2, pinned: false },
  ]);
  assert.equal(html.match(/<li/g).length, 2);
  assert.ok(html.indexOf('second') < html.indexOf('first'));
});
