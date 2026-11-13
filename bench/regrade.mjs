#!/usr/bin/env node
// Re-grades recorded runs against the CURRENT hidden tests without re-running the
// agents. Use it only when a hidden test was wrong (for example it relied on an
// interface the prompt never specified). The agent's workspace is read as it was
// left, so the original run stays valid. The previous grade is kept in `regrade`.
//
//   node bench/regrade.mjs --label v1-13-hard --tasks H03 --reason "why the test changed"
import fs from 'node:fs';
import path from 'node:path';
import { benchDirectory, loadTasks, evaluateCode } from './lib/evaluate.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []));
if (!args.label || !args.tasks || !args.reason) { console.error('usage: node bench/regrade.mjs --label <label> --tasks H03[,H04] --reason "<why>"'); process.exit(2); }
const directory = path.join(benchDirectory, 'results', 'runs', args.label);
const tasks = loadTasks(args.tasks.split(',').map(item => item.trim()).filter(Boolean), 'all');
let changed = 0;
for (const task of tasks) {
  for (const name of fs.readdirSync(directory).filter(file => new RegExp(`^${task.id}-r\\d+\\.json$`).test(file)).sort()) {
    const file = path.join(directory, name);
    const result = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!result.workspace || !fs.existsSync(result.workspace)) { console.log(`${name}: workspace not found (${result.workspace}), skipped`); continue; }
    const graded = evaluateCode(task, result.workspace);
    const before = result.grade.success;
    result.regrade = { at: new Date().toISOString(), reason: args.reason, previous: { success: before, visible: result.grade.visible?.pass, acceptance: result.grade.acceptance?.pass } };
    result.grade = { ...result.grade, success: graded.success, visible: graded.visible, acceptance: graded.acceptance };
    result.falseCompletion = result.claimedSuccess && !graded.success;
    const lastVerdict = result.metrics?.verifierVerdicts?.at(-1) || null;
    result.falseVerifierPass = lastVerdict === 'PASS' && !graded.success;
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
    if (before !== graded.success) changed++;
    console.log(`${name}: ${before ? 'PASS' : 'FAIL'} -> ${graded.success ? 'PASS' : 'FAIL'}${result.falseCompletion ? ' (false completion)' : ''}`);
  }
}
console.log(`\nRegraded; ${changed} result(s) changed.`);
