import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assignRuntimes, loadProject, parseFrontmatter, roleSettings, roleTemplate, validateConfig } from '#project';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
const put = (project: string, rel: string, content: string) => { const file = path.join(project, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };

test('frontmatter: scalars, inline lists, block lists, CRLF, and errors', () => {
  const parsed = parseFrontmatter('---\r\ndescription: "Builds things"\r\naccess: workspace-write\r\nskills: [a, b]\r\nmore:\r\n  - x\r\n  - y\r\n---\r\n\r\nBody line\r\n');
  assert.deepEqual(parsed.data, { description: 'Builds things', access: 'workspace-write', skills: ['a', 'b'], more: ['x', 'y'] });
  assert.equal(parsed.body, 'Body line');
  assert.equal(parseFrontmatter('no frontmatter here').body, 'no frontmatter here');
  assert.match(parseFrontmatter('---\nkey: v\n').error ?? '', /not closed/);
  assert.match(parseFrontmatter('---\n???\n---\n').error ?? '', /cannot read/);
});

test('roles: missing files fall back to defaults with a warning; files add effort, model and notes', () => {
  const project = tmp();
  const none = loadProject(project);
  assert.deepEqual(none.missingRoles, ['lead', 'builder', 'verifier', 'researcher']);
  assert.match(none.warnings[0] ?? '', /agent-desk init/);
  assert.deepEqual(none.errors, []);

  put(project, '.agent-desk/agents/builder.md', '---\neffort: high\nmodel: gpt-x\nskills: [api-conventions]\n---\nNever edit generated files.\n');
  const loaded = loadProject(project);
  assert.deepEqual(loaded.missingRoles, ['lead', 'verifier', 'researcher']);
  assert.deepEqual(roleSettings(loaded), { access: {}, effort: { builder: 'high' }, models: { builder: 'gpt-x' }, roleNotes: { builder: 'Never edit generated files.' } });
  assert.deepEqual(loaded.roles.builder.skills, ['api-conventions']);
});

test('roles: a file cannot grant write access to a read-only role; bad values and unknown keys are errors', () => {
  const project = tmp();
  put(project, '.agent-desk/agents/verifier.md', '---\naccess: workspace-write\n---\n');
  put(project, '.agent-desk/agents/lead.md', '---\neffort: extreme\nmood: happy\n---\n');
  put(project, '.agent-desk/agents/builder.md', '---\naccess: read-only\n---\n');
  const loaded = loadProject(project);
  assert.equal(loaded.errors.length, 3);
  assert.ok(loaded.errors.some(error => /verifier\.md.*cannot grant write access/.test(error)));
  assert.ok(loaded.errors.some(error => /lead\.md.*effort/.test(error)));
  assert.ok(loaded.errors.some(error => /unknown frontmatter key "mood"/.test(error)));
  assert.equal(loaded.roles.builder.access, 'read-only');
});

test('templates parse cleanly for every role', () => {
  const project = tmp();
  for (const role of ['lead', 'builder', 'verifier', 'researcher'] as const) put(project, `.agent-desk/agents/${role}.md`, roleTemplate(role));
  const loaded = loadProject(project);
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.missingRoles, []);
  assert.equal(loaded.roles.builder.access, 'workspace-write');
  assert.equal(loaded.roles.lead.access, 'read-only');
});

test('runtime assignment: primary/review slots, role overrides and the --runtime override', () => {
  assert.deepEqual(assignRuntimes({}), { lead: 'codex', builder: 'codex', verifier: 'codex', researcher: 'codex' });
  const mixed = assignRuntimes({ runtimes: { primary: 'codex', review: 'claude' } });
  assert.equal(mixed.builder, 'codex');
  assert.equal(mixed.verifier, 'claude');
  const claudeOnly = assignRuntimes({ runtimes: { primary: 'claude' } });
  assert.deepEqual(Object.values(claudeOnly), ['claude', 'claude', 'claude', 'claude']);
  const custom = assignRuntimes({ runtimes: { primary: 'codex', review: 'claude' }, roles: { researcher: { runtime: 'review' }, verifier: { runtime: 'primary' } } });
  assert.equal(custom.researcher, 'claude');
  assert.equal(custom.verifier, 'codex');
  assert.equal(assignRuntimes({ runtimes: { primary: 'claude' } }, 'fake').verifier, 'fake');
});

test('config: invalid JSON is reported with the file name; limits are validated', () => {
  const project = tmp();
  put(project, '.agent-desk/config.json', '{ nope');
  assert.match(loadProject(project).errors[0] ?? '', /config\.json: not valid JSON/);
  assert.equal(validateConfig({ limits: { redo: 0, tokens: 1000, minutes: 5, codexUsagePercent: 10 } }).ok, true);
  const bad = validateConfig({ limits: { redo: -1, tokens: 0, speed: 1 } });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.errors.length, 3);
});

import { draftFromInspection, inspectProject, writeDraft } from '#project';

test('init: inspects a Node project and drafts config and role files without overwriting', () => {
  const project = tmp();
  put(project, 'package.json', JSON.stringify({ scripts: { test: 'node --test', typecheck: 'tsc --noEmit', build: 'tsc' }, devDependencies: { typescript: '5' }, dependencies: { express: '4' } }));
  put(project, 'test/a.test.js', '');
  put(project, '.github/workflows/ci.yml', '');
  put(project, 'AGENTS.md', 'Use tabs.'); put(project, 'CLAUDE.md', 'Use spaces.');
  const inspection = inspectProject(project);
  assert.deepEqual(inspection.stack, ['Node.js', 'TypeScript', 'Express']);
  assert.deepEqual(inspection.verifyCandidates.map(candidate => candidate.command), ['npm test', 'npm run typecheck', 'npm run build']);
  assert.ok(inspection.hasTests && inspection.hasCi && inspection.instructionFilesDiffer);
  assert.deepEqual(inspection.existingAgentFiles, ['AGENTS.md', 'CLAUDE.md']);

  const draft = draftFromInspection(inspection, ['codex', 'claude']);
  assert.deepEqual(draft.config, { runtimes: { primary: 'codex' }, verify: ['npm test', 'npm run typecheck'], review: 'auto' });
  assert.ok(draft.rationale.some(line => /differ/.test(line)));
  put(project, '.agent-desk/agents/lead.md', '---\neffort: medium\n---\nmine\n');
  const again = draftFromInspection(inspectProject(project), ['codex']);
  assert.equal(again.files.find(file => file.path.endsWith('lead.md'))?.willWrite, false);
  const written = writeDraft(project, again);
  assert.deepEqual(written.sort(), ['.agent-desk/agents/builder.md', '.agent-desk/agents/researcher.md', '.agent-desk/agents/verifier.md', '.agent-desk/config.json']);
  assert.equal(fs.readFileSync(path.join(project, '.agent-desk/agents/lead.md'), 'utf8'), '---\neffort: medium\n---\nmine\n');
  assert.deepEqual(loadProject(project).errors, []);
  assert.deepEqual(writeDraft(project, draftFromInspection(inspectProject(project), ['codex'])), []);
});

test('init: a project without tests gets review always and a note about verify; placeholder test script is ignored', () => {
  const project = tmp();
  put(project, 'package.json', JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  const inspection = inspectProject(project);
  assert.deepEqual(inspection.verifyCandidates, []);
  assert.ok(inspection.notes.some(note => /placeholder/.test(note)));
  const draft = draftFromInspection(inspection, []);
  assert.equal(draft.config.review, 'always');
  assert.equal(draft.config.verify, undefined);
  assert.ok(draft.rationale.some(line => /No test command/.test(line)));
});
