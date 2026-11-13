import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const staticTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

export function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(body === undefined ? '' : JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
}

function serveStatic(response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(publicDirectory, relative);
  if (!file.startsWith(publicDirectory + path.sep) || !fs.existsSync(file)) return sendJson(response, 404, { error: 'Not found' });
  response.writeHead(200, { 'Content-Type': staticTypes[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(response);
}

export function createApp({ db }) {
  return async function handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const { pathname } = url;
    try {
      if (pathname === '/api/todos' && request.method === 'GET') {
        const status = url.searchParams.get('status');
        let todos = db.list();
        if (status) todos = todos.filter(todo => todo.done === status);
        return sendJson(response, 200, todos);
      }
      if (pathname === '/api/todos' && request.method === 'POST') {
        const body = await readJson(request);
        if (typeof body.title !== 'string') return sendJson(response, 400, { error: 'title is required' });
        return sendJson(response, 201, db.insert({ title: body.title }));
      }
      const match = pathname.match(/^\/api\/todos\/(\d+)$/);
      if (match && request.method === 'PATCH') {
        const body = await readJson(request);
        const patch = {};
        if (typeof body.title === 'string') patch.title = body.title;
        if (typeof body.done === 'boolean') patch.done = body.done;
        const todo = db.update(Number(match[1]), patch);
        return todo ? sendJson(response, 200, todo) : sendJson(response, 404, { error: 'Todo not found' });
      }
      if (match && request.method === 'DELETE') {
        return db.remove(Number(match[1])) ? sendJson(response, 204) : sendJson(response, 404, { error: 'Todo not found' });
      }
      if (pathname.startsWith('/api/')) return sendJson(response, 404, { error: 'Not found' });
      if (request.method === 'GET') return serveStatic(response, pathname);
      return sendJson(response, 405, { error: 'Method not allowed' });
    } catch (error) {
      return sendJson(response, error.status || 500, { error: error.status ? error.message : 'Internal error' });
    }
  };
}
