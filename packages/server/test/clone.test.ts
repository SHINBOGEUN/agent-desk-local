import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { cloneProject, isCloneUrl, repoName } from '../src/clone.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clone-'));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

test('clone addresses: https, ssh, git@ and file are accepted; options and plain paths are not', () => {
  for (const url of ['https://github.com/me/app.git', 'ssh://git@host/me/app', 'git@github.com:me/app.git', 'file:///tmp/app']) assert.ok(isCloneUrl(url), url);
  for (const url of ['--upload-pack=touch x', 'C:\\work\\app', 'ftp://x/y', 'https://a b']) assert.equal(isCloneUrl(url), false, url);
  assert.equal(repoName('https://github.com/me/my-app.git'), 'my-app');
  assert.equal(repoName('git@github.com:me/tool.git/'), 'tool');
});

test('cloneProject clones into the chosen folder, makes the work branch, and refuses a non-empty target', async () => {
  const origin = tmp();
  git(origin, 'init', '-q');
  fs.writeFileSync(path.join(origin, 'README.md'), 'hello');
  git(origin, 'add', '.');
  git(origin, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first');
  const parent = tmp();
  const url = pathToFileURL(origin).href;
  const result = await cloneProject({ url, parent, name: 'copy', branch: 'agent-work', install: true }, process.env);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.path, path.join(parent, 'copy'));
  assert.equal(fs.readFileSync(path.join(parent, 'copy', 'README.md'), 'utf8'), 'hello');
  assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: result.path, encoding: 'utf8' }).trim(), 'agent-work');
  assert.equal(result.steps.find(step => step.step === 'install')?.skipped, 'no package.json');

  const again = await cloneProject({ url, parent, name: 'copy' }, process.env);
  assert.equal(again.ok, false);
  assert.match(again.error ?? '', /not empty/);
  assert.equal(again.path, '');
  assert.equal((await cloneProject({ url, parent, name: '../escape' }, process.env)).ok, false);
});
