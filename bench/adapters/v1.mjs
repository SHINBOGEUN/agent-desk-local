// Benchmark adapter for Agent Desk v1 (legacy/). Talks to a running v1 server
// over its HTTP API and maps v1's run record to the benchmark's common shape.
//
// Every adapter exports createAdapter(options) returning:
//   connect()                      -> throws if the server is not usable
//   configure({ usageLimit })      -> optional per-batch settings
//   snapshotConfig()               -> agents/settings recorded with results
//   execute({ task, workspacePath, label, attempt, timeoutMin, log })
//                                  -> { runId, projectId, status, answer,
//                                       startedAt, finishedAt, cancelReason, metrics }
// Adapters throw an Error with `usageLimit: true` when the account usage window
// blocks new runs, so the runner can stop the batch and resume later.

const TERMINAL = new Set(['completed', 'needs_review', 'failed', 'interrupted']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class Client {
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

const isConsultation = task => task.consultation === true || /^협의 응답/.test(task.title || '');
const verdictOf = task => task.output?.match(/^\s*\[검증 결과:\s*(PASS|FAIL|NOT_VERIFIED)\]/im)?.[1] || 'NONE';

// v1 run record -> common metrics. Each benchmark task uses a fresh project, so
// v1's main thread is new and its cumulative token total equals this run's usage.
export function runMetrics(run) {
  const value = field => Number(run.usage?.[field]) || 0;
  const tasks = run.tasks || [];
  const work = tasks.filter(task => task.agentId !== 'main' && task.agentId !== 'prompt_refiner' && !isConsultation(task));
  const perAgent = {};
  for (const task of tasks) {
    const entry = (perAgent[task.agentId] ||= { calls: 0, tokens: 0 });
    entry.calls++; entry.tokens += Number(task.usage?.totalTokens) || 0;
  }
  return {
    status: run.status,
    endReason: run.endReason?.kind || null,
    qualityGate: run.qualityGate?.status || null,
    usage: { totalTokens: value('totalTokens'), inputTokens: value('inputTokens'), cachedInputTokens: value('cachedInputTokens'), uncachedInputTokens: Math.max(0, value('inputTokens') - value('cachedInputTokens')), outputTokens: value('outputTokens') },
    accountPercent: Number.isFinite(run.accountUsage?.consumedPercent) ? run.accountUsage.consumedPercent : null,
    durationSec: run.finishedAt && run.startedAt ? (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000 : null,
    agentCount: new Set(work.map(task => task.agentId)).size,
    agents: [...new Set(work.map(task => task.agentId))],
    workTasks: work.length,
    consultations: tasks.filter(isConsultation).length,
    retries: work.filter(task => task.retryOfTaskId || task.retryAttempt).length,
    failedTasks: work.filter(task => task.status !== 'completed').length,
    verifierVerdicts: work.filter(task => task.agentId === 'verifier').map(verdictOf),
    requiredAgents: run.routing?.requiredAgentIds || [],
    perAgent,
  };
}

export function createAdapter({ url = 'http://127.0.0.1:4317', pollMs = 3000 } = {}) {
  const desk = new Client(url.replace(/\/$/, ''));
  let lastState = null;

  async function waitForIdle(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = await desk.state();
      if (!state.activeRunId) return state;
      if (Date.now() > deadline) throw new Error(`Agent Desk is still busy with run ${state.activeRunId}`);
      await sleep(2000);
    }
  }

  return {
    name: 'v1',
    async connect() {
      const health = await desk.get('/api/health').catch(error => { throw new Error(`Agent Desk v1 is not reachable at ${url}: ${error.message}`); });
      if (health.connection !== 'connected') throw new Error(`Agent Desk is not connected to Codex (${health.connection})`);
      lastState = await waitForIdle(10 * 60_000);
    },
    async configure({ usageLimit } = {}) {
      if (!usageLimit) return;
      await desk.post('/api/settings', { ...lastState.settings, usagePercentLimit: usageLimit });
      lastState = await desk.state();
    },
    snapshotConfig() {
      return {
        adapter: 'v1',
        settings: lastState.settings,
        agents: lastState.agents.map(agent => ({ id: agent.id, name: agent.name, enabled: agent.enabled, model: agent.model, effort: agent.effort, access: agent.access })),
        skills: (lastState.skills || []).map(skill => ({ id: skill.id, enabled: skill.enabled, agentIds: skill.agentIds })),
      };
    },
    async execute({ task, workspacePath, label, attempt, timeoutMin, log = () => {} }) {
      const project = await desk.post('/api/projects', { name: `bench ${label} ${task.id} r${attempt}`.slice(0, 80), path: workspacePath, allowWrites: true, autoApproveCommands: true, allowLocalProcesses: false });
      let started;
      try {
        started = await desk.post('/api/runs', { projectId: project.id, message: task.prompt, refinePrompt: false });
      } catch (error) {
        if (/한도|usage|사용률/i.test(error.message)) error.usageLimit = true;
        throw error;
      }
      log(`  run ${started.id} started in ${workspacePath}`);
      const deadline = Date.now() + timeoutMin * 60_000;
      let allowAllSent = false, cancelSent = false, blockedSince = null, cancelReason = null, run = null;
      for (;;) {
        await sleep(pollMs);
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
      lastState = await waitForIdle(120_000);
      return { runId: run.id, projectId: project.id, status: run.status, answer: run.answer || '', startedAt: run.startedAt, finishedAt: run.finishedAt, cancelReason, metrics: runMetrics(run) };
    },
  };
}
