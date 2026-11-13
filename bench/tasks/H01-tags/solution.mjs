import { edit } from '../_shared/edit.mjs';

export function apply(directory) {
  edit(directory, 'src/db.mjs', 'export const SCHEMA_VERSION = 1;', 'export const SCHEMA_VERSION = 2;');
  edit(directory, 'src/db.mjs', 'const migrations = {};', 'const migrations = {\n  2: data => ({ ...data, todos: data.todos.map(todo => ({ ...todo, tags: todo.tags ?? [] })) }),\n};');
  edit(directory, 'src/db.mjs', "done: false, createdAt: now().toISOString() };", "done: false, tags: fields.tags ?? [], createdAt: now().toISOString() };");
  edit(directory, 'src/app.mjs', 'export function createApp({ db }) {', `function normalizeTags(value) {
  if (!Array.isArray(value) || value.some(tag => typeof tag !== 'string')) return { error: 'tags must be an array of strings' };
  const tags = [...new Set(value.map(tag => tag.trim().toLowerCase()).filter(Boolean))];
  if (tags.length > 5) return { error: 'at most 5 tags are allowed' };
  if (tags.some(tag => tag.length > 20)) return { error: 'a tag may have at most 20 characters' };
  return { tags };
}

export function createApp({ db }) {`);
  edit(directory, 'src/app.mjs', '        return sendJson(response, 200, todos);', `        const wanted = url.searchParams.getAll('tag').map(tag => tag.trim().toLowerCase()).filter(Boolean);
        if (wanted.length) todos = todos.filter(todo => wanted.every(tag => (todo.tags || []).includes(tag)));
        return sendJson(response, 200, todos);
      }
      if (pathname === '/api/tags' && request.method === 'GET') {
        const counts = new Map();
        for (const todo of db.list()) for (const tag of todo.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
        const tags = [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'en'));
        return sendJson(response, 200, tags);`);
  edit(directory, 'src/app.mjs', '        return sendJson(response, 201, db.insert({ title: body.title }));', `        let tags = [];
        if (body.tags !== undefined) {
          const result = normalizeTags(body.tags);
          if (result.error) return sendJson(response, 400, { error: result.error });
          tags = result.tags;
        }
        return sendJson(response, 201, db.insert({ title: body.title, tags }));`);
  edit(directory, 'src/app.mjs', "        if (typeof body.done === 'boolean') patch.done = body.done;", `        if (typeof body.done === 'boolean') patch.done = body.done;
        if (body.tags !== undefined) {
          const result = normalizeTags(body.tags);
          if (result.error) return sendJson(response, 400, { error: result.error });
          patch.tags = result.tags;
        }`);
  edit(directory, 'public/render.js', "    + `<span class=\"title\">${escapeHtml(todo.title)}</span>`", "    + `<span class=\"title\">${escapeHtml(todo.title)}</span>`\n    + (todo.tags || []).map(tag => `<span class=\"tag\">${escapeHtml(tag)}</span>`).join('')");
  edit(directory, 'public/index.html', '<input name="title" placeholder="새 할 일" autocomplete="off" required>', '<input name="title" placeholder="새 할 일" autocomplete="off" required>\n      <input name="tags" placeholder="태그 (쉼표로 구분)" autocomplete="off">');
  edit(directory, 'public/app.js', "await request('POST', '/api/todos', { title: input.value });", "const tags = (form.querySelector('input[name=\"tags\"]').value || '').split(',').map(tag => tag.trim()).filter(Boolean);\n  await request('POST', '/api/todos', { title: input.value, tags });\n  form.querySelector('input[name=\"tags\"]').value = '';");
}
