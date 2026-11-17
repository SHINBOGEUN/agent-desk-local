// Quality log (ADR 0012): the user's rating of real runs next to what the
// harness measured. A 👎 names where the fix belongs (the book's improvement
// loop): result quality -> a skill, role confusion -> a role file, order or
// routing -> the workflow/config. The summary shows where to look first.

import type { QualityRow } from '#store';

const mean = (values: number[]): number | null => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

export interface QualitySummary {
  runs: number;
  rated: number;
  up: number;
  down: number;
  /** Share of rated runs that got 👍. */
  approval: number | null;
  /** 👎 by where the fix belongs. */
  byCause: Record<string, number>;
  /** Files named most often in 👎, most first. */
  targets: { target: string; count: number }[];
  byWorkflow: { workflow: string; runs: number; up: number; down: number }[];
  meanTokensUp: number | null;
  meanTokensDown: number | null;
  /** Reports the evidence checks sent back, over all runs. */
  rejectedReports: number;
  /** Runs that needed at least one REDO round. */
  redoRuns: number;
}

export function qualitySummary(rows: QualityRow[]): QualitySummary {
  const rated = rows.filter(row => row.rating !== null);
  const up = rated.filter(row => row.rating === 1);
  const down = rated.filter(row => row.rating === -1);
  const byCause: Record<string, number> = { skill: 0, role: 0, workflow: 0, other: 0, unknown: 0 };
  for (const row of down) byCause[row.cause ?? 'unknown'] = (byCause[row.cause ?? 'unknown'] ?? 0) + 1;
  const targets = new Map<string, number>();
  for (const row of down) if (row.target) targets.set(row.target, (targets.get(row.target) ?? 0) + 1);
  const workflows = new Map<string, { runs: number; up: number; down: number }>();
  for (const row of rows) {
    const key = row.workflow ?? '-';
    const slot = workflows.get(key) ?? { runs: 0, up: 0, down: 0 };
    slot.runs++; if (row.rating === 1) slot.up++; if (row.rating === -1) slot.down++;
    workflows.set(key, slot);
  }
  return {
    runs: rows.length, rated: rated.length, up: up.length, down: down.length,
    approval: rated.length ? up.length / rated.length : null,
    byCause,
    targets: [...targets].map(([target, count]) => ({ target, count })).sort((a, b) => b.count - a.count || a.target.localeCompare(b.target)),
    byWorkflow: [...workflows].map(([workflow, slot]) => ({ workflow, ...slot })).sort((a, b) => b.runs - a.runs),
    meanTokensUp: mean(up.map(row => row.tokens)),
    meanTokensDown: mean(down.map(row => row.tokens)),
    rejectedReports: rows.reduce((sum, row) => sum + row.rejectedReports, 0),
    redoRuns: rows.filter(row => row.redo > 0).length,
  };
}

const CSV_COLUMNS: (keyof QualityRow)[] = ['runId', 'startedAt', 'project', 'workflow', 'status', 'rating', 'cause', 'target', 'note', 'tokens', 'redo', 'rejectedReports', 'request'];

/** CSV with a BOM so Excel opens Korean text correctly. */
export function qualityCsv(rows: QualityRow[]): string {
  const cell = (value: unknown): string => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `﻿${[CSV_COLUMNS.join(','), ...rows.map(row => CSV_COLUMNS.map(column => cell(row[column])).join(','))].join('\r\n')}\r\n`;
}
