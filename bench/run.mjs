#!/usr/bin/env node
// Runs the fixed benchmark tasks through a running Agent Desk server and grades
// each result with hidden tests. Every task gets a fresh copy of the sample app
// registered as a new Agent Desk project, so no conversation memory or main-AI
// thread leaks between tasks.
//
//   node bench/run.mjs --label baseline-13 [--tasks T01,T05] [--repeat 1]
//                      [--url http://127.0.0.1:4317] [--timeout-min 40]
//                      [--usage-limit 20] [--work-dir <dir>] [--results-dir <dir>]
//
// Results are written to bench/results/runs/<label>/<task>-r<n>.json. Existing
// result files are skipped, so an interrupted batch can simply be re-run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchDirectory, loadTasks, prepareWorkspace, evaluate } from './lib/evaluate.mjs';

const TERMINAL = new Set(['completed', 'needs_review', 'failed', 'interrupted']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseArgs(argv) {
  const options = { repeat: 1, url: 'http://127.0.0.1:4317', timeoutMin: 40, pollMs: 3000, workDir: path.join(os.tmpdir(), 'agent-desk-bench'), resultsDir: path.join(benchDirectory, 'results', 'runs') };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index].replace(/^--/, '');
    const value = argv[++index];
    if (key === 'label') options.label = value;
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
  if (!Number.isInteger(options.repeat) || options.repeat < 1) throw new Error('--repeat must be a positive integer');
  return options;
}

class AgentDesk {
  constructor(url) { this.url = url; this.csrf = null; }
  async get(pathname) {
    const response = await fetch(this.url + pathname);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `${pathname} ${response.status}`);
    return body;
  }
  async state() { const state = await this.get('/api/state'); this.csrf = state.csrf; return state; }
  async post(pathname, input) {
    if (!this.csrf) await this.state();
    const response = await fetch(this.url + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Desk-Token': this.csrf }, body: JSON.stringify(input) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || `${pathname} ${response.status}`), { status: response.status });
    return body;
  }
}

const usage = run => {
  const value = field => Number(run.usage?.[field]) || 0;
  return { totalTokens: value('totalTokens'), inputTokens: value('inputTokens'), cachedInputTokens: value('cachedInputTokens'), uncachedInputTokens: Math.max(0, value('inputTokens') - value('cachedInputTokens')), outputTokens: value('outputTokens') };
};
const isConsultation = task => task.consultation === true || /^협의 응답/.test(task.title || '');
const verdictOf = task => task.output?.match(/^\s*\[검증 결과:\s*(PASS|FAIL|NOT_VERIFIED)\]/im)?.[1] || 'NONE';

export function runMetrics(run) {
  const tasks = run.tasks || [];
  const work = tasks.filter(task => task.agentId !== 'main' && task.agentId !== 'prompt_refiner' && !isConsultation(task));
  const perAgent = {};
  for (const task of tasks) {
    const entry = (perAgent[task.agentId] ||= { calls: 0, tokens: 0 });
    entry.calls++; entry.tokens += Number(task.usage?.totalTokens) || 0;
  }
  const verdicts = work.filter(task => task.agentId === 'verifier').map(verdictOf);
  return {
    status: run.status,
    endReason: run.endReason?.kind || null,
    qualityGate: run.qualityGate?.status || null,
    usage: usage(run),
    accountPercent: Number.isFinite(run.accountUsage?.consumedPercent) ? run.accountUsage.consumedPercent : null,
    durationSec: run.finishedAt && run.startedAt ? (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000 : null,
    agentCount: new Set(work.map(task => task.agentId)).size,
    agents: [...new Set(work.map(task => task.agentId))],
    workTasks: work.length,
    consultations: tasks.filter(isConsultation).length,
    retries: work.filter(task => task.retryOfTaskId || task.retryAttempt).length,
    failedTasks: work.filter(task => task.status !== 'completed').length,
    verifierVerdicts: verdicts,
    requiredAgents: run.routing?.requiredAgentIds || [],
    perAgent,
  };
}

async function waitForIdle(desk, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await desk.state();
    if (!state.activeRunId) return state;
    if (Date.now() > deadline) throw new Error(`Agent Desk is still busy with run ${state.activeRunId}`);
    await sleep(2000);
  }
}

async function executeTask(desk, task, attempt, options, log) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const workspace = prepareWorkspace(path.join(options.workDir, options.label, `${task.id}-r${attempt}-${stamp}`));
  const project = await desk.post('/api/projects', { name: `bench ${options.label} ${task.id} r${attempt}`.slice(0, 80), path: workspace.path, allowWrites: true, autoApproveCommands: true, allowLocalProcesses: false });
  const started = await desk.post('/api/runs', { projectId: project.id, message: task.prompt, refinePrompt: false });
  log(`  run ${started.id} started in ${workspace.path}`);
  const deadline = Date.now() + options.timeoutMin * 60_000;
  let allowAllSent = false, cancelSent = false, blockedSince = null, cancelReason = null, run = null;
  for (;;) {
    await sleep(options.pollMs);
    const state = await desk.state();
    run = state.runs.find(item => item.id === started.id);
    if (!run) throw new Error('run disappeared from Agent Desk state');
    if (TERMINAL.has(run.status) && state.activeRunId !== run.id) break;
    const approvals = (state.approvals || []).length;
    if (approvals && !allowAllSent) {
      await desk.post('/api/approvals/allow-all', { enabled: true }).catch(() => {});
      allowAllSent = true;
      log('  approvals requested; enabled allow-all for this run');
    }
    blockedSince = approvals ? (blockedSince ?? Date.now()) : null;
    if (!cancelReason && blockedSince && Date.now() - blockedSince > 120_000) cancelReason = 'blocked_on_approval';
    if (!cancelReason && Date.now() > deadline) cancelReason = 'bench_timeout';
    if (cancelReason && !cancelSent) {
      cancelSent = true;
      log(`  cancelling: ${cancelReason}`);
      await desk.post('/api/cancel', { id: run.id }).catch(() => {});
    }
  }
  await waitForIdle(desk, 120_000);
  const grade = evaluate(task, workspace.path, { answer: run.answer || '', before: workspace.snapshot });
  const metrics = runMetrics(run);
  const claimedSuccess = run.status === 'completed';
  const lastVerdict = metrics.verifierVerdicts.at(-1) || null;
  return {
    label: options.label,
    taskId: task.id,
    category: task.category,
    attempt,
    runId: run.id,
    projectId: project.id,
    workspace: workspace.path,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    cancelReason,
    metrics,
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
  const desk = new AgentDesk(options.url);
  const health = await desk.get('/api/health').catch(error => { throw new Error(`Agent Desk is not reachable at ${options.url}: ${error.message}`); });
  if (health.connection !== 'connected') throw new Error(`Agent Desk is not connected to Codex (${health.connection})`);
  let state = await waitForIdle(desk, 10 * 60_000);
  if (options.usageLimit) {
    await desk.post('/api/settings', { ...state.settings, usagePercentLimit: options.usageLimit });
    state = await desk.state();
  }
  const outputDirectory = path.join(options.resultsDir, options.label);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const config = {
    label: options.label,
    recordedAt: new Date().toISOString(),
    settings: state.settings,
    agents: state.agents.map(agent => ({ id: agent.id, name: agent.name, enabled: agent.enabled, model: agent.model, effort: agent.effort, access: agent.access })),
    skills: (state.skills || []).map(skill => ({ id: skill.id, enabled: skill.enabled, agentIds: skill.agentIds })),
    node: process.version,
    platform: process.platform,
  };
  fs.writeFileSync(path.join(outputDirectory, '_config.json'), JSON.stringify(config, null, 2));
  log(`Agent Desk benchmark "${options.label}": ${tasks.length} task(s) x ${options.repeat}, ${config.agents.filter(agent => agent.enabled).length} enabled agents`);

  const summary = [];
  for (let attempt = 1; attempt <= options.repeat; attempt++) {
    for (const task of tasks) {
      const file = path.join(outputDirectory, `${task.id}-r${attempt}.json`);
      if (fs.existsSync(file)) { log(`${task.id} r${attempt}: already recorded, skipping`); continue; }
      log(`${task.id} r${attempt}: ${task.title}`);
      let result;
      try {
        result = await executeTask(desk, task, attempt, options, log);
      } catch (error) {
        if (/한도|usage|사용률/i.test(error.message)) {
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
