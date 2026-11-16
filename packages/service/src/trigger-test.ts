// Skill trigger test (roadmap 6-4, from the book's verification phase): does a
// skill's description make the model pick it for the requests it is meant for,
// and leave it alone for the others? Each skill may keep its cases next to it:
//   .agent-desk/skills/<id>/triggers.json  { "should": ["..."], "shouldNot": ["..."] }
// (8-10 of each is the book's guidance). Every case is one fresh read-only
// session that sees only the skill list, the way a real session does, and
// answers which skills it would read. Nothing in the project is changed.

import fs from 'node:fs';
import path from 'node:path';
import type { HarnessTools, Runtime, SkillRef } from '#core';
import { skillsText } from '#orchestrator';

export interface TriggerCases { should: string[]; shouldNot: string[] }
export interface CaseResult { request: string; expected: boolean; picked: boolean; chosen: string[] }
export interface SkillTriggerResult { id: string; cases: CaseResult[]; hitRate: number | null; falseRate: number | null; missing?: string }

export function readTriggerCases(project: string, skill: SkillRef): TriggerCases | null {
  const file = path.join(project, path.dirname(skill.path), 'triggers.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<TriggerCases>;
    const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : []);
    return { should: list(raw.should), shouldNot: list(raw.shouldNot) };
  } catch { return null; }
}

/** Skill ids named in a reply such as `{"skills":["a","b"]}` or plain text; only known ids count. */
export function chosenSkills(reply: string, known: string[]): string[] {
  const json = /\{[\s\S]*\}/.exec(reply);
  if (json) {
    try {
      const parsed = JSON.parse(json[0]) as { skills?: unknown };
      if (Array.isArray(parsed.skills)) return known.filter(id => (parsed.skills as unknown[]).includes(id));
    } catch { /* fall through to text */ }
  }
  return known.filter(id => new RegExp(`(^|[^a-z0-9-])${id}([^a-z0-9-]|$)`).test(reply));
}

const PROMPT = (request: string): string => `A user sent this request to the coding team:\n\n${request}\n\nDo not do the work and do not open any file. Only decide which of the listed skills (if any) you would read before starting. Reply with JSON only: {"skills": ["id", ...]} (an empty list if none fits).`;

const noTools: HarnessTools = {
  submitReport: async () => ({ ok: true, message: 'not used in a trigger test' }),
  requestUserInput: async () => 'Answer without asking.',
};

export async function runTriggerTest(options: { project: string; runtime: Runtime; skills: SkillRef[]; only?: string[]; signal?: AbortSignal; onCase?: (id: string, result: CaseResult) => void }): Promise<SkillTriggerResult[]> {
  const known = options.skills.map(skill => skill.id);
  const instructions = `Role: lead. You read requests and decide how to approach them.\n\n${skillsText(options.skills)}`;
  const results: SkillTriggerResult[] = [];
  for (const skill of options.skills) {
    if (options.only?.length && !options.only.includes(skill.id)) continue;
    const cases = readTriggerCases(options.project, skill);
    if (!cases || (!cases.should.length && !cases.shouldNot.length)) { results.push({ id: skill.id, cases: [], hitRate: null, falseRate: null, missing: `no ${path.posix.join(path.posix.dirname(skill.path), 'triggers.json')}` }); continue; }
    const caseResults: CaseResult[] = [];
    for (const [request, expected] of [...cases.should.map(text => [text, true] as const), ...cases.shouldNot.map(text => [text, false] as const)]) {
      const session = await options.runtime.startSession({ role: 'lead', cwd: options.project, access: 'read-only', instructions, skills: options.skills, tools: noTools, effort: 'low' });
      let reply = '';
      try {
        for await (const event of session.runTurn({ text: PROMPT(request) }, options.signal ?? new AbortController().signal)) {
          if (event.type === 'message' && typeof event.text === 'string') reply = event.final ? event.text : reply || event.text;
        }
      } finally { await session.close().catch(() => {}); }
      const chosen = chosenSkills(reply, known);
      const result = { request, expected, picked: chosen.includes(skill.id), chosen };
      caseResults.push(result);
      options.onCase?.(skill.id, result);
    }
    const rate = (list: CaseResult[]): number | null => (list.length ? list.filter(item => item.picked).length / list.length : null);
    results.push({ id: skill.id, cases: caseResults, hitRate: rate(caseResults.filter(item => item.expected)), falseRate: rate(caseResults.filter(item => !item.expected)) });
  }
  return results;
}
