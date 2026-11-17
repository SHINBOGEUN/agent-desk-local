import assert from 'node:assert/strict';
import { test } from 'node:test';
import { benchSets, changePercent, minutesUntil, roleSummary, applyEvents, buildTimeline, emptyTimeline, formatDuration, formatTokens, gateLabel, gateSummary, statusTone, stepDurationMs } from '../src/model.ts';
import { acceptImage, asList, readFrontmatter, benchSetOf, modeNeeds, projectList, projectName, sameProject, feedbackTargets, targetLocation } from '../src/model.ts';
import type { StoredEvent } from '../src/model.ts';

const at = (second: number) => `2026-11-16T09:00:${String(second).padStart(2, '0')}.000Z`;
const events: StoredEvent[] = [
  { seq: 1, at: at(0), type: 'run_started', data: { type: 'run_started', request: 'x' } },
  { seq: 2, at: at(1), type: 'step_started', data: { type: 'step_started', step: 'build', role: 'builder' } },
  { seq: 3, at: at(2), type: 'runtime', data: { type: 'runtime', step: 'build', role: 'builder', event: { type: 'command', command: 'npm test', exitCode: 0 } } },
  { seq: 4, at: at(3), type: 'runtime', data: { type: 'runtime', step: 'build', role: 'builder', event: { type: 'file_change', path: 'a.txt' } } },
  { seq: 5, at: at(4), type: 'gate', data: { type: 'gate', result: { gate: 'G2', ok: true, detail: 'ok' } } },
  { seq: 6, at: at(5), type: 'step_finished', data: { type: 'step_finished', step: 'build', ok: true, detail: '' } },
  { seq: 7, at: at(6), type: 'step_started', data: { type: 'step_started', step: 'review', role: 'verifier' } },
  { seq: 8, at: at(7), type: 'gate', data: { type: 'gate', result: { gate: 'G4', ok: false, attempt: 1, detail: 'REDO', problems: ['R4'] } } },
  { seq: 9, at: at(8), type: 'redo', data: { type: 'redo', attempt: 1, mode: 'same-session', reasons: ['R4 missing'] } },
  { seq: 10, at: at(9), type: 'run_finished', data: { type: 'run_finished', status: 'needs_review', reason: 'still failing' } },
];

test('buildTimeline groups events by step and counts commands and file changes', () => {
  const timeline = buildTimeline(events);
  assert.deepEqual(timeline.steps.map(step => step.step), ['build', 'review']);
  const build = timeline.steps[0]!;
  assert.equal(build.commands, 1);
  assert.equal(build.fileChanges, 1);
  assert.equal(build.ok, true);
  assert.equal(stepDurationMs(build), 4000);
  assert.equal(stepDurationMs(timeline.steps[1]!), null);
  assert.deepEqual(timeline.finished, { status: 'needs_review', reason: 'still failing' });
  assert.equal(timeline.lastSeq, 10);
});

test('applyEvents is incremental and ignores events it has already seen', () => {
  const first = applyEvents(emptyTimeline(), events.slice(0, 5));
  const second = applyEvents(first, events);
  assert.equal(second.steps.length, 2);
  assert.equal(second.steps[0]!.gates.length, 1);
  assert.equal(applyEvents(second, events), second);
  assert.equal(first.steps.length, 1);
  assert.equal(first.steps[0]!.gates.length, 1);
  assert.equal(first.lastSeq, 5);
});

test('gate labels, summary, and redo reasons', () => {
  const timeline = buildTimeline(events);
  assert.equal(gateLabel({ gate: 'G4', ok: false, attempt: 1, detail: '' }), 'G4#1 failed');
  assert.equal(gateLabel({ gate: 'G3', ok: true, skipped: true, detail: '' }), 'G3 skipped');
  assert.deepEqual(gateSummary(timeline), [{ gate: 'G2', ok: 1, failed: 0, skipped: 0 }, { gate: 'G4', ok: 0, failed: 1, skipped: 0 }]);
  assert.deepEqual(timeline.steps[1]!.redo[0]?.reasons, ['R4 missing']);
});

test('formatting helpers and status tones', () => {
  assert.equal(formatTokens(915375), '915k');
  assert.equal(formatTokens(41), '41');
  assert.equal(formatTokens(2_340_000), '2.3M');
  assert.equal(formatTokens(-1), '-');
  assert.equal(formatDuration(6900), '7 s');
  assert.equal(formatDuration(414_000), '6 min 54 s');
  assert.equal(statusTone('completed'), 'success');
  assert.equal(statusTone('needs_review'), 'warning');
  assert.equal(statusTone('failed'), 'danger');
  assert.equal(statusTone('running'), 'accent');
  assert.equal(statusTone('whatever'), 'neutral');
});

test('role summary adds time and tokens per role and keeps unknown usage apart', () => {
  const timeline = buildTimeline(events);
  const summary = roleSummary(timeline, [
    { stepId: timeline.steps[0]!.step, usage: { totalTokens: 100 } },
    { stepId: `${timeline.steps[0]!.step}:2`, usage: { totalTokens: 20 } },
    { stepId: 'mystery', usage: { totalTokens: 5 } },
  ]);
  const first = summary.find(entry => entry.role === timeline.steps[0]!.role)!;
  assert.equal(first.tokens, 120);
  assert.equal(summary.find(entry => entry.role === 'other')!.tokens, 5);
  assert.equal(minutesUntil(1000 + 600, 1000 * 1000), 10);
  assert.equal(minutesUntil(null, 0), null);
  assert.equal(minutesUntil(10, 20_000), null);
});

test('bench sets pair v1 with v2 inside the same task set and compute changes', () => {
  const summary = (label: string, meanTokens: number) => ({ label, enabledAgents: null, runs: 1, excluded: 0, successRate: 1, claimedRate: 1, falseCompletionRate: 0, meanTokens, medianTokens: meanTokens, meanAgents: 2, meanMinutes: 1, meanAccountPercent: null, perTask: {} });
  const sets = benchSets([summary('v1-13', 600), summary('v1-13-hard', 1100), summary('v2-codex-auto', 200), summary('v2-codex-auto-hard', 500)]);
  assert.deepEqual(sets.map(set => [set.id, set.baseline?.label, set.challengers.map(item => item.label)]), [['standard', 'v1-13', ['v2-codex-auto']], ['hard', 'v1-13-hard', ['v2-codex-auto-hard']]]);
  assert.equal(changePercent(600, 200), -67);
  assert.equal(changePercent(0, 5), null);
  assert.equal(changePercent(null, 5), null);
  assert.deepEqual(benchSets([summary('v2-only', 1)]).map(set => [set.id, set.baseline]), [['standard', null]]);
});

test('timeline keeps runtimes per role and the questions agents asked', () => {
  const timeline = buildTimeline([
    { seq: 1, at: 't1', type: 'run_started', data: { type: 'run_started', request: 'x', runtimes: { builder: 'codex', verifier: 'claude' } } },
    { seq: 2, at: 't2', type: 'user_question', data: { type: 'user_question', step: 'plan', question: 'Proceed?', answered: true } },
  ]);
  assert.deepEqual(timeline.runtimes, { builder: 'codex', verifier: 'claude' });
  assert.deepEqual(timeline.questions, [{ step: 'plan', question: 'Proceed?', answered: true }]);
});

test('project list merges saved folders and run history, newest first', () => {
  const list = projectList(['C:\\work\\a', 'D:\\b'], [
    { project: 'c:\\work\\a', startedAt: '2026-11-10' },
    { project: 'E:\\c', startedAt: '2026-11-12' },
  ], 'E:\\c');
  assert.deepEqual(list.map(entry => entry.name), ['c', 'a', 'b']);
  assert.equal(list[0]!.active, true);
  assert.equal(list[1]!.runs, 1);
  assert.equal(projectName('/home/me/proj/'), 'proj');
  assert.equal(sameProject('C:\\A\\', 'c:\\a'), true);
  assert.deepEqual(modeNeeds('codex+claude'), ['codex', 'claude']);
  assert.deepEqual(modeNeeds('claude'), ['claude']);
});

test('bench labels ending in -general form their own set', () => {
  assert.equal(benchSetOf('v2-general'), 'general');
  assert.equal(benchSetOf('v1-13-hard'), 'hard');
  assert.equal(benchSetOf('v2-codex-auto'), 'standard');
});

test('frontmatter of role files and skills reads lists in both forms', () => {
  const role = readFrontmatter('---\ndescription: Builds\naccess: workspace-write\nskills: [a, b]\nmodel-claude: sonnet\n---\nUse tabs.\n');
  assert.deepEqual(role.data.skills, ['a', 'b']);
  assert.equal(role.data['model-claude'], 'sonnet');
  assert.equal(role.body, 'Use tabs.');
  assert.deepEqual(readFrontmatter('---\nskills:\n  - x\n  - y\n---\n').data.skills, ['x', 'y']);
  assert.deepEqual(readFrontmatter('no frontmatter').data, {});
  assert.deepEqual(asList('one'), ['one']);
});

test('image attachments follow the server limits', () => {
  assert.equal(acceptImage(0, { type: 'image/png', size: 100 }), 'ok');
  assert.equal(acceptImage(4, { type: 'image/png', size: 100 }), 'count');
  assert.equal(acceptImage(0, { type: 'application/pdf', size: 100 }), 'type');
  assert.equal(acceptImage(0, { type: 'image/jpeg', size: 6 * 1024 * 1024 }), 'size');
});

test('timeline lists the skills sessions opened', () => {
  const timeline = buildTimeline([{ seq: 1, at: 't', type: 'skill_read', data: { type: 'skill_read', step: 'build', role: 'builder', skill: 'html-output' } }]);
  assert.deepEqual(timeline.skillsRead, [{ step: 'build', role: 'builder', skill: 'html-output' }]);
});

test('a 👎 offers the files that fit its cause, the ones this run touched first, and each opens the right editor', () => {
  const context = { skillsRead: ['html-output'], projectSkills: ['review-checklist', 'html-output'], roles: ['lead', 'builder', 'lead'] };
  assert.deepEqual(feedbackTargets('skill', context), ['.agent-desk/skills/html-output/SKILL.md', '.agent-desk/skills/review-checklist/SKILL.md']);
  assert.deepEqual(feedbackTargets('role', context), ['lead', 'builder', 'verifier', 'researcher'].map(role => `.agent-desk/agents/${role}.md`));
  assert.deepEqual(feedbackTargets('workflow', context), ['.agent-desk/config.json', '.agent-desk/agents/lead.md']);
  assert.deepEqual(feedbackTargets('other', context), []);
  assert.deepEqual(targetLocation('.agent-desk/config.json'), { tab: 'config' });
  assert.deepEqual(targetLocation('.agent-desk/agents/builder.md'), { tab: 'roles', id: 'builder' });
  assert.deepEqual(targetLocation('.agent-desk/skills/html-output/SKILL.md'), { tab: 'skills', id: 'html-output' });
  assert.equal(targetLocation('.agent-desk/agents/hacker.md'), null);
  assert.equal(targetLocation('src/app.js'), null);
});
