import { edit } from '../_shared/edit.mjs';

export function apply(directory) {
  edit(directory, 'src/db.mjs', 'export const SCHEMA_VERSION = 1;', 'export const SCHEMA_VERSION = 2;');
  edit(directory, 'src/db.mjs', 'const migrations = {};', 'const migrations = {\n  2: data => ({ ...data, todos: data.todos.map(todo => ({ ...todo, deletedAt: todo.deletedAt ?? null })) }),\n};');
  edit(directory, 'src/db.mjs', '  persist();\n  const copy', `  const retentionMs = 30 * 24 * 60 * 60 * 1000;
  const cutoff = now().getTime() - retentionMs;
  data.todos = data.todos.filter(todo => !todo.deletedAt || new Date(todo.deletedAt).getTime() >= cutoff);
  persist();
  const active = () => data.todos.filter(todo => !todo.deletedAt);
  const copy`);
  edit(directory, 'src/db.mjs', `    list: () => data.todos.map(copy),
    get: id => copy(data.todos.find(todo => todo.id === id)),`, `    list: () => active().map(copy),
    get: id => copy(active().find(todo => todo.id === id)),
    listTrash: () => data.todos.filter(todo => todo.deletedAt)
      .sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : b.id - a.id)).map(copy),
    trash(id) {
      const todo = active().find(item => item.id === id);
      if (!todo) return false;
      todo.deletedAt = now().toISOString();
      persist();
      return true;
    },
    restore(id) {
      const todo = data.todos.find(item => item.id === id && item.deletedAt);
      if (!todo) return null;
      todo.deletedAt = null;
      persist();
      return copy(todo);
    },
    purgeTrash() {
      const before = data.todos.length;
      data.todos = data.todos.filter(todo => !todo.deletedAt);
      persist();
      return before - data.todos.length;
    },`);
  edit(directory, 'src/db.mjs', "done: false, createdAt: now().toISOString() };", "done: false, deletedAt: null, createdAt: now().toISOString() };");
  edit(directory, 'src/db.mjs', "      const todo = data.todos.find(item => item.id === id);\n      if (!todo) return null;\n      Object.assign(todo, patch);", "      const todo = active().find(item => item.id === id);\n      if (!todo) return null;\n      Object.assign(todo, patch);");
  edit(directory, 'src/app.mjs', "      const match = pathname.match(", `      if (pathname === '/api/trash' && request.method === 'GET') return sendJson(response, 200, db.listTrash());
      if (pathname === '/api/trash' && request.method === 'DELETE') return sendJson(response, 200, { purged: db.purgeTrash() });
      const restore = pathname.match(/^\\/api\\/todos\\/(\\d+)\\/restore$/);
      if (restore && request.method === 'POST') {
        const todo = db.restore(Number(restore[1]));
        return todo ? sendJson(response, 200, todo) : sendJson(response, 404, { error: 'Todo not in trash' });
      }
      const match = pathname.match(`);
  edit(directory, 'src/app.mjs', "return db.remove(Number(match[1])) ? sendJson(response, 204)", "return db.trash(Number(match[1])) ? sendJson(response, 204)");
}
