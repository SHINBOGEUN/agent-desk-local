import { edit } from '../_shared/edit.mjs';

export function apply(directory) {
  edit(directory, 'src/app.mjs',
    "if (typeof body.title !== 'string') return sendJson(response, 400, { error: 'title is required' });\n        return sendJson(response, 201, db.insert({ title: body.title }));",
    "const title = typeof body.title === 'string' ? body.title.trim() : '';\n        if (title.length < 1 || title.length > 100) return sendJson(response, 400, { error: 'title must be 1-100 characters' });\n        return sendJson(response, 201, db.insert({ title }));");
}
