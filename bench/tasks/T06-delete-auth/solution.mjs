import { edit } from '../_shared/edit.mjs';

export function apply(directory) {
  edit(directory, 'src/app.mjs', 'export function createApp({ db }) {', 'export function createApp({ db, adminToken }) {');
  edit(directory, 'src/app.mjs',
    '      if (match && request.method === \'DELETE\') {\n',
    "      if (match && request.method === 'DELETE') {\n        if (!adminToken || request.headers.authorization !== `Bearer ${adminToken}`) return sendJson(response, 401, { error: 'Unauthorized' });\n");
  edit(directory, 'src/server.mjs', 'createApp({ db })', 'createApp({ db, adminToken: process.env.ADMIN_TOKEN })');
  edit(directory, 'test/app.test.mjs',
    "const server = await startServer(createApp({ db: openDb(tempFile()) }));\n  t.after(server.close);\n  const created",
    "const server = await startServer(createApp({ db: openDb(tempFile()), adminToken: 'test-token' }));\n  t.after(server.close);\n  const created");
  edit(directory, 'test/app.test.mjs',
    "assert.equal((await server.call('DELETE', `/api/todos/${created.body.id}`)).status, 204);\n  assert.equal((await server.call('DELETE', `/api/todos/${created.body.id}`)).status, 404);",
    "const auth = { Authorization: 'Bearer test-token' };\n  assert.equal((await server.call('DELETE', `/api/todos/${created.body.id}`, null, auth)).status, 204);\n  assert.equal((await server.call('DELETE', `/api/todos/${created.body.id}`, null, auth)).status, 404);");
}
