#!/usr/bin/env node
// Runs the fixed benchmark tasks through an Agent Desk version and grades each
// result with hidden tests. Every task gets a fresh copy of the sample app, so
// no conversation memory or main-AI thread leaks between tasks. Talking to a
// specific Agent Desk version is the adapter's job (bench/adapters/<name>.mjs);
// preparing workspaces, grading and recording results are shared here.
//
//   node bench/run.mjs --label v1-13 [--adapter v1] [--tasks T01,T05] [--repeat 1]
//                      [--url http://127.0.0.1:4317] [--timeout-min 40]
//                      [--usage-limit 20] [--work-dir <dir>] [--results-dir <dir>]
//
// Results are written to bench/results/runs/<label>/<task>-r<n>.json. Existing
// result files are skipped, so an interrupted batch can simply be re-run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { benchDirectory, loadTasks, prepareWorkspace, evaluate } from './lib/evaluate.mjs';

const ADAPTERS = ['v1'];

export function parseArgs(argv) {
  const options = { adapter: 'v1', repeat: 1, url: 'http://127.0.0.1:4317', timeoutMin: 40, pollMs: 3000, workDir: path.join(os.tmpdir(), 'agent-desk-bench'), resultsDir: path.join(benchDirectory, 'results', 'runs') };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index].replace(/^--/, '');
    const value = argv[++index];
    if (key === 'label') options.label = value;
    else if (key === 'adapter') options.adapter = value;
    else if (key === 'tasks') options.tasks = value.split(',').map(item => item.trim()).filter(Boolean);
    else if (key === 'repeat') options.repeat = Number(value);
    else if (key === 'url') options.url = value.replace(/\/$/, '');
    else if (key === 'timeout-min') options.timeoutMin = Number(value);
    else if (key === 'usage-limit') options.usageLimit = Number(value);
    else if (key === 'work-dir') options.workDir = path.resolve(value);
    else if (key === 'results-dir') options.resultsDir = path.resolve(value);
    else if (key === 'poll-ms') options.pollMs = Number(value);
    else throw new Error(`unknown option --${key}`);
  }
  if (!options.label || !/^[\w.-]{1,60}$/.test(options.label)) throw new Error('--label is required (letters, digits, . _ -)');
  if (!ADAPTERS.includes(options.adapter)) throw new Error(`--adapter must be one of: ${ADAPTERS.join(', ')}`);
  if (!Number.isInteger(options.repeat) || options.repeat < 1) throw new Error('--repeat must be a positive integer');
  return options;
}

async function loadAdapter(options) {
  const file = path.join(benchDirectory, 'adapters', `${options.adapter}.mjs`);
  const { createAdapter } = await import(pathToFileURL(file).href);
  return createAdapter({ url: options.url, pollMs: options.pollMs });
}

async function executeTask(adapter, task, attempt, options, log) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const workspace = prepareWorkspace(path.join(options.workDir, options.label, `${task.id}-r${attempt}-${stamp}`));
  const run = await adapter.execute({ task, workspacePath: workspace.path, label: options.label, attempt, timeoutMin: options.timeoutMin, log });
  const grade = evaluate(task, workspace.path, { answer: run.answer, before: workspace.snapshot });
  const claimedSuccess = run.status === 'completed';
  const lastVerdict = run.metrics.verifierVerdicts.at(-1) || null;
  return {
    label: options.label,
    adapter: adapter.name,
    taskId: task.id,
    category: task.category,
    attempt,
    runId: run.runId,
    projectId: run.projectId,
    workspace: workspace.path,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    cancelReason: run.cancelReason,
    metrics: run.metrics,
    grade: {
      success: grade.success,
      changedFiles: grade.changedFiles,
      visible: grade.visible && { pass: grade.visible.pass, passed: grade.visible.passed, failed: grade.visible.failed, output: grade.visible.pass ? undefined : grade.visible.output },
      acceptance: grade.acceptance && { pass: grade.acceptance.pass, passed: grade.acceptance.passed, failed: grade.acceptance.failed, output: grade.acceptance.pass ? undefined : grade.acceptance.output },
      missing: grade.missing,
      unexpectedChanges: grade.unexpectedChanges,
    },
    // "Claimed done but objectively wrong" — the hallucinated-completion signal.
    claimedSuccess,
    falseCompletion: claimedSuccess && !grade.success,
    falseVerifierPass: lastVerdict === 'PASS' && !grade.success,
    answer: String(run.answer || '').slice(0, 4000),
  };
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  const options = parseArgs(argv);
  const tasks = loadTasks(options.tasks);
  if (!tasks.length) throw new Error('no matching tasks');
  const adapter = await loadAdapter(options);
  await adapter.connect();
  await adapter.configure({ usageLimit: options.usageLimit });
  const outputDirectory = path.join(options.resultsDir, options.label);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const config = { label: options.label, recordedAt: new Date().toISOString(), ...adapter.snapshotConfig(), node: process.version, platform: process.platform };
  fs.writeFileSync(path.join(outputDirectory, '_config.json'), JSON.stringify(config, null, 2));
  log(`Agent Desk benchmark "${options.label}" (${adapter.name}): ${tasks.length} task(s) x ${options.repeat}, ${config.agents.filter(agent => agent.enabled).length} enabled agents`);

  const summary = [];
  for (let attempt = 1; attempt <= options.repeat; attempt++) {
    for (const task of tasks) {
      const file = path.join(outputDirectory, `${task.id}-r${attempt}.json`);
      if (fs.existsSync(file)) { log(`${task.id} r${attempt}: already recorded, skipping`); continue; }
      log(`${task.id} r${attempt}: ${task.title}`);
      let result;
      try {
        result = await executeTask(adapter, task, attempt, options, log);
      } catch (error) {
        if (error.usageLimit) {
          log(`Stopped: ${error.message}\nRe-run the same command after the usage window resets; recorded tasks are skipped.`);
          process.exitCode = 2;
          return summary;
        }
        throw error;
      }
      fs.writeFileSync(file, JSON.stringify(result, null, 2));
      summary.push(result);
      log(`  -> ${result.metrics.status}, graded ${result.grade.success ? 'PASS' : 'FAIL'}, ${result.metrics.usage.totalTokens.toLocaleString('en-US')} tokens, ${result.metrics.agentCount} agent(s)${result.falseCompletion ? ', FALSE COMPLETION' : ''}`);
    }
  }
  log(`Done. Results: ${outputDirectory}\nSummarize with: node bench/report.mjs`);
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
