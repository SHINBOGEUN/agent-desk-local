import { edit, append } from '../_shared/edit.mjs';

export function apply(directory) {
  append(directory, 'public/render.js', "\nexport function renderSummary(todos) {\n  return `남은 할 일 ${todos.filter(todo => !todo.done).length}개`;\n}\n");
  edit(directory, 'public/index.html', '<ul id="list"></ul>', '<p id="summary"></p>\n    <ul id="list"></ul>');
  edit(directory, 'public/app.js', "import { renderTodoList } from './render.js';", "import { renderTodoList, renderSummary } from './render.js';");
  edit(directory, 'public/app.js', '  list.innerHTML = renderTodoList(todos);', "  list.innerHTML = renderTodoList(todos);\n  document.querySelector('#summary').textContent = renderSummary(todos);");
}
