// Pure note logic (no DOM) so it can be tested in Node.
export const STORAGE_KEY = 'webnotes.v1';
export const MAX_TITLE_LENGTH = 280;

export function createNote(notes, title, now = Date.now()) {
  const text = String(title ?? '').trim();
  if (!text) throw new Error('title is required');
  if (text.length > MAX_TITLE_LENGTH) throw new Error('title too long');
  const id = notes.reduce((max, note) => Math.max(max, note.id), 0) + 1;
  return [...notes, { id, title: text, createdAt: now, pinned: false }];
}

export function removeNote(notes, id) {
  return notes.filter(note => note.id !== id);
}

export function sortNotes(notes) {
  return [...notes].sort((a, b) => b.createdAt - a.createdAt);
}
