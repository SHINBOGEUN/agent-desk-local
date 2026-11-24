import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkSkills, loadProject } from '#project';
import { FakeRuntime } from '#runtime-fake';
import { applyTeamDraft, parseTeamDraft, roleFileWith, runTeamDraft } from '../src/index.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'team-draft-'));

const reply = {
  rules: {
    builder: ['- Add a new file under supabase/migrations for every schema change; never edit an applied migration.', 'Record each migration in docs/tasks.'],
    verifier: ['Money is whole won: check that amounts stay integers.'],
    lead: [],
  },
  skills: [{
    id: 'add-migration', role: 'builder',
    description: 'Adds a Supabase migration the way this project records them. Use when a change needs a new table, column, policy or function. Do not use for changes that touch no schema.',
    body: 'Why: an edited applied migration never reaches the live database.\n\n1. Create supabase/migrations/<timestamp>_<name>.sql.\n2. Write a task note in docs/tasks.\n\n## Examples\n\n- Normal: a new column gets a new migration file.\n- Error: editing an old migration; make a new one instead.',
    should: ['Add a nickname column', 'Create a policy for photos'], shouldNot: ['Change a button color'],
  }, { id: 'Bad Id', role: 'builder', description: 'x', body: 'y' }],
  sources: ['AGENTS.md', 'docs/tasks/'],
};

test('parseTeamDraft keeps valid rules and skills and drops malformed ones', () => {
  const project = tmp();
  const draft = parseTeamDraft(`Here it is:\n${JSON.stringify(reply)}`, project)!;
  assert.deepEqual(draft.rules.builder, ['Add a new file under supabase/migrations for every schema change; never edit an applied migration.', 'Record each migration in docs/tasks.']);
  assert.equal(draft.rules.lead, undefined);
  assert.deepEqual(draft.skills.map(skill => skill.id), ['add-migration']);
  assert.equal(draft.skills[0]!.exists, false);
  assert.equal(parseTeamDraft('no json here', project), null);
  assert.equal(parseTeamDraft('{"rules": {}, "skills": []}', project), null);
});

test('runTeamDraft runs one read-only lead session and returns the draft without writing', async () => {
  const project = tmp();
  const runtime = new FakeRuntime({ scripts: { lead: [{ turns: [[{ message: JSON.stringify(reply), final: true }]] }] } });
  const result = await runTeamDraft({ project, runtime, language: 'ko' });
  assert.ok(result.ok);
  assert.equal(runtime.turns[0]!.options.access, 'read-only');
  assert.match(runtime.turns[0]!.options.instructions, /Korean/);
  assert.match(runtime.turns[0]!.options.instructions, /cannot write files/);
  assert.equal(fs.existsSync(path.join(project, '.agent-desk')), false);
  const failed = await runTeamDraft({ project, runtime: new FakeRuntime({ scripts: { lead: [{ turns: [[{ message: 'sorry', final: true }]] }] } }) });
  assert.equal(failed.ok, false);
  assert.equal(failed.raw, 'sorry');
});

test('applyTeamDraft writes the chosen skills and adds rules to role files that pass the project checks', () => {
  const project = tmp();
  fs.mkdirSync(path.join(project, '.agent-desk', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(project, '.agent-desk', 'agents', 'builder.md'), '---\ndescription: Builds.\naccess: workspace-write\neffort: high\nskills: []\n---\n\nKeep commits small.\n');
  const draft = parseTeamDraft(JSON.stringify(reply), project)!;
  const result = applyTeamDraft(project, { rules: draft.rules, skills: draft.skills });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.written.sort(), ['.agent-desk/agents/builder.md', '.agent-desk/agents/verifier.md', '.agent-desk/skills/add-migration/SKILL.md', '.agent-desk/skills/add-migration/triggers.json']);
  const builder = fs.readFileSync(path.join(project, '.agent-desk', 'agents', 'builder.md'), 'utf8');
  assert.match(builder, /skills: \[add-migration\]/);
  assert.match(builder, /Keep commits small\.\n\n## Project rules\n\n- Add a new file under supabase\/migrations/);
  const loaded = loadProject(project);
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.roles.builder.skills, ['add-migration']);
  assert.deepEqual(checkSkills(project, loaded.config, loaded.roles).findings.filter(finding => finding.level === 'error'), []);
  // Applying the same rules again adds nothing twice.
  applyTeamDraft(project, { rules: draft.rules, skills: [] });
  const again = fs.readFileSync(path.join(project, '.agent-desk', 'agents', 'builder.md'), 'utf8');
  assert.equal(again.split('never edit an applied migration').length, 2);
});

test('roleFileWith fills the default template and keeps its settings', () => {
  const text = roleFileWith(null, 'lead', ['Plans name the files they touch.'], []);
  assert.match(text, /^---\ndescription: .+\naccess: read-only\neffort: low\nskills: \[\]\n---\n\n## Project rules\n\n- Plans name the files they touch\.\n$/);
});
