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

/** Why one entry cannot be stored, or null when it can. */
function factError(fact: string): string | null {
  if (!fact) return 'the fact is empty';
  if (fact.length > MEMORY_FACT_MAX_CHARS) return `a memory entry is at most ${MEMORY_FACT_MAX_CHARS} characters; this one has ${fact.length}`;
  if (/\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.)/.test(fact) || /\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/i.test(fact)) return 'this looks like a secret; memory is committed to git, so do not store secrets in it';
  return null;
}

export type ReplaceResult = { ok: true; chars: number } | { ok: false; errors: string[] };

/**
 * Writes the whole memory as the given entries (edit, delete, reorder from the dashboard).
 * Every entry is checked like a new one; nothing is written if any fails.
 */
export function replaceMemory(project: string, rawFacts: readonly string[]): ReplaceResult {
  const facts = rawFacts.map(raw => raw.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const errors: string[] = [];
  facts.forEach((fact, index) => {
    const error = factError(fact);
    if (error) errors.push(`entry ${index + 1}: ${error}`);
    else if (facts.findIndex(other => same(other, fact)) !== index) errors.push(`entry ${index + 1}: same as entry ${facts.findIndex(other => same(other, fact)) + 1}`);
  });
  const next = `# Project memory\n\n${facts.map(fact => `- ${fact}\n`).join('')}`;
  if (next.trim().length > MEMORY_MAX_CHARS) errors.push(`memory would be ${next.trim().length} characters; the limit is ${MEMORY_MAX_CHARS}`);
  if (errors.length) return { ok: false, errors };
  fs.mkdirSync(path.dirname(memoryPath(project)), { recursive: true });
  fs.writeFileSync(memoryPath(project), next);
  return { ok: true, chars: next.trim().length };
}

export function addMemory(project: string, rawFact: string): AddResult {
  const fact = rawFact.replace(/\s+/g, ' ').trim();
  const invalid = factError(fact);
  if (invalid) return { ok: false, error: invalid };
  const current = loadMemory(project);
  if (memoryFacts(current).some(item => same(item, fact))) return { ok: false, error: 'already in memory' };
  const next = `${current ? `${current}\n` : '# Project memory\n\n'}- ${fact}\n`;
  if (next.trim().length > MEMORY_MAX_CHARS) return { ok: false, error: `memory would exceed ${MEMORY_MAX_CHARS} characters (now ${current.length}); remove an old entry in ${memoryPath(project)} first` };
  fs.mkdirSync(path.dirname(memoryPath(project)), { recursive: true });
  fs.writeFileSync(memoryPath(project), next);
  return { ok: true, chars: next.trim().length };
}
