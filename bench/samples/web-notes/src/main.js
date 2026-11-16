import { STORAGE_KEY, createNote } from './notes.mjs';
import { renderNotes } from './render.mjs';

const load = () => JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
const list = document.getElementById('list');
const draw = () => { list.innerHTML = renderNotes(load()); };

document.getElementById('form').addEventListener('submit', event => {
  event.preventDefault();
  const input = document.getElementById('title');
  localStorage.setItem(STORAGE_KEY, JSON.stringify(createNote(load(), input.value)));
  input.value = '';
  draw();
});
draw();
