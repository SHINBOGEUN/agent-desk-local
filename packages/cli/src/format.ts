// Plain-text output of the CLI. English only: Windows PowerShell 5 consoles
// garble UTF-8 text unless the code page is switched.

import type { GateResult, RunEvent, RunResult } from '#orchestrator';

export function describeEvent(event: RunEvent): string | null {
  switch (event.type) {
    case 'step_started': return `> ${event.step} (${event.role})`;
    case 'gate': return `  gate ${event.result.gate}: ${event.result.ok ? 'ok' : 'FAILED'}${event.result.skipped ? ' (skipped)' : ''} - ${event.result.detail}`;
    case 'redo': return `  redo ${event.attempt} (${event.mode}): ${event.reasons.length} problem(s)`;
    case 'retry': return `  retry ${event.step}: ${event.reason}`;
    case 'user_question': return event.answered ? null : `  question: ${event.question}`;
    default: return null;
  }
}

const gateLine = (gate: GateResult): string => `${gate.gate}${gate.attempt ? `#${gate.attempt}` : ''}:${gate.skipped ? 'skip' : gate.ok ? 'ok' : 'FAIL'}`;

export function summarize(result: RunResult, durationMs: number): string {
  const lines = [`Status: ${result.status}`, `Reason: ${result.reason}`];
  if (result.workflow) lines.push(`Workflow: ${result.workflow}${result.redo ? `, ${result.redo} redo round(s)` : ''}`);
  if (result.gates.length) lines.push(`Gates: ${result.gates.map(gateLine).join(' ')}`);
  if (result.answer) lines.push('', 'Answer:', result.answer.answer, ...(result.answer.sources.length ? ['', `Sources: ${result.answer.sources.join(', ')}`] : []));
  if (result.builder?.changedFiles.length) lines.push(`Changed files: ${result.builder.changedFiles.join(', ')}`);
  if (result.review) lines.push(`Review: ${result.review.verdict}${result.review.optional.length ? ` (${result.review.optional.length} optional suggestion(s))` : ''}`);
  else if (result.reviewSkipped) lines.push(`Review: skipped (${result.reviewSkipped})`);
  for (const item of result.unverified) lines.push(`Not verified: ${item}`);
  for (const item of result.warnings) lines.push(`Warning: ${item}`);
  const billable = result.usage.inputTokens - result.usage.cachedInputTokens + result.usage.outputTokens;
  lines.push(`Tokens: ${result.usage.totalTokens} total (${billable} uncached input + output), ${(durationMs / 1000).toFixed(1)} s`);
  return lines.join('\n');
}

export const EXIT_CODES: Record<string, number> = { completed: 0, failed: 1, needs_review: 2, needs_user: 3, interrupted: 4 };
