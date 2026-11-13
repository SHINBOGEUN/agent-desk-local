export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export function renderTodoItem(todo) {
  return `<li data-id="${todo.id}" class="${todo.done ? 'done' : ''}">`
    + `<input type="checkbox" class="toggle"${todo.done ? ' checked' : ''}>`
    + `<span class="title">${escapeHtml(todo.title)}</span>`
    + '<button type="button" class="delete">삭제</button></li>';
}

export function renderTodoList(todos) {
  if (!todos.length) return '<li class="empty">할 일이 없습니다.</li>';
  return todos.map(renderTodoItem).join('');
}
