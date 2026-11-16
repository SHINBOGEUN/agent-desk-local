import { sortNotes } from './notes.mjs';

export function renderNote(note) {
  return `<li data-id="${note.id}">${note.title}</li>`;
}

export function renderNotes(notes) {
  return sortNotes(notes).map(renderNote).join('\n');
}
