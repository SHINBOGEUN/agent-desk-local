import { edit } from '../_shared/edit.mjs';

export function apply(directory) {
  edit(directory, 'src/db.mjs', 'export const SCHEMA_VERSION = 1;', 'export const SCHEMA_VERSION = 2;');
  edit(directory, 'src/db.mjs', 'const migrations = {};', "const migrations = {\n  2: data => ({ ...data, todos: data.todos.map(todo => ({ priority: 'normal', ...todo })) }),\n};");
  edit(directory, 'src/db.mjs', "done: false, createdAt: now().toISOString() };", "done: false, priority: fields.priority || 'normal', createdAt: now().toISOString() };");
  edit(directory, 'src/app.mjs',
    "return sendJson(response, 201, db.insert({ title: body.title }));",
    "if (body.priority !== undefined && !['low', 'normal', 'high'].includes(body.priority)) return sendJson(response, 400, { error: 'priority must be low, normal or high' });\n        return sendJson(response, 201, db.insert({ title: body.title, priority: body.priority }));");
}
