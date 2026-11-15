import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assignRuntimes, loadProject, parseFrontmatter, roleSettings, roleTemplate, skillsByRole, validateConfig } from '#project';

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

import { checkSkills, referencedFiles } from '#project';

const GOOD = `---
name: api-conventions
description: Use when the user asks to add or change an HTTP endpoint, to check naming, status codes and error shapes against the project's API rules. Do not use for database or UI work.
---

Follow [the rules](references/rules.md) because clients depend on stable error shapes.
`;

test('skills check: a well-formed skill has no findings', () => {
  const project = tmp();
  put(project, '.agent-desk/skills/api-conventions/SKILL.md', GOOD);
  put(project, '.agent-desk/skills/api-conventions/references/rules.md', '# rules');
  const report = checkSkills(project, { skills: ['api-conventions'] });
  assert.deepEqual(report.findings, []);
  assert.equal(report.skills[0]?.path, '.agent-desk/skills/api-conventions/SKILL.md');
});

test('skills check: structure errors and description weaknesses are reported', () => {
  const project = tmp();
  put(project, '.agent-desk/skills/Bad_Name/SKILL.md', '---\nname: other\n---\n');
  put(project, '.agent-desk/skills/no-file/notes.txt', 'x');
  put(project, '.agent-desk/skills/vague/SKILL.md', '---\nname: vague\ndescription: Helps with stuff\nextra: 1\n---\nBody with [missing](references/gone.md).\n');
  put(project, '.agent-desk/skills/vague/orphan.md', 'never linked');
  put(project, '.agent-desk/skills/shouty/SKILL.md', `---\nname: shouty\ndescription: ${'x'.repeat(10)}\n---\n${'ALWAYS do this. NEVER do that. MUST obey.\n'.repeat(2)}`);
  const messages = checkSkills(project, { skills: ['ghost'] }, { builder: { role: 'builder', file: 'f', skills: ['phantom'], body: '' } }).findings.map(finding => `${finding.level} ${finding.skill}: ${finding.message}`);
  const has = (pattern: RegExp) => assert.ok(messages.some(message => pattern.test(message)), `missing: ${pattern}\n${messages.join('\n')}`);
  has(/error Bad_Name: folder name must be lowercase/);
  has(/error Bad_Name: name "other" must match/);
  has(/error no-file: missing SKILL\.md/);
  has(/warn vague: unknown frontmatter key "extra"/);
  has(/warn vague: description is very short/);
  has(/warn vague: description does not say when to use/);
  has(/warn vague: description does not say when NOT to use/);
  has(/error vague: body refers to "references\/gone\.md"/);
  has(/warn vague: "orphan\.md" is never mentioned/);
  has(/info shouty: 6 absolute rules/);
  has(/error project: config\.skills lists "ghost"/);
  has(/error project: \.agent-desk\/agents\/builder\.md lists skill "phantom"/);
  has(/info vague: exists but is not listed in config\.skills/);
});

test('skills check: duplicate descriptions and body references', () => {
  const project = tmp();
  const same = 'Use when the user asks to review a change for security problems. Do not use for style review.';
  put(project, '.agent-desk/skills/a/SKILL.md', `---\nname: a\ndescription: ${same}\n---\nbody`);
  put(project, '.agent-desk/skills/b/SKILL.md', `---\nname: b\ndescription: ${same}\n---\nbody`);
  assert.ok(checkSkills(project, {}).findings.some(finding => /identical to "a"/.test(finding.message)));
  assert.deepEqual(referencedFiles('See [x](./references/x.md), [web](https://e.com/a), `scripts/run.sh`, [top](#a).').sort(), ['references/x.md', 'scripts/run.sh']);
  assert.deepEqual(checkSkills(tmp(), {}).skills, []);
});

import { MEMORY_MAX_CHARS, addMemory, loadMemory, memoryFacts, newSuggestions } from '#project';

test('memory: add, dedupe, size cap, secrets refused, suggestions filtered', () => {
  const project = tmp();
  assert.equal(loadMemory(project), '');
  assert.deepEqual(addMemory(project, 'Migrations are applied by the user.'), { ok: true, chars: loadMemory(project).length });
  assert.deepEqual(memoryFacts(loadMemory(project)), ['Migrations are applied by the user.']);
  assert.match(fs.readFileSync(path.join(project, '.agent-desk/memory.md'), 'utf8'), /^# Project memory/);
  assert.equal(addMemory(project, 'migrations are  applied by the USER.').ok, false);
  assert.equal(addMemory(project, '').ok, false);
  assert.match((addMemory(project, 'x'.repeat(300)) as { error: string }).error, /at most 240/);
  assert.match((addMemory(project, 'the key is sk-abcdefghijklmnopqrstuvwxyz') as { error: string }).error, /secret/);
  assert.match((addMemory(project, 'password: hunter2') as { error: string }).error, /secret/);
  assert.deepEqual(newSuggestions(project, ['Migrations are applied by the user.', 'Emulator port is 8081', 'emulator port is 8081', '', 'y'.repeat(500)]), ['Emulator port is 8081']);
  let last = addMemory(project, 'fact 0');
  for (let i = 1; last.ok && i < 200; i++) last = addMemory(project, `fact number ${i} padding padding padding`);
  assert.equal(last.ok, false);
  assert.match((last as { error: string }).error, new RegExp(`exceed ${MEMORY_MAX_CHARS}`));
  assert.ok(loadMemory(project).length <= MEMORY_MAX_CHARS);
});

test('skillsByRole: roles get the skills their files list, limited to config.skills; broken or missing skills are skipped with a reason', () => {
  const project = tmp();
  assert.deepEqual(skillsByRole(project, loadProject(project)), {});
  put(project, '.agent-desk/skills/api-conventions/SKILL.md', GOOD);
  put(project, '.agent-desk/skills/api-conventions/references/rules.md', '# rules');
  put(project, '.agent-desk/skills/db-migration/SKILL.md', GOOD.replace('name: api-conventions', 'name: db-migration').replace('HTTP endpoint', 'database migration'));
  put(project, '.agent-desk/skills/db-migration/references/rules.md', '# rules');
  put(project, '.agent-desk/skills/broken/SKILL.md', '---\nname: broken\n---\nbody\n');
  put(project, '.agent-desk/agents/builder.md', '---\nskills: [api-conventions, db-migration, broken, ghost]\n---\n');
  put(project, '.agent-desk/agents/verifier.md', '---\nskills: [api-conventions]\n---\n');
  put(project, '.agent-desk/config.json', JSON.stringify({ skills: ['api-conventions', 'broken', 'ghost'] }));
  const skipped: string[] = [];
  const skills = skillsByRole(project, loadProject(project), (id, reason) => skipped.push(`${id}: ${reason}`));
  assert.deepEqual(Object.keys(skills).sort(), ['builder', 'verifier']);
  assert.deepEqual(skills.builder, [{ id: 'api-conventions', description: skills.builder?.[0]?.description, path: '.agent-desk/skills/api-conventions/SKILL.md' }]);
  assert.match(skills.builder?.[0]?.description ?? '', /^Use when the user asks/);
  assert.deepEqual(skills.verifier?.map(skill => skill.id), ['api-conventions']);
  assert.equal(skipped.length, 3);
  assert.match(skipped.find(line => line.startsWith('db-migration')) ?? '', /config\.skills/);
  assert.match(skipped.find(line => line.startsWith('broken')) ?? '', /description/);
  assert.match(skipped.find(line => line.startsWith('ghost')) ?? '', /does not exist/);
  // No config.skills: every existing skill a role lists is used; nothing is copied into runtime folders.
  fs.rmSync(path.join(project, '.agent-desk', 'config.json'));
  assert.deepEqual(skillsByRole(project, loadProject(project)).builder?.map(skill => skill.id), ['api-conventions', 'db-migration']);
  assert.equal(fs.existsSync(path.join(project, '.agents')), false);
  assert.equal(fs.existsSync(path.join(project, '.claude')), false);
});
