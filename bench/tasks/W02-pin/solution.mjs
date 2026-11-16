import { edit, append } from '../_shared/edit.mjs';

export function apply(directory) {
  edit(directory, 'src/notes.mjs', 'return [...notes].sort((a, b) => b.createdAt - a.createdAt);', 'return [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt);');
  append(directory, 'src/notes.mjs', `
export function pinNote(notes, id) {
  if (!notes.some(note => note.id === id)) throw new Error('note not found');
  return notes.map(note => (note.id === id ? { ...note, pinned: !note.pinned } : note));
}
`);
  edit(directory, 'src/render.mjs', '`<li data-id="${note.id}">', '`<li data-id="${note.id}"${note.pinned ? \' class="pinned"\' : \'\'}>');
}
