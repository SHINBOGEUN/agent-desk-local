import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { addMemory, approveProposal, buildGraph, initVault, listNotes, loadMemory, memoryFacts, moveNote, parseLinks, parseTags, proposeMemory, readNote, recordDecision, resolveLink, safeNotePath, searchNotes, setNoteProperty, syncApprovals, trashNote, validateConfig, vaultRoot, writeNote } from '#project';

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const put = (root: string, rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

test('vault folder comes from config.vault or defaults to .agent-desk/notes', () => {
  assert.equal(vaultRoot('/p'), path.resolve('/p', '.agent-desk/notes'));
  assert.equal(vaultRoot('/p', 'docs/notes'), path.resolve('/p', 'docs/notes'));
  assert.equal(vaultRoot('/p', '/vault/Projects/minitodo'), path.resolve('/vault/Projects/minitodo'));
  assert.equal(validateConfig({ vault: 'notes' }).ok, true);
  assert.equal(validateConfig({ vault: 3 }).ok, false);
});

test('note paths stay inside the vault and are markdown', () => {
  const root = tmp('vault-');
  assert.equal(safeNotePath(root, 'specs/login.md').ok, true);
  for (const bad of ['../x.md', 'specs/../../x.md', 'x.txt', '.obsidian/app.md', 'a//b.md', 'a:b.md']) assert.equal(safeNotePath(root, bad).ok, false, bad);
});

test('links, tags and resolution work like Obsidian', () => {
  assert.deepEqual(parseLinks('See [[Login spec]] and [[specs/Login spec#Errors|errors]]; not `[[code]]`.\n```\n[[fenced]]\n```'), ['Login spec', 'specs/Login spec']);
  assert.deepEqual(parseTags('Body #todo and #ui/forms but not #123', { tags: ['spec'] }).sort(), ['spec', 'todo', 'ui/forms']);
  const paths = ['specs/Login spec.md', 'archive/old/Login spec.md', 'runs/0001 x.md'];
  assert.equal(resolveLink('Login spec', paths), 'specs/Login spec.md');
  assert.equal(resolveLink('old/Login spec', paths), 'archive/old/Login spec.md');
  assert.equal(resolveLink('src/app.mjs', paths), null);
});

test('listNotes and buildGraph connect notes and keep missing targets as their own nodes', () => {
  const root = tmp('vault-');
  put(root, 'specs/Login.md', '---\ntags: [spec]\n---\n# Login\nErrors follow [[Error style]]. Code: [[src/app.mjs]]');
  put(root, 'decisions/Error style.md', '---\nstatus: approved\n---\nPolite errors.');
  put(root, 'runs/0001 login.md', 'Built [[Login]], changed [[src/app.mjs]].');
  put(root, '.obsidian/workspace.md', 'ignored');
  const notes = listNotes(root);
  assert.deepEqual(notes.map(note => note.path).sort(), ['decisions/Error style.md', 'runs/0001 login.md', 'specs/Login.md']);
  const login = notes.find(note => note.path === 'specs/Login.md')!;
  assert.deepEqual(login.links, [{ target: 'Error style', resolved: 'decisions/Error style.md' }, { target: 'src/app.mjs', resolved: null }]);
  assert.deepEqual(login.tags, ['spec']);
  const graph = buildGraph(notes);
  assert.equal(graph.nodes.length, 4);
  assert.deepEqual(graph.nodes.find(node => node.id === 'missing:src/app.mjs'), { id: 'missing:src/app.mjs', title: 'src/app.mjs', folder: '', kind: 'missing', links: 2 });
  assert.equal(graph.edges.length, 4);
});

test('write refuses to overwrite on create and when the note changed since it was read', () => {
  const root = tmp('vault-');
  const first = writeNote(root, 'specs/A.md', 'one', { create: true });
  assert.ok(first.ok);
  assert.equal(writeNote(root, 'specs/A.md', 'two', { create: true }).ok, false);
  const read = readNote(root, 'specs/A.md');
  assert.ok(!('error' in read));
  if ('error' in read) return;
  fs.utimesSync(path.join(root, 'specs/A.md'), new Date(), new Date(Date.now() + 5000));
  const stale = writeNote(root, 'specs/A.md', 'three', { expectedMtimeMs: read.mtimeMs });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.conflict, true);
  assert.ok(moveNote(root, 'specs/A.md', 'specs/B.md').ok);
  assert.ok(trashNote(root, 'specs/B.md').ok);
  assert.ok(fs.existsSync(path.join(root, '.trash', 'B.md')));
});

test('setNoteProperty changes one key and keeps the rest', () => {
  assert.equal(setNoteProperty('---\nstatus: proposed\nrun: 3\n---\nbody', 'status', 'approved'), '---\nstatus: approved\nrun: 3\n---\nbody');
  assert.equal(setNoteProperty('body', 'status', 'approved'), '---\nstatus: approved\n---\nbody');
});

test('search ranks titles above bodies and leaves runs out by default', () => {
  const root = tmp('vault-');
  put(root, 'specs/Due date.md', 'Show the due date as YYYY-MM-DD.');
  put(root, 'specs/List.md', 'The list shows title and due date.');
  put(root, 'runs/0002 due.md', 'due date run');
  const hits = searchNotes(root, 'due date');
  assert.deepEqual(hits.map(hit => hit.path), ['specs/Due date.md', 'specs/List.md']);
  assert.match(hits[0]!.excerpt, /YYYY-MM-DD/);
  assert.deepEqual(searchNotes(root, 'x'), []);
});

test('memory proposals go through the inbox and reach memory.md only when approved', () => {
  const project = tmp('vault-p-');
  const root = vaultRoot(project);
  assert.deepEqual(initVault(root).sort(), ['decisions', 'inbox', 'runs', 'specs']);
  addMemory(project, 'Tests run with npm test');
  const created = proposeMemory(project, root, ['Dates are YYYY-MM-DD', 'Tests run with npm test', 'Errors are polite'], { run: 7, runNote: 'runs/0007 dates', lang: 'ko' });
  assert.deepEqual(created, ['inbox/Dates are YYYY-MM-DD.md', 'inbox/Errors are polite.md']);
  assert.deepEqual(proposeMemory(project, root, ['dates are  yyyy-mm-dd']), []);
  assert.match(fs.readFileSync(path.join(root, 'inbox/Dates are YYYY-MM-DD.md'), 'utf8'), /출처: \[\[runs\/0007 dates\]\]/);

  const approved = approveProposal(project, root, 'inbox/Dates are YYYY-MM-DD.md');
  assert.deepEqual(approved, { ok: true, decision: 'decisions/Dates are YYYY-MM-DD.md', fact: 'Dates are YYYY-MM-DD' });
  assert.match(fs.readFileSync(path.join(root, 'decisions/Dates are YYYY-MM-DD.md'), 'utf8'), /status: approved/);
  assert.deepEqual(memoryFacts(loadMemory(project)), ['Tests run with npm test', 'Dates are YYYY-MM-DD']);

  // Approved in Obsidian: picked up by the sync; a rejected one goes to .trash.
  const errors = 'inbox/Errors are polite.md';
  fs.writeFileSync(path.join(root, errors), fs.readFileSync(path.join(root, errors), 'utf8').replace('status: proposed', 'status: 승인'));
  proposeMemory(project, root, ['Use tabs']);
  fs.writeFileSync(path.join(root, 'inbox/Use tabs.md'), fs.readFileSync(path.join(root, 'inbox/Use tabs.md'), 'utf8').replace('status: proposed', 'status: rejected'));
  assert.deepEqual(syncApprovals(project, root), { approved: ['Errors are polite'], rejected: ['inbox/Use tabs.md'], errors: [] });
  assert.ok(fs.existsSync(path.join(root, '.trash', 'Use tabs.md')));
  assert.deepEqual(memoryFacts(loadMemory(project)).at(-1), 'Errors are polite');

  // Added from the dashboard with no inbox note: a decision note is written.
  const direct = recordDecision(project, root, 'Buttons say 저장', { run: 9, runNote: 'runs/0009 x' });
  assert.ok(direct.ok && direct.decision === 'decisions/Buttons say 저장.md');
  assert.deepEqual(syncApprovals(project, tmp('none-')), { approved: [], rejected: [], errors: [] });
});

test('team notes mirror the role files and skills, link them, and only touch generated notes', async () => {
  const { loadProject, syncTeamNotes } = await import('#project');
  const project = tmp('vault-team-');
  put(project, '.agent-desk/agents/builder.md', '---\ndescription: Builds\neffort: high\nmodel-codex: gpt-x\nskills: [verify-before-report]\n---\nBe careful.');
  put(project, '.agent-desk/skills/verify-before-report/SKILL.md', '---\nname: verify-before-report\ndescription: Checks the work before the report when the builder finishes. Do not use for questions.\n---\nRun the tests because reports lie.');
  put(project, '.agent-desk/skills/unused-one/SKILL.md', '---\nname: unused-one\ndescription: Formats dates when the user asks. Do not use otherwise.\n---\nBody.');
  const root = path.join(project, '.agent-desk', 'notes');
  const first = syncTeamNotes(project, root, loadProject(project), { usage: { 'verify-before-report': { runs: [{ id: 56, note: 'runs/0056 x' }, { id: 50, note: null }] } }, lang: 'ko' });
  assert.ok(first.written.includes('team/roles/builder.md') && first.written.includes('team/skills/unused-one.md'));
  const builder = fs.readFileSync(path.join(root, 'team/roles/builder.md'), 'utf8');
  assert.match(builder, /generated: true/);
  assert.match(builder, /runtime: codex/);
  assert.match(builder, /- \[\[team\/skills\/verify-before-report\|verify-before-report\]\]/);
  const skill = fs.readFileSync(path.join(root, 'team/skills/verify-before-report.md'), 'utf8');
  assert.match(skill, /reads: 2\nlast-run: 56/);
  assert.match(skill, /\[\[team\/roles\/builder\|builder\]\]/);
  assert.match(skill, /- \[\[runs\/0056 x\|#56\]\]\n- #50/);
  assert.match(fs.readFileSync(path.join(root, 'team/skills/unused-one.md'), 'utf8'), /없음 \(어느 역할에도 주어지지 않음\)/);
  // Nothing changed: nothing rewritten. A removed skill loses its generated note; a user's note in team/ stays.
  assert.deepEqual(syncTeamNotes(project, root, loadProject(project), { usage: { 'verify-before-report': { runs: [{ id: 56, note: 'runs/0056 x' }, { id: 50, note: null }] } }, lang: 'ko' }).written, []);
  put(root, 'team/My notes.md', 'mine');
  fs.rmSync(path.join(project, '.agent-desk/skills/unused-one'), { recursive: true });
  const after = syncTeamNotes(project, root, loadProject(project), { lang: 'ko' });
  assert.deepEqual(after.removed, ['team/skills/unused-one.md']);
  assert.ok(fs.existsSync(path.join(root, 'team/My notes.md')));
  const graph = buildGraph(listNotes(root));
  assert.ok(graph.edges.some(edge => edge.from === 'team/roles/builder.md' && edge.to === 'team/skills/verify-before-report.md'));
});
