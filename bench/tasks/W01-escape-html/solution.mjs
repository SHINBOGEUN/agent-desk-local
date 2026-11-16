import { edit } from '../_shared/edit.mjs';

export function apply(directory) {
  edit(directory, 'src/render.mjs', 'export function renderNote(note) {\n  return `<li data-id="${note.id}">${note.title}</li>`;', `const escapeHtml = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function renderNote(note) {
  return \`<li data-id="\${note.id}">\${escapeHtml(note.title)}</li>\`;`);
}
