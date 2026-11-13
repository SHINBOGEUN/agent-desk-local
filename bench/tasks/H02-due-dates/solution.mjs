import { edit } from '../_shared/edit.mjs';

export function apply(directory) {
  edit(directory, 'src/db.mjs', 'export const SCHEMA_VERSION = 1;', 'export const SCHEMA_VERSION = 2;');
  edit(directory, 'src/db.mjs', 'const migrations = {};', 'const migrations = {\n  2: data => ({ ...data, todos: data.todos.map(todo => ({ ...todo, dueDate: todo.dueDate ?? null })) }),\n};');
  edit(directory, 'src/db.mjs', "done: false, createdAt: now().toISOString() };", "done: false, dueDate: fields.dueDate ?? null, createdAt: now().toISOString() };");
  edit(directory, 'src/db.mjs', '    list: () => data.todos.map(copy),', "    today: () => now().toISOString().slice(0, 10),\n    list: () => data.todos.map(copy),");
  edit(directory, 'src/app.mjs', 'export function createApp({ db }) {', `function validDueDate(value) {
  if (typeof value !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function createApp({ db }) {
  const withOverdue = todo => ({ ...todo, overdue: !todo.done && todo.dueDate != null && todo.dueDate < db.today() });`);
  edit(directory, 'src/app.mjs', '        return sendJson(response, 200, todos);', `        if (url.searchParams.get('overdue') === 'true') todos = todos.map(withOverdue).filter(todo => todo.overdue);
        const sort = url.searchParams.get('sort');
        if (sort !== null && sort !== 'due') return sendJson(response, 400, { error: 'sort must be due' });
        if (sort === 'due') todos.sort((a, b) => (a.dueDate === null) - (b.dueDate === null) || (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0) || a.id - b.id);
        return sendJson(response, 200, todos.map(withOverdue));`);
  edit(directory, 'src/app.mjs', '        return sendJson(response, 201, db.insert({ title: body.title }));', `        if (body.dueDate !== undefined && body.dueDate !== null && !validDueDate(body.dueDate)) return sendJson(response, 400, { error: 'dueDate must be a valid YYYY-MM-DD date' });
        return sendJson(response, 201, withOverdue(db.insert({ title: body.title, dueDate: body.dueDate ?? null })));`);
  edit(directory, 'src/app.mjs', "        if (typeof body.done === 'boolean') patch.done = body.done;\n        const todo = db.update(Number(match[1]), patch);\n        return todo ? sendJson(response, 200, todo)", `        if (typeof body.done === 'boolean') patch.done = body.done;
        if (body.dueDate !== undefined) {
          if (body.dueDate !== null && !validDueDate(body.dueDate)) return sendJson(response, 400, { error: 'dueDate must be a valid YYYY-MM-DD date or null' });
          patch.dueDate = body.dueDate;
        }
        const todo = db.update(Number(match[1]), patch);
        return todo ? sendJson(response, 200, withOverdue(todo))`);
  edit(directory, 'public/render.js', "  return `<li data-id=\"${todo.id}\" class=\"${todo.done ? 'done' : ''}\">`", "  const classes = [todo.done ? 'done' : '', todo.overdue === true ? 'overdue' : ''].filter(Boolean).join(' ');\n  return `<li data-id=\"${todo.id}\" class=\"${classes}\">`");
  edit(directory, 'public/render.js', "    + `<span class=\"title\">${escapeHtml(todo.title)}</span>`", "    + `<span class=\"title\">${escapeHtml(todo.title)}</span>`\n    + (todo.dueDate ? `<span class=\"due\">${escapeHtml(todo.dueDate)}</span>` : '')");
  edit(directory, 'public/index.html', '<input name="title" placeholder="새 할 일" autocomplete="off" required>', '<input name="title" placeholder="새 할 일" autocomplete="off" required>\n      <input name="dueDate" type="date">');
  edit(directory, 'public/app.js', "await request('POST', '/api/todos', { title: input.value });", "const dueDate = form.querySelector('input[name=\"dueDate\"]').value;\n  await request('POST', '/api/todos', { title: input.value, ...(dueDate ? { dueDate } : {}) });\n  form.querySelector('input[name=\"dueDate\"]').value = '';");
}
