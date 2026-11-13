import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempFile(name = 'todos.json') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'minitodo-'));
  return path.join(directory, name);
}

export async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const response = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null, text };
  };
  return { base, call, close: () => new Promise(resolve => server.close(resolve)) };
}
