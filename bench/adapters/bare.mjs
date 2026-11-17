// Benchmark adapter for the baseline: Codex alone, no harness. The task prompt
// goes to `codex exec` in the workspace with nothing added (no roles, gates,
// review, skills or evidence checks), which is what a user would get by asking
// Codex directly. Comparing a v2 label with a bare label shows what the harness
// itself adds: success rate, false completions and tokens.
//
// Options (passed by bench/run.mjs):
//   cli   command that starts Codex as an argv array. Default: [AGENT_DESK_CODEX or "codex"]
//
// Codex exec prints JSON lines with --json. Tokens come from "turn.completed"
// events (usage.input_tokens, cached_input_tokens, output_tokens) and the answer
// from the last "agent_message" item. Unknown lines are ignored, so a newer
// Codex that adds events still works; if usage is missing the run records 0
// tokens rather than a guess.

import { spawn } from 'node:child_process';

function runCodex(command, args, { cwd, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), ...args], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    child.stdin.end(input);
  });
}

/** JSON lines from `codex exec --json` -> usage, answer and command count. */
export function parseExecOutput(stdout) {
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  let answer = '';
  let commands = 0;
  let failed = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'turn.completed' && event.usage) {
      usage.inputTokens += Number(event.usage.input_tokens) || 0;
      usage.cachedInputTokens += Number(event.usage.cached_input_tokens) || 0;
      usage.outputTokens += Number(event.usage.output_tokens) || 0;
    }
    if (event.type === 'turn.failed' || event.type === 'error') failed = true;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') answer = event.item.text;
    if (event.type === 'item.completed' && event.item?.type === 'command_execution') commands++;
  }
  return { usage, answer, commands, failed };
}

export function bareMetrics(parsed, { status, durationSec }) {
  const { inputTokens, cachedInputTokens, outputTokens } = parsed.usage;
  return {
    status,
    workflow: null,
    skillsRead: null,
    endReason: status === 'completed' ? null : status,
    qualityGate: 'not_required',
    usage: { totalTokens: inputTokens + outputTokens, inputTokens, cachedInputTokens, uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens), outputTokens },
    accountPercent: null,
    durationSec,
    agentCount: 1,
    agents: ['codex'],
    workTasks: 1,
    consultations: 0,
    retries: 0,
    failedTasks: status === 'failed' ? 1 : 0,
    verifierVerdicts: [],
    requiredAgents: [],
    perAgent: { codex: { calls: 1, tokens: inputTokens + outputTokens } },
    redo: 0,
    reviewSkipped: 'no harness',
    unverified: 0,
    gates: [],
    commands: parsed.commands,
  };
}

export function createAdapter({ cli } = {}) {
  const command = cli || [process.env.AGENT_DESK_CODEX || 'codex'];
  return {
    name: 'bare',
    async connect() {
      const { code, stderr } = await runCodex(command, ['--version'], { cwd: process.cwd(), input: '', timeoutMs: 30_000 })
        .catch(error => { throw new Error(`codex could not start: ${error.message}. Set AGENT_DESK_CODEX to the full path of codex.exe.`); });
      if (code !== 0) throw new Error(`codex --version failed: ${stderr.trim()}`);
    },
    async configure() {},
    snapshotConfig() {
      return { adapter: 'bare', settings: { harness: 'none', runtime: 'codex exec' }, agents: [{ id: 'codex', name: 'codex', enabled: true }], skills: [] };
    },
    async execute({ task, workspacePath, timeoutMin, log = () => {} }) {
      const startedAt = new Date();
      log(`  codex exec in ${workspacePath}`);
      // "-" reads the prompt from stdin, so quoting on Windows cannot change it.
      const { code, stdout, stderr, timedOut } = await runCodex(command, ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', workspacePath, '-'], { cwd: workspacePath, input: task.prompt, timeoutMs: timeoutMin * 60_000 });
      const finishedAt = new Date();
      const durationSec = (finishedAt - startedAt) / 1000;
      const parsed = parseExecOutput(stdout);
      if (!timedOut && code !== 0 && !parsed.answer) {
        if (/usage limit|rate limit/i.test(stderr)) throw Object.assign(new Error(stderr.trim()), { usageLimit: true });
        throw new Error(`codex exec failed (exit code ${code}). ${stderr.trim().split(/\r?\n/).slice(-5).join(' | ')}`);
      }
      // A bare agent has no gates: finishing without an error is its claim of success.
      const status = timedOut ? 'interrupted' : parsed.failed || code !== 0 ? 'failed' : 'completed';
      return { runId: null, projectId: workspacePath, status, answer: parsed.answer, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), cancelReason: timedOut ? 'bench_timeout' : null, metrics: bareMetrics(parsed, { status, durationSec }) };
    },
  };
}
