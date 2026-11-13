// Shared helpers for hidden acceptance tests. Copied next to each acceptance test
// as .bench-acceptance/harness.mjs inside the evaluated workspace.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const load = relative => import(pathToFileURL(path.join(workspace, relative)).href);
export const read = relative => fs.readFileSync(path.join(workspace, relative), 'utf8');

export function tempFile(name = 'todos.json') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'minitodo-accept-')), name);
}

export async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const response = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: response.status, headers: response.headers, body: parsed, text };
  };
  return { base, call, close: () => new Promise(resolve => server.close(resolve)) };
}

export async function appWith(t, options = {}) {
  const { createApp } = await load('src/app.mjs');
  const { openDb } = await load('src/db.mjs');
  const db = options.db || openDb(tempFile(), options.dbOptions);
  const server = await startServer(createApp({ db, ...(options.app || {}) }));
  t.after(server.close);
  return { db, ...server };
}
