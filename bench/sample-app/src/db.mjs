import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 1;

// Each entry upgrades data from version (key - 1) to version key.
const migrations = {};

export function migrate(data) {
  let current = { ...data, schemaVersion: data.schemaVersion ?? 1 };
  while (current.schemaVersion < SCHEMA_VERSION) {
    const next = current.schemaVersion + 1;
    const step = migrations[next];
    if (!step) throw new Error(`No migration to schema version ${next}`);
    current = { ...step(current), schemaVersion: next };
  }
  return current;
}

function load(file) {
  if (!fs.existsSync(file)) return { schemaVersion: SCHEMA_VERSION, nextId: 1, todos: [] };
  return migrate(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function openDb(file, { now = () => new Date() } = {}) {
  const data = load(file);
  const persist = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  };
  persist();
  const copy = todo => (todo ? { ...todo } : null);
  return {
    list: () => data.todos.map(copy),
    get: id => copy(data.todos.find(todo => todo.id === id)),
    insert(fields) {
      const todo = { id: data.nextId++, title: fields.title, done: false, createdAt: now().toISOString() };
      data.todos.push(todo);
      persist();
      return copy(todo);
    },
    update(id, patch) {
      const todo = data.todos.find(item => item.id === id);
      if (!todo) return null;
      Object.assign(todo, patch);
      persist();
      return copy(todo);
    },
    remove(id) {
      const index = data.todos.findIndex(todo => todo.id === id);
      if (index < 0) return false;
      data.todos.splice(index, 1);
      persist();
      return true;
    },
  };
}
