import { renderTodoList } from './render.js';

const list = document.querySelector('#list');
const form = document.querySelector('#new-todo');

async function request(method, url, body) {
  const response = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw new Error((await response.json()).error);
  return response.status === 204 ? null : response.json();
}

async function refresh() {
  const todos = await request('GET', '/api/todos');
  list.innerHTML = renderTodoList(todos);
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const input = form.querySelector('input[name="title"]');
  await request('POST', '/api/todos', { title: input.value });
  input.value = '';
  await refresh();
});

list.addEventListener('click', async event => {
  const item = event.target.closest('li[data-id]');
  if (!item) return;
  const id = item.dataset.id;
  if (event.target.matches('.toggle')) await request('PATCH', `/api/todos/${id}`, { done: event.target.checked });
  if (event.target.matches('.delete')) await request('DELETE', `/api/todos/${id}`);
  await refresh();
});

refresh();
