import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinNote, sortNotes } from '../src/notes.mjs';
import { renderNotes } from '../src/render.mjs';

const notes = () => [
  { id: 1, title: 'one', createdAt: 1, pinned: false },
  { id: 2, title: 'two', createdAt: 2, pinned: false },
  { id: 3, title: 'three', createdAt: 3, pinned: false },
];

test('pinNote toggles without mutating the input', () => {
  const original = notes();
  const pinned = pinNote(original, 1);
  assert.equal(pinned.find(note => note.id === 1).pinned, true);
  assert.equal(original[0].pinned, false);
  assert.equal(pinNote(pinned, 1).find(note => note.id === 1).pinned, false);
});

test('pinNote throws for unknown id', () => {
  assert.throws(() => pinNote(notes(), 99));
});

test('pinned notes sort first, newest first within each group', () => {
  const result = pinNote(pinNote(notes(), 1), 2);
  assert.deepEqual(sortNotes(result).map(note => note.id), [2, 1, 3]);
});

test('rendering marks pinned notes', () => {
  const html = renderNotes(pinNote(notes(), 2));
  const lines = html.split('\n');
  assert.match(lines[0], /class="pinned"/);
  assert.match(lines[0], /two/);
  assert.ok(!/class="pinned"/.test(lines[1]));
});
