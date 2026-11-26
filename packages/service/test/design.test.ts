import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FakeRuntime } from '#runtime-fake';
import { parseDesign, runDesign } from '../src/index.ts';

const reply = {
  goal: 'Friends plan trips and settle costs.',
  phases: [
    { name: 'Core', items: [{ title: 'Groups', detail: 'create and list groups', request: 'Build groups', done: true, evidence: 'App.tsx:10' }, { title: 'Settlement', detail: 'minimum transfers', request: 'Build settlement' }] },
    { name: 'Sharing', items: [{ title: '', request: 'x' }, { title: 'Invite friends', request: 'Build invites', done: false, evidence: 'ignored' }] },
  ],
};

test('parseDesign flattens phases into items, keeps done with evidence, drops items without a title', () => {
  const draft = parseDesign(`Plan:\n${JSON.stringify(reply)}`)!;
  assert.equal(draft.goal, reply.goal);
  assert.deepEqual(draft.items.map(item => [item.title, item.phase, item.status]), [['Groups', 'Core', 'done'], ['Settlement', 'Core', 'todo'], ['Invite friends', 'Sharing', 'todo']]);
  assert.equal(draft.items[0]!.evidence, 'App.tsx:10');
  assert.equal(draft.items[2]!.evidence, undefined);
  assert.equal(parseDesign('nothing'), null);
  assert.equal(parseDesign('{"goal": "x", "phases": []}'), null);
});

test('runDesign uses one read-only lead session, passes the user brief and writes nothing', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'design-'));
  const runtime = new FakeRuntime({ scripts: { lead: [{ turns: [[{ message: JSON.stringify(reply), final: true }]] }] } });
  const result = await runDesign({ project, runtime, brief: 'A trip app for friends', language: 'ko' });
  assert.ok(result.ok);
  assert.equal(result.draft?.items.length, 3);
  assert.equal(runtime.turns[0]!.options.access, 'read-only');
  assert.match(runtime.turns[0]!.input.text, /A trip app for friends/);
  assert.match(runtime.turns[0]!.options.instructions, /Korean/);
  assert.deepEqual(fs.readdirSync(project), []);
});
