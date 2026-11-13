import { edit } from '../_shared/edit.mjs';

export function apply(directory) {
  edit(directory, 'src/app.mjs', '        return sendJson(response, 200, todos);',
    '        todos.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id - b.id);\n        return sendJson(response, 200, todos);');
}
