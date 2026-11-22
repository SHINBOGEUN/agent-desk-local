import assert from 'node:assert/strict';
import { test } from 'node:test';
import { benchSets, changePercent, minutesUntil, roleSummary, applyEvents, buildTimeline, emptyTimeline, formatDuration, formatTokens, gateLabel, gateSummary, statusTone, stepDurationMs } from '../src/model.ts';
import { acceptImage, asList, readFrontmatter, benchSetOf, modeNeeds, projectList, projectName, sameProject, feedbackTargets, targetLocation, setFrontmatterValue } from '../src/model.ts';
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
  // the review was never closed: it ends with the run (not left open forever)
  assert.equal(stepDurationMs(timeline.steps[1]!), 3000);
  assert.equal(timeline.steps[1]!.ok, null);
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
    { stepId: timeline.steps[0]!.step, usage: { totalTokens: 100, inputTokens: 90, cachedInputTokens: 0, outputTokens: 10 } },
    { stepId: `${timeline.steps[0]!.step}:2`, usage: { totalTokens: 20, inputTokens: 18, cachedInputTokens: 15, outputTokens: 2 } },
    { stepId: 'mystery', usage: { totalTokens: 5 } },
  ]);
  const first = summary.find(entry => entry.role === timeline.steps[0]!.role)!;
  assert.equal(first.tokens, 120);
  assert.deepEqual([first.calls, first.newInput, first.cachedInput, first.output], [2, 93, 15, 12]);
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

test('role settings change one frontmatter key and keep the rest of the file', () => {
  const file = '---\ndescription: Builds.\naccess: workspace-write\neffort: high\nskills: [a]\n---\n\n- Use pnpm.\n';
  assert.equal(setFrontmatterValue(file, 'effort', 'low'), '---\ndescription: Builds.\naccess: workspace-write\neffort: low\nskills: [a]\n---\n\n- Use pnpm.\n');
  assert.equal(setFrontmatterValue(file, 'model-codex', 'gpt-a'), '---\ndescription: Builds.\naccess: workspace-write\neffort: high\nskills: [a]\nmodel-codex: gpt-a\n---\n\n- Use pnpm.\n');
  assert.equal(setFrontmatterValue(setFrontmatterValue(file, 'model-codex', 'gpt-a'), 'model-codex', null), file);
  assert.equal(setFrontmatterValue(file, 'effort', null), '---\ndescription: Builds.\naccess: workspace-write\nskills: [a]\n---\n\n- Use pnpm.\n');
  assert.equal(setFrontmatterValue('just rules', 'effort', 'low'), '---\neffort: low\n---\n\njust rules');
  assert.equal(setFrontmatterValue('---\r\neffort: high\r\n---\r\nbody', 'effort', 'medium'), '---\neffort: medium\n---\nbody');
  assert.equal(setFrontmatterValue('---\nunclosed', 'effort', 'low'), '---\nunclosed');
});

test('review nested in a build closes only itself, and build time leaves out the review', () => {
  const nested: StoredEvent[] = [
    { seq: 1, at: at(0), type: 'step_started', data: { type: 'step_started', step: 'build', role: 'builder' } },
    { seq: 2, at: at(10), type: 'step_started', data: { type: 'step_started', step: 'review', role: 'verifier' } },
    { seq: 3, at: at(15), type: 'step_finished', data: { type: 'step_finished', step: 'review', ok: true, detail: 'verdict PASS' } },
    { seq: 4, at: at(16), type: 'step_finished', data: { type: 'step_finished', step: 'build', ok: true, detail: 'gates passed' } },
  ];
  const timeline = buildTimeline(nested);
  assert.equal(timeline.steps[0]!.detail, 'gates passed');
  assert.equal(timeline.steps[1]!.detail, 'verdict PASS');
  const summary = roleSummary(timeline, []);
  assert.equal(summary.find(entry => entry.role === 'builder')!.durationMs, 11_000);
  assert.equal(summary.find(entry => entry.role === 'verifier')!.durationMs, 5_000);
});

test('memory size and follow-up drafts', async () => {
  const { memoryChars, followUpRequest } = await import('../src/model.ts');
  assert.equal(memoryChars([]), '# Project memory'.length);
  assert.equal(memoryChars(['  a  b ', '']), '# Project memory\n\n- a b'.length);
  assert.equal(followUpRequest(56, ['add novalidate', 'test  blank titles'], 'ko'), '실행 #56의 리뷰 제안 중 아래를 반영해줘.\n- add novalidate\n- test blank titles');
  assert.match(followUpRequest(3, ['x'], 'en'), /^Apply these review suggestions from run #3:\n- x$/);
});

test('server messages read in Korean, keeping where the problem is', async () => {
  const { koServerText } = await import('../src/server-text.ts');
  assert.equal(koServerText('entry 2: same as entry 1'), '2번 항목: 1번 항목과 같습니다.');
  assert.equal(koServerText('entry 1: this looks like a secret; memory is committed to git, so do not store secrets in it'), '1번 항목: 비밀번호나 키처럼 보입니다. 메모는 git에 올라가므로 비밀값을 넣지 마세요.');
  assert.equal(koServerText('review-checklist: description does not say when NOT to use it; models skip or over-use skills without an exclusion'), 'review-checklist: description에 쓰지 말아야 할 때가 없습니다. 제외 조건이 없으면 모델이 스킬을 건너뛰거나 과하게 씁니다.');
  assert.equal(koServerText('role:builder: absolute rules without a reason; say why so the model can judge edge cases'), 'role:builder: 이유 없는 절대 규칙이 있습니다. 이유를 적어야 모델이 예외 상황을 판단할 수 있습니다.');
  assert.equal(koServerText('.agent-desk/agents/lead.md: effort must be "low", "medium" or "high"'), '.agent-desk/agents/lead.md: effort는 "low", "medium", "high" 중 하나여야 합니다.');
  assert.equal(koServerText('config.limits.redo: expected a non-negative number'), 'config.limits.redo: 0 이상의 숫자여야 합니다.');
  assert.equal(koServerText('something new'), 'something new');
});

test('graph layout is deterministic, stays inside the box and pulls linked notes together', async () => {
  const { layoutGraph, neighbours, insertLink, hashUnit } = await import('../src/graph.ts');
  const nodes = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, links: 1 }));
  const edges = [{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }];
  const first = layoutGraph(nodes, edges, { width: 400, height: 300 });
  const again = layoutGraph(nodes, edges, { width: 400, height: 300 });
  assert.deepEqual([...first.entries()], [...again.entries()]);
  for (const point of first.values()) { assert.ok(point.x >= 24 && point.x <= 376); assert.ok(point.y >= 24 && point.y <= 276); }
  const gap = (x: string, y: string) => Math.hypot(first.get(x)!.x - first.get(y)!.x, first.get(x)!.y - first.get(y)!.y);
  assert.ok(gap('a', 'b') < gap('a', 'e'));
  assert.deepEqual([...neighbours('a', edges)], ['b']);
  assert.deepEqual(insertLink('see  here', 4, 4, 'Login'), { text: 'see [[Login]] here', cursor: 13 });
  assert.deepEqual(insertLink('replace me', 0, 7, 'X'), { text: '[[X]] me', cursor: 5 });
  assert.ok(hashUnit('x') >= 0 && hashUnit('x') < 1);
  assert.equal(layoutGraph([], [], { width: 10, height: 10 }).size, 0);
});

test('3D layout fits linked notes in the unit sphere and projects near points larger than far ones', async () => {
  const { layoutGraph3D, project3D } = await import('../src/graph.ts');
  const nodes = ['a', 'b', 'c', 'd', 'lonely'].map(id => ({ id, links: 1 }));
  const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }];
  const points = layoutGraph3D(nodes, edges);
  assert.deepEqual([...points.entries()], [...layoutGraph3D(nodes, edges).entries()]);
  for (const id of ['a', 'b', 'c', 'd']) { const p = points.get(id)!; assert.ok(Math.hypot(p.x, p.y, p.z) <= 1.0001); }
  const lonely = points.get('lonely')!;
  assert.ok(Math.hypot(lonely.x, lonely.y, lonely.z) <= 1.1501);
  const near = project3D({ x: 0, y: 0, z: 1 }, 0, 0);
  const far = project3D({ x: 0, y: 0, z: -1 }, 0, 0);
  assert.ok(near.scale > far.scale && near.depth > far.depth);
  assert.ok(Math.abs(project3D({ x: 1, y: 0, z: 0 }, Math.PI / 2, 0).x) < 1e-9);
});
