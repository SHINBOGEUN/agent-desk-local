// Deterministic checks that turn common hallucinations into rejected reports.
// They cost no model tokens: the harness compares what a report claims with
// what it can see itself (commands that really ran, files that really exist,
// words the user really wrote). A rejected report is fixed in the same turn.

import fs from 'node:fs';
import path from 'node:path';
import type { Requirement } from '#core';

export interface ObservedCommand { command: string; exitCode: number | null }

const squash = (text: string): string => text.toLowerCase().replace(/["'`]/g, '').replace(/\s+/g, ' ').trim();

/** builder.commandsRun entries that no command run in this step backs up, or whose exit code differs. */
export function commandClaimErrors(claimed: { command: string; exitCode: number }[], observed: ObservedCommand[]): string[] {
  const errors: string[] = [];
  claimed.forEach((entry, index) => {
    const want = squash(entry.command);
    const matches = observed.filter(run => { const seen = squash(run.command); return seen.includes(want) || (seen.length > 3 && want.includes(seen)); });
    if (!matches.length) { errors.push(`builder.commandsRun[${index}]: "${entry.command}" did not run in this step. List only commands you actually ran; run it now if you want to rely on it.`); return; }
    const last = matches.at(-1)!;
    if (last.exitCode !== null && last.exitCode !== entry.exitCode) errors.push(`builder.commandsRun[${index}]: "${entry.command}" exited with ${last.exitCode}, not ${entry.exitCode}. Report the real exit code.`);
  });
  return errors;
}

/** A source that names a project file ("src/a.js", "src/a.js:12", "./b.md#L3"); URLs and prose are not checked. */
export function fileOfSource(source: string): string | null {
  const text = source.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /\s/.test(text.replace(/:\d+(-\d+)?$/, ''))) return null;
  const file = text.replace(/#L?\d+(-L?\d+)?$/, '').replace(/:\d+(-\d+)?(:\d+)?$/, '').replace(/^\.\//, '');
  return /[\\/]|\.[a-z0-9]{1,8}$/i.test(file) ? file : null;
}

/** Cited files that do not exist in the project (answer and research sources). */
export function missingSourceErrors(cwd: string, sources: string[], field: string, noteText?: (path: string) => string | null): string[] {
  const errors: string[] = [];
  sources.forEach((source, index) => {
    const file = fileOfSource(source);
    if (!file) return;
    if (noteText && noteText(file) !== null) return;
    const full = path.resolve(cwd, file);
    const inside = full === cwd || full.startsWith(cwd + path.sep);
    if (!inside || !fs.existsSync(full)) errors.push(`${field}[${index}]: "${source}" is not a file in the project. Cite only files you actually read.`);
  });
  return errors;
}

const normalize = (text: string): string => text.normalize('NFC').toLowerCase().replace(/[\s"'`“”‘’.,!?;:()[\]{}<>~·…-]+/g, '');

/**
 * Requirements of build workflows must quote the words of the request they
 * come from, so the lead cannot add work nobody asked for.
 */
/**
 * Every requirement quotes where it comes from: the request, or (with "source") a project note the user wrote.
 * `noteText` returns a note's text, or null when there is no such note.
 */
export function requirementQuoteErrors(request: string, requirements: Requirement[], noteText?: (path: string) => string | null): string[] {
  const errors: string[] = [];
  requirements.forEach((requirement, index) => {
    const quote = requirement.quote?.trim();
    if (!quote) { errors.push(`report.requirements[${index}].quote: copy the words of the user's request this requirement comes from`); return; }
    const needle = normalize(quote);
    if (requirement.source) {
      const text = noteText?.(requirement.source) ?? null;
      if (text === null) { errors.push(`report.requirements[${index}].source: "${requirement.source}" is not a project note. Use a path from the notes list, or quote the request and leave "source" out.`); return; }
      if (!needle.length || !normalize(text).includes(needle)) errors.push(`report.requirements[${index}].quote: "${quote}" is not in ${requirement.source}. Quote the note exactly.`);
      return;
    }
    const haystack = normalize(request);
    if (!needle.length || !haystack.includes(needle)) errors.push(`report.requirements[${index}].quote: "${quote}" is not in the user's request. Quote the request exactly, or drop the requirement if the request does not ask for it.`);
  });
  return errors;
}

/** The skills whose SKILL.md a runtime event shows being opened (a file read, or a command that names the file). */
export function skillsTouched(event: { type: string; path?: string; command?: string }, skills: { id: string; path: string }[]): string[] {
  const text = (event.type === 'file_read' ? event.path : event.type === 'command' ? event.command : '') ?? '';
  if (!text) return [];
  const haystack = text.replace(/\\/g, '/');
  return skills.filter(skill => haystack.includes(skill.path.replace(/\\/g, '/')) || haystack.includes(`skills/${skill.id}/SKILL.md`)).map(skill => skill.id);
}

const slash = (file: string): string => file.replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Verifier findings must point at something real: a cited file exists (or was
 * deleted by the change) and a cited line is inside it. A REDO finding with no
 * file must name the requirement it is about. A REDO built on a made-up
 * location would cost a whole builder turn, so it is rejected here instead.
 */
export function findingLocationErrors(cwd: string, report: { verdict: string; blocking: { file?: string; line?: number; reason: string; evidence: string }[] }, context: { deleted: readonly string[]; requirementIds: readonly string[] }): string[] {
  const errors: string[] = [];
  const deleted = new Set(context.deleted.map(slash));
  report.blocking.forEach((finding, index) => {
    const where = `verifier.blocking[${index}]`;
    if (finding.file) {
      const file = slash(finding.file.trim()).replace(/:\d+(-\d+)?$/, '');
      if (deleted.has(file)) return;
      const full = path.resolve(cwd, file);
      const inside = full.startsWith(cwd + path.sep);
      if (!inside || !fs.existsSync(full) || !fs.statSync(full).isFile()) { errors.push(`${where}.file: "${finding.file}" is not a file in the project. Cite a file you actually read.`); return; }
      if (finding.line !== undefined) {
        const lines = fs.readFileSync(full, 'utf8').split('\n').length;
        if (finding.line < 1 || finding.line > lines) errors.push(`${where}.line: ${finding.line} is outside "${file}" (${lines} lines). Cite the line you actually saw.`);
      }
      return;
    }
    if (report.verdict !== 'REDO') return;
    const text = `${finding.reason} ${finding.evidence}`;
    const named = context.requirementIds.some(id => new RegExp(`(^|[^A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_-])`).test(text));
    if (!named && !/\brequest\b|요청/i.test(text)) errors.push(`${where}: a REDO finding needs a "file" (and line) you saw, or must name the requirement id it is about.`);
  });
  return errors;
}

/**
 * On a re-review, a new blocking finding in a file that has not changed since
 * the last review (and was not part of an earlier finding) moves the goalposts:
 * that file was already reviewed. Such points belong in "optional".
 */
export function staleFindingErrors(blocking: { file?: string }[], context: { changedSince: readonly string[]; earlierFiles: readonly string[] }): string[] {
  const allowed = new Set([...context.changedSince, ...context.earlierFiles].map(slash));
  const errors: string[] = [];
  blocking.forEach((finding, index) => {
    if (!finding.file) return;
    const file = slash(finding.file.trim()).replace(/:\d+(-\d+)?$/, '');
    if (!allowed.has(file)) errors.push(`verifier.blocking[${index}].file: "${file}" has not changed since your last review and was not part of an earlier finding. Re-review only the earlier findings and the files changed since; put other remarks in "optional".`);
  });
  return errors;
}

const DAMAGE = /�|\?{3,}/;

/**
 * Lines a step added that look like text written in the wrong encoding: the Unicode replacement character, or
 * three or more question marks where non-ASCII text (Korean, for example) was lost. Seen on Windows when a file is
 * written through a shell with the wrong code page; tests often still pass, so it is caught here instead of by a
 * review round. "??" (JavaScript's nullish operator) is not matched, and a pattern already in the file before is not
 * counted.
 */
export function encodingDamageErrors(cwd: string, before: { contents: Map<string, string>; files: Map<string, unknown> }, changed: readonly string[]): string[] {
  const errors: string[] = [];
  for (const rel of changed) {
    let after: string;
    try { const buffer = fs.readFileSync(path.join(cwd, rel)); if (buffer.includes(0) || buffer.length > 512 * 1024) continue; after = buffer.toString('utf8'); } catch { continue; }
    const existed = before.files.has(rel);
    const old = before.contents.get(rel);
    if (existed && old === undefined) continue; // too large to compare
    const oldLines = new Set((old ?? '').split(/\r?\n/));
    const hits: number[] = [];
    after.split(/\r?\n/).forEach((line, index) => {
      const match = DAMAGE.exec(line);
      if (!match || oldLines.has(line) || (old ?? '').includes(match[0])) return;
      hits.push(index + 1);
    });
    if (hits.length) errors.push(`${rel}:${hits.slice(0, 3).join(',')}: a line you wrote contains "???" or "�", which usually means non-ASCII text (such as Korean) was lost to a wrong encoding. Rewrite the text as UTF-8, check it, then submit the report again.`);
  }
  return errors;
}
