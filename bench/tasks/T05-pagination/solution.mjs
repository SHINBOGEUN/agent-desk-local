import { edit } from '../_shared/edit.mjs';

export function apply(directory) {
  edit(directory, 'src/app.mjs',
    '        return sendJson(response, 200, todos);',
    `        const parse = (name, fallback) => {
          const raw = url.searchParams.get(name);
          if (raw === null) return fallback;
          return /^\\d+$/.test(raw) && Number(raw) >= 1 ? Number(raw) : null;
        };
        const page = parse('page', 1);
        const limit = parse('limit', 20);
        if (page === null || limit === null) return sendJson(response, 400, { error: 'page and limit must be positive integers' });
        const size = Math.min(limit, 100);
        return sendJson(response, 200, todos.slice((page - 1) * size, page * size), { 'X-Total-Count': String(todos.length) });`);
}
