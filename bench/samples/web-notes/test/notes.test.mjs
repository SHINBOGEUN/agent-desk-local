import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNote, removeNote, sortNotes } from '../src/notes.mjs';

test('createNote assigns incrementing ids', () => {
  let notes = createNote([], 'a', 1);
  notes = createNote(notes, 'b', 2);
  assert.deepEqual(notes.map(note => note.id), [1, 2]);
});

test('createNote rejects blank titles', () => {
  assert.throws(() => createNote([], '   '), /required/);
});

test('removeNote drops the note', () => {
  const notes = createNote(createNote([], 'a', 1), 'b', 2);
  assert.deepEqual(removeNote(notes, 1).map(note => note.title), ['b']);
});

test('sortNotes puts newest first', () => {
  const notes = createNote(createNote([], 'old', 1), 'new', 2);
  assert.deepEqual(sortNotes(notes).map(note => note.title), ['new', 'old']);
});
