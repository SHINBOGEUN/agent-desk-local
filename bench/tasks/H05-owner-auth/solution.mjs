import { edit } from '../_shared/edit.mjs';

export function apply(directory) {
  edit(directory, 'src/db.mjs', 'export const SCHEMA_VERSION = 1;', 'export const SCHEMA_VERSION = 2;');
  edit(directory, 'src/db.mjs', 'const migrations = {};', 'const migrations = {\n  2: data => ({ ...data, todos: data.todos.map(todo => ({ ...todo, owner: todo.owner ?? null })) }),\n};');
  edit(directory, 'src/db.mjs', "done: false, createdAt: now().toISOString() };", "done: false, owner: fields.owner ?? null, createdAt: now().toISOString() };");
  edit(directory, 'src/config.mjs', `    dataFile: env.DATA_FILE || 'data/todos.json',`, `    dataFile: env.DATA_FILE || 'data/todos.json',
    apiKeys: parseApiKeys(env.API_KEYS),`);
  edit(directory, 'src/config.mjs', 'export function loadConfig', `export function parseApiKeys(value) {
  const keys = {};
  for (const entry of String(value || '').split(',')) {
    const separator = entry.indexOf(':');
    if (separator < 0) continue;
    const token = entry.slice(0, separator).trim();
    const name = entry.slice(separator + 1).trim();
    if (token && name) keys[token] = name;
  }
  return keys;
}

export function loadConfig`);
  edit(directory, 'src/server.mjs', 'createApp({ db })', 'createApp({ db, apiKeys: config.apiKeys })');
  edit(directory, 'src/app.mjs', 'export function createApp({ db }) {', 'export function createApp({ db: store, apiKeys = {} }) {\n  const authEnabled = Object.keys(apiKeys).length > 0;');
  edit(directory, 'src/app.mjs', `    try {
      if (pathname === '/api/todos' && request.method === 'GET') {`, `    try {
      let user = null;
      if (authEnabled && pathname.startsWith('/api/')) {
        const header = request.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
        user = Object.hasOwn(apiKeys, token) ? apiKeys[token] : null;
        if (!user) return sendJson(response, 401, { error: 'Unauthorized' });
      }
      const db = scoped(store, authEnabled, user);
      if (pathname === '/api/todos' && request.method === 'GET') {`);
  edit(directory, 'src/app.mjs', 'export function createApp(', `// Limits every database call to the caller's own todos. With auth disabled the
// store is used as is.
function scoped(store, authEnabled, user) {
  if (!authEnabled) return store;
  const mine = todo => todo && todo.owner === user;
  return {
    list: () => store.list().filter(mine),
    insert: fields => store.insert({ ...fields, owner: user }),
    update: (id, patch) => (mine(store.get(id)) ? store.update(id, patch) : null),
    remove: id => (mine(store.get(id)) ? store.remove(id) : false),
    get: id => (mine(store.get(id)) ? store.get(id) : null),
  };
}

export function createApp(`);
  edit(directory, 'public/app.js', "  const response = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });", "  const headers = body ? { 'Content-Type': 'application/json' } : {};\n  const token = localStorage.getItem('token');\n  if (token) headers.Authorization = `Bearer ${token}`;\n  const response = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });");
}
