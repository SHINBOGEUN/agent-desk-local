import { edit } from '../_shared/edit.mjs';

export function apply(directory) {
  edit(directory, 'src/app.mjs',
    "      const match = pathname.match(",
    `      if (pathname === '/api/todos' && request.method === 'DELETE') {
        if (url.searchParams.get('status') !== 'done') return sendJson(response, 400, { error: 'Only status=done can be bulk deleted' });
        const doneIds = db.list().filter(todo => todo.done).map(todo => todo.id);
        for (const id of doneIds) db.remove(id);
        return sendJson(response, 200, { deleted: doneIds.length });
      }
      const match = pathname.match(`);
  edit(directory, 'public/index.html', '<ul id="list"></ul>', '<ul id="list"></ul>\n    <button type="button" id="clear-done">완료 항목 지우기</button>');
  edit(directory, 'public/app.js', 'refresh();\n', "document.querySelector('#clear-done').addEventListener('click', async () => {\n  await request('DELETE', '/api/todos?status=done');\n  await refresh();\n});\n\nrefresh();\n");
}
