import { edit } from '../_shared/edit.mjs';

export function apply(directory) {
  edit(directory, 'src/db.mjs', `function load(file) {
  if (!fs.existsSync(file)) return { schemaVersion: SCHEMA_VERSION, nextId: 1, todos: [] };
  return migrate(JSON.parse(fs.readFileSync(file, 'utf8')));
}`, `function load(file) {
  const empty = () => ({ schemaVersion: SCHEMA_VERSION, nextId: 1, todos: [] });
  if (!fs.existsSync(file)) return { data: empty(), recoveredFrom: null };
  const text = fs.readFileSync(file, 'utf8');
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  const wellFormed = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.todos);
  if (!wellFormed) {
    const backup = \`\${file}.corrupt-\${Date.now()}\`;
    fs.writeFileSync(backup, text);
    return { data: empty(), recoveredFrom: backup };
  }
  if ((parsed.schemaVersion ?? 1) > SCHEMA_VERSION) throw new Error(\`Data file schemaVersion \${parsed.schemaVersion} is newer than supported version \${SCHEMA_VERSION}\`);
  const data = migrate(parsed);
  const maxId = data.todos.reduce((max, todo) => Math.max(max, Number(todo.id) || 0), 0);
  if (!(data.nextId > maxId)) data.nextId = maxId + 1;
  return { data, recoveredFrom: null };
}`);
  edit(directory, 'src/db.mjs', 'const data = load(file);', 'const { data, recoveredFrom } = load(file);');
  edit(directory, 'src/db.mjs', '    fs.writeFileSync(file, JSON.stringify(data, null, 2));', "    const temporary = `${file}.tmp`;\n    fs.writeFileSync(temporary, JSON.stringify(data, null, 2));\n    fs.renameSync(temporary, file);");
  edit(directory, 'src/db.mjs', '    list: () => data.todos.map(copy),', '    recoveredFrom,\n    list: () => data.todos.map(copy),');
  edit(directory, 'src/app.mjs', `  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');`, `  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body too large'), { status: 413 });
  const text = Buffer.concat(chunks).toString('utf8');`);
  edit(directory, 'src/app.mjs', 'async function readJson(request) {', 'const MAX_BODY_BYTES = 100 * 1024;\n\nasync function readJson(request) {');
}
