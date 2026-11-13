// Project memory: .agent-desk/memory.md. Facts that stay true across runs
// ("migrations are applied by the user", "emulator port is 8081"). The user owns
// it: the harness only proposes entries, and nothing is written without an
// explicit add. A size cap keeps it from bloating every session's context.

import fs from 'node:fs';
import path from 'node:path';

export const MEMORY_MAX_CHARS = 2000;
export const MEMORY_FACT_MAX_CHARS = 240;

export const memoryPath = (project: string): string => path.join(project, '.agent-desk', 'memory.md');

export function loadMemory(project: string): string {
  try { return fs.readFileSync(memoryPath(project), 'utf8').replace(/\r\n/g, '\n').trim(); } catch { return ''; }
}

export function memoryFacts(text: string): string[] {
  return text.split('\n').map(line => line.replace(/^\s*[-*]\s+/, '').trim()).filter(line => line && !line.startsWith('#'));
}

const same = (a: string, b: string): boolean => a.toLowerCase().replace(/\s+/g, ' ').trim() === b.toLowerCase().replace(/\s+/g, ' ').trim();

/** Suggestions that are new: not empty, not too long, not already in memory. */
export function newSuggestions(project: string, suggestions: readonly string[]): string[] {
  const existing = memoryFacts(loadMemory(project));
  const out: string[] = [];
  for (const raw of suggestions) {
    const fact = raw.replace(/\s+/g, ' ').trim();
    if (!fact || fact.length > MEMORY_FACT_MAX_CHARS) continue;
    if (existing.some(item => same(item, fact)) || out.some(item => same(item, fact))) continue;
    out.push(fact);
  }
  return out;
}

export type AddResult = { ok: true; chars: number } | { ok: false; error: string };

export function addMemory(project: string, rawFact: string): AddResult {
  const fact = rawFact.replace(/\s+/g, ' ').trim();
  if (!fact) return { ok: false, error: 'the fact is empty' };
  if (fact.length > MEMORY_FACT_MAX_CHARS) return { ok: false, error: `a memory entry is at most ${MEMORY_FACT_MAX_CHARS} characters; this one has ${fact.length}` };
  if (/\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.)/.test(fact) || /\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/i.test(fact)) return { ok: false, error: 'this looks like a secret; memory is committed to git, so do not store secrets in it' };
  const current = loadMemory(project);
  if (memoryFacts(current).some(item => same(item, fact))) return { ok: false, error: 'already in memory' };
  const next = `${current ? `${current}\n` : '# Project memory\n\n'}- ${fact}\n`;
  if (next.trim().length > MEMORY_MAX_CHARS) return { ok: false, error: `memory would exceed ${MEMORY_MAX_CHARS} characters (now ${current.length}); remove an old entry in ${memoryPath(project)} first` };
  fs.mkdirSync(path.dirname(memoryPath(project)), { recursive: true });
  fs.writeFileSync(memoryPath(project), next);
  return { ok: true, chars: next.trim().length };
}
