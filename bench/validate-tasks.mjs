#!/usr/bin/env node
// Proves the benchmark is fair: every code task must FAIL on the untouched
// sample app and PASS after its reference solution is applied, and the sample
// app's own tests must pass in both states. Answer tasks are checked against a
// correct and an incorrect sample answer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadTasks, prepareWorkspace, evaluate } from './lib/evaluate.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desk-bench-validate-'));
let problems = 0;
const report = (ok, message) => { if (!ok) problems++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`); };

try {
  for (const task of loadTasks()) {
    if (task.kind === 'answer') {
      const workspace = prepareWorkspace(path.join(scratch, `${task.id}-answer`));
      const good = evaluate(task, workspace.path, { answer: `기본 포트는 ${task.expect.answerIncludes.join(', 경로는 ')} 입니다.`, before: workspace.snapshot });
      report(good.success, `${task.id} accepts a correct answer`);
      const bad = evaluate(task, workspace.path, { answer: '기본 포트는 8080입니다.', before: workspace.snapshot });
      report(!bad.success, `${task.id} rejects an incorrect answer`);
      fs.writeFileSync(path.join(workspace.path, 'src', 'config.mjs'), '// edited\n', { flag: 'a' });
      const edited = evaluate(task, workspace.path, { answer: task.expect.answerIncludes.join(' '), before: workspace.snapshot });
      report(!edited.success, `${task.id} rejects an answer that modified files`);
      continue;
    }
    const base = prepareWorkspace(path.join(scratch, `${task.id}-base`));
    const before = evaluate(task, base.path, { before: base.snapshot });
    report(before.visible.pass, `${task.id} sample app tests pass before changes`);
    report(!before.acceptance.pass, `${task.id} hidden test fails on the untouched sample app`);

    const solved = prepareWorkspace(path.join(scratch, `${task.id}-solved`));
    const { apply } = await import(pathToFileURL(path.join(task.directory, 'solution.mjs')).href);
    apply(solved.path);
    const after = evaluate(task, solved.path, { before: solved.snapshot });
    report(after.success, `${task.id} reference solution passes hidden + visible tests${after.success ? '' : `\n${after.visible.pass ? '' : after.visible.output}${after.acceptance.output}`}`);
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(problems ? `\n${problems} problem(s) found.` : '\nAll benchmark tasks are valid.');
process.exitCode = problems ? 1 : 0;
