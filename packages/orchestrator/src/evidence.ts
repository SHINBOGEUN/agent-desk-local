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
export function missingSourceErrors(cwd: string, sources: string[], field: string): string[] {
  const errors: string[] = [];
  sources.forEach((source, index) => {
    const file = fileOfSource(source);
    if (!file) return;
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
export function requirementQuoteErrors(request: string, requirements: Requirement[]): string[] {
  const haystack = normalize(request);
  const errors: string[] = [];
  requirements.forEach((requirement, index) => {
    const quote = requirement.quote?.trim();
    if (!quote) { errors.push(`report.requirements[${index}].quote: copy the words of the user's request this requirement comes from`); return; }
    const needle = normalize(quote);
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
