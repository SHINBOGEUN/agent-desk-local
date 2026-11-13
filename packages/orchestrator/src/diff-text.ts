// Renders a compact line diff of the files a build changed, for the reviewer
// and for the "small change" rule of the auto review policy. Works from the
// text kept in the "before" snapshot; the "after" text is read from disk.

import fs from 'node:fs';
import path from 'node:path';
import type { Diff, Snapshot } from './snapshot.ts';

const MAX_DIFF_LINES = 1500;
const MAX_FILE_OUTPUT_LINES = 200;
const CONTEXT = 2;

export interface RenderedDiff {
  text: string;
  /** Added plus removed lines over all files that could be compared. */
  lines: number;
  /** Some changed file could not be compared (binary, too large, no earlier text). */
  unknown: boolean;
}

type Op = { kind: ' ' | '+' | '-'; text: string };

function lineDiff(before: string[], after: string[]): Op[] {
  const n = before.length;
  const m = after.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i]![j] = before[i] === after[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) { ops.push({ kind: ' ', text: before[i]! }); i++; j++; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) { ops.push({ kind: '-', text: before[i]! }); i++; }
    else { ops.push({ kind: '+', text: after[j]! }); j++; }
  }
  while (i < n) ops.push({ kind: '-', text: before[i++]! });
  while (j < m) ops.push({ kind: '+', text: after[j++]! });
  return ops;
}

function hunks(ops: Op[]): string[] {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => { if (op.kind !== ' ') for (let k = Math.max(0, index - CONTEXT); k <= Math.min(ops.length - 1, index + CONTEXT); k++) keep[k] = true; });
  const out: string[] = [];
  let gap = false;
  ops.forEach((op, index) => {
    if (!keep[index]) { gap = true; return; }
    if (gap && out.length) out.push('@@');
    gap = false;
    out.push(`${op.kind}${op.text}`);
  });
  return out;
}

const splitLines = (text: string): string[] => {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

export function renderDiff(input: { cwd: string; before: Snapshot; diff: Diff; maxChars?: number }): RenderedDiff {
  const { cwd, before, diff } = input;
  const maxChars = input.maxChars ?? 24_000;
  const parts: string[] = [];
  let lines = 0;
  let unknown = false;
  const readAfter = (rel: string): string | null => {
    try { const buffer = fs.readFileSync(path.join(cwd, rel)); return buffer.includes(0) || buffer.length > 512 * 1024 ? null : buffer.toString('utf8'); } catch { return null; }
  };
  const clip = (body: string[]) => (body.length > MAX_FILE_OUTPUT_LINES ? [...body.slice(0, MAX_FILE_OUTPUT_LINES), `... (${body.length - MAX_FILE_OUTPUT_LINES} more lines)`] : body);
  for (const rel of diff.added) {
    const text = readAfter(rel);
    if (text === null) { unknown = true; parts.push(`added: ${rel} (binary or too large to show)`); continue; }
    const body = splitLines(text);
    lines += body.length;
    parts.push(`added: ${rel}\n${clip(body.map(line => `+${line}`)).join('\n')}`);
  }
  for (const rel of diff.deleted) {
    const text = before.contents.get(rel);
    if (text === undefined) { unknown = true; parts.push(`deleted: ${rel} (content not available)`); continue; }
    const body = splitLines(text);
    lines += body.length;
    parts.push(`deleted: ${rel}\n${clip(body.map(line => `-${line}`)).join('\n')}`);
  }
  for (const rel of diff.modified) {
    const earlier = before.contents.get(rel);
    const later = readAfter(rel);
    if (earlier === undefined || later === null) { unknown = true; parts.push(`modified: ${rel} (too large or binary to show)`); continue; }
    const a = splitLines(earlier);
    const b = splitLines(later);
    if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) { unknown = true; parts.push(`modified: ${rel} (too large to show)`); continue; }
    const body = hunks(lineDiff(a, b));
    lines += body.filter(line => line.startsWith('+') || line.startsWith('-')).length;
    parts.push(`modified: ${rel}\n${clip(body).join('\n')}`);
  }
  let text = parts.join('\n\n');
  if (text.length > maxChars) { text = `${text.slice(0, maxChars)}\n... (diff cut; read the files for the rest)`; unknown = true; }
  return { text, lines, unknown };
}
