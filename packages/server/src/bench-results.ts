// Reads benchmark runs saved by bench/run.mjs (bench/results/runs/<label>/*.json) and summarizes each label for the dashboard.
// Same numbers as bench/report.mjs; harness or environment failures are left out, as there.

import fs from 'node:fs';
import path from 'node:path';

export interface TaskSummary { runs: number; success: number; meanTokens: number | null; meanAgents: number | null; meanMinutes: number | null }
export interface BenchSummary {
  label: string;
  enabledAgents: number | null;
  runs: number;
  excluded: number;
  successRate: number | null;
  claimedRate: number | null;
  falseCompletionRate: number | null;
  meanTokens: number | null;
  medianTokens: number | null;
  meanAgents: number | null;
  meanMinutes: number | null;
  meanAccountPercent: number | null;
  perTask: Record<string, TaskSummary>;
}

type Raw = {
  taskId?: string; cancelReason?: string | null; claimedSuccess?: boolean; falseCompletion?: boolean;
  grade?: { success?: boolean };
  metrics?: { usage?: { totalTokens?: number }; durationSec?: number | null; agentCount?: number; accountPercent?: number | null };
};

const mean = (values: number[]): number | null => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const rate = (part: number, whole: number): number | null => (whole ? part / whole : null);
const numbers = (values: (number | null | undefined)[]): number[] => values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

export function summarizeBench(runsDirectory: string): BenchSummary[] {
  if (!fs.existsSync(runsDirectory)) return [];
  const labels = fs.readdirSync(runsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const summaries: BenchSummary[] = [];
  for (const label of labels) {
    const directory = path.join(runsDirectory, label);
    const all: Raw[] = [];
    for (const name of fs.readdirSync(directory)) {
      if (!/^[THPW]\d+.*-r\d+\.json$/.test(name)) continue;
      try { all.push(JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as Raw); } catch { /* a damaged file is skipped */ }
    }
    if (!all.length) continue;
    let enabledAgents: number | null = null;
    try {
      const config = JSON.parse(fs.readFileSync(path.join(directory, '_config.json'), 'utf8')) as { agents?: { enabled?: boolean }[] };
      if (Array.isArray(config.agents)) enabledAgents = config.agents.filter(agent => agent.enabled).length;
    } catch { /* no config recorded */ }
    const valid = all.filter(result => !['blocked_on_approval', 'server_restarted'].includes(result.cancelReason ?? ''));
    const claimed = valid.filter(result => result.claimedSuccess);
    const successful = valid.filter(result => result.grade?.success);
    const tokens = numbers(valid.map(result => result.metrics?.usage?.totalTokens));
    const perTask: Record<string, TaskSummary> = {};
    for (const taskId of [...new Set(valid.map(result => result.taskId ?? '?'))].sort()) {
      const group = valid.filter(result => (result.taskId ?? '?') === taskId);
      perTask[taskId] = {
        runs: group.length,
        success: group.filter(result => result.grade?.success).length,
        meanTokens: mean(numbers(group.map(result => result.metrics?.usage?.totalTokens))),
        meanAgents: mean(numbers(group.map(result => result.metrics?.agentCount))),
        meanMinutes: mean(numbers(group.map(result => (typeof result.metrics?.durationSec === 'number' ? result.metrics.durationSec / 60 : null)))),
      };
    }
    summaries.push({
      label,
      enabledAgents,
      runs: valid.length,
      excluded: all.length - valid.length,
      successRate: rate(successful.length, valid.length),
      claimedRate: rate(claimed.length, valid.length),
      falseCompletionRate: rate(claimed.filter(result => !result.grade?.success).length, claimed.length),
      meanTokens: mean(tokens),
      medianTokens: median(tokens),
      meanAgents: mean(numbers(valid.map(result => result.metrics?.agentCount))),
      meanMinutes: mean(numbers(valid.map(result => (typeof result.metrics?.durationSec === 'number' ? result.metrics.durationSec / 60 : null)))),
      meanAccountPercent: mean(numbers(valid.map(result => result.metrics?.accountPercent))),
      perTask,
    });
  }
  return summaries;
}
