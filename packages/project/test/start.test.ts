import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { overviewNote, projectStart, setVerifyCommands } from '#project';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'start-'));
const put = (project: string, rel: string, content: string) => { const file = path.join(project, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };

test('a folder with only harness files is new; one with code is existing, with its verify candidates', () => {
  const empty = tmp();
  put(empty, '.agent-desk/notes/runs/x.md', 'x');
  const fresh = projectStart(empty);
  assert.equal(fresh.kind, 'new');
  assert.equal(fresh.entries, 0);
  assert.equal(fresh.git.repo, false);

  const code = tmp();
  put(code, 'package.json', JSON.stringify({ scripts: { test: 'node --test', build: 'tsc' } }));
  put(code, 'src/app.js', 'x');
  const existing = projectStart(code);
  assert.equal(existing.kind, 'existing');
  assert.deepEqual(existing.verifyCandidates.map(candidate => candidate.command), ['npm test', 'npm run build']);
  assert.deepEqual(existing.verify, []);
});

test('setting verify commands keeps the rest of config.json; an empty list removes the key', () => {
  const project = tmp();
  put(project, '.agent-desk/config.json', JSON.stringify({ review: 'auto' }));
  assert.deepEqual(setVerifyCommands(project, [' npm test ', '']), { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, '.agent-desk/config.json'), 'utf8')), { review: 'auto', verify: ['npm test'] });
  assert.deepEqual(projectStart(project).verify, ['npm test']);
  setVerifyCommands(project, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, '.agent-desk/config.json'), 'utf8')), { review: 'auto' });
});

test('the overview note holds the goal, the technology (or that it is still open) and the rules', () => {
  const note = overviewNote({ goal: '가계부 웹앱', stack: '', rules: ['외부 패키지 금지', ' '] }, 'ko', '2026-11-22');
  assert.equal(note.path, 'specs/프로젝트 개요.md');
  assert.match(note.text, /## 만들 것\n가계부 웹앱/);
  assert.match(note.text, /아직 정하지 않음/);
  assert.match(note.text, /- 외부 패키지 금지\n/);
  assert.doesNotMatch(note.text, /- \s*\n/);
});
