// Benchmark adapter for Agent Desk v2 (packages/). Runs the v2 CLI once per task
// (`agent-desk run --json --unattended`) and maps its RunResult to the
// benchmark's common shape (see adapters/v1.mjs for the adapter contract).
//
// Options (passed by bench/run.mjs):
//   cli      command that starts the CLI as an argv array. Default:
//            [process.execPath, <repo>/packages/cli/src/bin.ts]
//   review   always | auto | never (v2 default policy applies when omitted)
//   verify   verify commands given to the harness. Default ["npm test"]
//   mode     codex | claude | codex+claude | claude+codex (builder+reviewer)
//   maxTokens, maxMinutes  harness budget (G5)
// The 5-hour account usage limit is not enforced here: v2 tracks quota in phase 4.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORK_STEPS = { build: 'builder', review: 'verifier', research: 'researcher' };
const ROLE_OF_STEP = step => WORK_STEPS[step] || 'lead';
const VERDICT = { PASS: 'PASS', REDO: 'FAIL', BLOCKED: 'NOT_VERIFIED' };

function runProcess(command, args, { timeoutMs, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs) : null;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { if (timer) clearTimeout(timer); reject(error); });
    child.on('close', code => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

/** v2 RunResult -> common metrics. */
export function runMetrics(result, durationSec) {
  const entries = result.usageEntries || [];
  const total = field => Number(result.usage?.[field]) || 0;
  const perAgent = {};
  for (const entry of entries) {
    const role = ROLE_OF_STEP(String(entry.stepId).split(/[#:]/)[0]);
    const slot = (perAgent[role] ||= { calls: 0, tokens: 0 });
    slot.calls++; slot.tokens += Number(entry.delta?.totalTokens) || 0;
  }
  const workRoles = Object.keys(perAgent).filter(role => role !== 'lead');
  return {
    status: result.status,
    workflow: result.workflow ?? null,
    endReason: result.status === 'completed' ? null : result.failureType || result.status,
    qualityGate: result.gates?.some(gate => gate.gate === 'G3' && !gate.skipped) ? (result.gates.filter(gate => gate.gate === 'G3').at(-1).ok ? 'passed' : 'failed') : 'not_required',
    usage: { totalTokens: total('totalTokens'), inputTokens: total('inputTokens'), cachedInputTokens: total('cachedInputTokens'), uncachedInputTokens: Math.max(0, total('inputTokens') - total('cachedInputTokens')), outputTokens: total('outputTokens') },
    accountPercent: null,
    durationSec,
    agentCount: workRoles.length,
    agents: workRoles,
    workTasks: workRoles.reduce((sum, role) => sum + perAgent[role].calls, 0),
    consultations: 0,
    retries: Number(result.redo) || 0,
    failedTasks: result.status === 'failed' ? 1 : 0,
    verifierVerdicts: result.review ? [VERDICT[result.review.verdict] || 'NONE'] : [],
    requiredAgents: [],
    perAgent,
    redo: Number(result.redo) || 0,
    reviewSkipped: result.reviewSkipped || null,
    unverified: result.unverified?.length || 0,
    gates: (result.gates || []).map(gate => `${gate.gate}:${gate.skipped ? 'skip' : gate.ok ? 'ok' : 'fail'}`),
  };
}

export function createAdapter({ cli, review, verify: verifyOption, maxTokens, maxMinutes, runtime, mode, noSkills } = {}) {
  const explicitVerify = Array.isArray(verifyOption) && verifyOption.length > 0;
  const verify = explicitVerify ? verifyOption : ['npm test'];
  const command = cli || [process.execPath, path.join(repoRoot, 'packages', 'cli', 'src', 'bin.ts')];
  const base = [...command.slice(1)];

  return {
    name: 'v2',
    async connect() {
      const { code, stdout, stderr } = await runProcess(command[0], [...base, 'doctor', ...(runtime ? ['--runtime', runtime] : [])], { timeoutMs: 60_000, cwd: repoRoot })
        .catch(error => { throw new Error(`Agent Desk v2 CLI could not start: ${error.message}`); });
      const failures = stdout.split(/\r?\n/).filter(line => line.startsWith('FAIL') && !/verify commands|project config|role files/.test(line));
      if (failures.length || (code !== 0 && code !== 1)) throw new Error(`Agent Desk v2 doctor reported problems:\n${failures.join('\n') || stderr.trim() || `exit code ${code}`}\nRun "npm run agent-desk -- doctor" for details.`);
    },
    async configure() { /* usage window limits arrive with phase 4 */ },
    snapshotConfig() {
      return {
        adapter: 'v2',
        settings: { review: review || 'default', verify, maxTokens: maxTokens ?? null, maxMinutes: maxMinutes ?? null, runtime: runtime || 'config', mode: mode || (runtime ? null : 'config'), skills: noSkills ? 'off' : 'project' },
        agents: ['lead', 'builder', 'verifier'].map(id => ({ id, name: id, enabled: true })),
        skills: [],
      };
    },
    async execute({ task, workspacePath, timeoutMin, verify: sampleVerify, log = () => {} }) {
      const args = [...base, 'run', task.prompt, '--project', workspacePath, '--unattended', '--json'];
      for (const item of (explicitVerify ? verify : [sampleVerify || verify[0]])) args.push('--verify', item);
      if (review) args.push('--review', review);
      if (maxTokens) args.push('--max-tokens', String(maxTokens));
      if (maxMinutes) args.push('--max-minutes', String(maxMinutes));
      if (runtime) args.push('--runtime', runtime);
      if (mode) args.push('--mode', mode);
      if (noSkills) args.push('--no-skills');
      const startedAt = new Date();
      log(`  agent-desk run in ${workspacePath}`);
      const { code, stdout, stderr, timedOut } = await runProcess(command[0], args, { timeoutMs: timeoutMin * 60_000, cwd: repoRoot });
      const finishedAt = new Date();
      const durationSec = (finishedAt - startedAt) / 1000;
      if (timedOut) {
        return { runId: null, projectId: workspacePath, status: 'interrupted', answer: '', startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), cancelReason: 'bench_timeout', metrics: runMetrics({ status: 'interrupted', usage: {}, usageEntries: [], gates: [] }, durationSec) };
      }
      let result;
      try { result = JSON.parse(stdout); } catch { /* handled below */ }
      if (!result || typeof result.status !== 'string') {
        if (/budget|token/i.test(stderr) && /limit|usage/i.test(stderr)) throw Object.assign(new Error(stderr.trim()), { usageLimit: true });
        throw new Error(`Agent Desk v2 did not return a result (exit code ${code}). ${stderr.trim().split(/\r?\n/).slice(-5).join(' | ')}`);
      }
      return { runId: null, projectId: workspacePath, status: result.status, answer: result.answer?.answer || '', startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), cancelReason: result.status === 'interrupted' ? 'interrupted' : null, metrics: runMetrics(result, durationSec) };
    },
  };
}
