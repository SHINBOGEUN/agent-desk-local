// AI team draft: one read-only model session reads the project (its instruction files, docs, task notes, the
// project briefing, the code) and proposes project-specific rules for each role and a few project skills.
// Nothing is written here: the draft goes to the user, who picks what to keep (applyTeamDraft).

import fs from 'node:fs';
import path from 'node:path';
import type { HarnessTools, RoleId, Runtime } from '#core';
import { ROLE_IDS } from '#core';
import { platformNote } from '#orchestrator';
import { parseFrontmatter, roleFilePath, roleTemplate, saveProjectFile, SKILL_ID } from '#project';

export interface DraftSkill {
  id: string;
  role: RoleId;
  description: string;
  body: string;
  should: string[];
  shouldNot: string[];
  /** A skill with this id already exists; applying replaces it. */
  exists: boolean;
}

export interface TeamDraft {
  rules: Partial<Record<RoleId, string[]>>;
  skills: DraftSkill[];
  /** What the model read, one line each, so the user can judge the draft. */
  sources: string[];
}

export interface TeamDraftResult {
  ok: boolean;
  draft?: TeamDraft;
  error?: string;
  /** The model's reply when it could not be read as a draft. */
  raw?: string;
}

const MAX_RULES = 8;
const MAX_SKILLS = 3;

function instructions(language: 'en' | 'ko'): string {
  return [
    'Role: you draft project-specific team settings for Agent Desk, a harness that runs four roles on this project:',
    '- lead: reads each request, chooses the workflow, writes plans.',
    '- builder: changes files to meet the requirements.',
    '- verifier: reviews the builder\'s change independently and gives a verdict.',
    '- researcher: investigates one angle of a question, read-only.',
    'Each role already has built-in instructions, and Codex and Claude read AGENTS.md and CLAUDE.md by themselves. Do not repeat what those already say, and do not write general advice ("write clean code", "add tests").',
    'Write only what someone new to this project would get wrong: its real rules, risky areas, conventions, commands and the procedures it repeats. Every rule must come from something you read (a document, a task note, the code); do not invent policies.',
    'Read narrowly: list files first, then open the instruction files, the docs and task notes, and only the code you need to confirm a rule. Do not change any file.',
    platformNote(),
    language === 'ko' ? 'Language: write rules, skill descriptions, skill bodies and trigger requests in Korean, in the polite 합니다 style. Keep code, identifiers, paths and commands as they are. The skill id stays lowercase English with hyphens.' : '',
  ].filter(Boolean).join('\n');
}

function prompt(existing: string): string {
  return `Draft this project's team settings.

1. Rules per role: up to ${MAX_RULES} short rules for each role that needs them (an empty list is fine). One rule is one sentence a model can follow, specific to this project, ideally naming the file, folder or command it concerns.
2. Skills: up to ${MAX_SKILLS} procedures this project repeats that a role should follow step by step (for example how a database migration is added and recorded here, or how a money calculation is checked). Skip it when nothing repeats. Each skill:
   - id: lowercase letters, digits and hyphens.
   - role: the one role that uses it.
   - description: one or two sentences: what it does, "Use when ...", "Do not use when ...".
   - body: Markdown. Start with a line "Why: ..." (what goes wrong without it), then numbered steps, then "## Examples" with one normal case and one error case.
   - should / shouldNot: 4 to 8 example user requests each, for which the skill should and should not be read.
3. sources: the files you based the draft on, one short line each.
${existing ? `\nAlready in .agent-desk (keep what is good, do not repeat it):\n${existing}\n` : ''}
When you are done, reply with JSON only, no other text:
{"rules": {"lead": [], "builder": [], "verifier": [], "researcher": []}, "skills": [{"id": "", "role": "builder", "description": "", "body": "", "should": [], "shouldNot": []}], "sources": []}`;
}

/** Role files and skills already in the project, short, so the draft does not repeat them. */
function existingText(project: string): string {
  const lines: string[] = [];
  for (const role of ROLE_IDS) {
    const file = roleFilePath(project, role);
    if (!fs.existsSync(file)) continue;
    const body = parseFrontmatter(fs.readFileSync(file, 'utf8')).body.trim();
    if (body && !body.startsWith('Project-specific rules for the')) lines.push(`- .agent-desk/agents/${role}.md: ${body.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  const skillsDir = path.join(project, '.agent-desk', 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const id of fs.readdirSync(skillsDir)) {
      const file = path.join(skillsDir, id, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const description = parseFrontmatter(fs.readFileSync(file, 'utf8')).data.description;
      lines.push(`- skill ${id}: ${typeof description === 'string' ? description.slice(0, 200) : ''}`);
    }
  }
  return lines.join('\n');
}

const strings = (value: unknown, max: number): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim()).slice(0, max) : []);

/** Reads the model's JSON reply into a draft; anything malformed is dropped rather than guessed. */
export function parseTeamDraft(reply: string, project: string): TeamDraft | null {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try { raw = JSON.parse(reply.slice(start, end + 1)); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const rules: Partial<Record<RoleId, string[]>> = {};
  const rawRules = record.rules && typeof record.rules === 'object' ? record.rules as Record<string, unknown> : {};
  for (const role of ROLE_IDS) {
    const list = strings(rawRules[role], MAX_RULES).map(rule => rule.replace(/^[-*]\s+/, '').replace(/\n+/g, ' '));
    if (list.length) rules[role] = list;
  }
  const skills: DraftSkill[] = [];
  for (const item of Array.isArray(record.skills) ? record.skills.slice(0, MAX_SKILLS) : []) {
    if (!item || typeof item !== 'object') continue;
    const skill = item as Record<string, unknown>;
    const id = typeof skill.id === 'string' ? skill.id.trim().toLowerCase() : '';
    const role = skill.role as RoleId;
    const description = typeof skill.description === 'string' ? skill.description.replace(/\s+/g, ' ').trim() : '';
    const body = typeof skill.body === 'string' ? skill.body.replace(/\r\n/g, '\n').trim() : '';
    if (!SKILL_ID.test(id) || !ROLE_IDS.includes(role) || !description || !body) continue;
    if (skills.some(existing => existing.id === id)) continue;
    skills.push({ id, role, description, body, should: strings(skill.should, 10), shouldNot: strings(skill.shouldNot, 10), exists: fs.existsSync(path.join(project, '.agent-desk', 'skills', id, 'SKILL.md')) });
  }
  if (!Object.keys(rules).length && !skills.length) return null;
  return { rules, skills, sources: strings(record.sources, 20) };
}

const noTools: HarnessTools = {
  submitReport: async () => ({ ok: false, message: 'Do not submit a report here. Reply with the JSON draft as your final message.' }),
  requestUserInput: async () => 'Decide yourself from what you read; the user will review the draft.',
};

export async function runTeamDraft(options: { project: string; runtime: Runtime; language?: 'en' | 'ko'; model?: string; signal?: AbortSignal }): Promise<TeamDraftResult> {
  const session = await options.runtime.startSession({
    role: 'lead', cwd: options.project, access: 'read-only', instructions: instructions(options.language ?? 'en'), skills: [], tools: noTools, effort: 'medium',
    ...(options.model ? { model: options.model } : {}),
  });
  let reply = '';
  let failure = '';
  try {
    for await (const event of session.runTurn({ text: prompt(existingText(options.project)) }, options.signal ?? new AbortController().signal)) {
      if (event.type === 'message' && typeof event.text === 'string') reply = event.final ? event.text : reply || event.text;
      if (event.type === 'turn_end' && event.status === 'failed') failure = event.error ?? 'the model turn failed';
    }
  } finally {
    await session.close().catch(() => {});
    await (options.runtime as Runtime & { close?: () => Promise<void> }).close?.().catch(() => {});
  }
  const draft = parseTeamDraft(reply, options.project);
  if (draft) return { ok: true, draft };
  return { ok: false, error: failure || 'The reply could not be read as a draft.', ...(reply ? { raw: reply.slice(0, 4000) } : {}) };
}

/** The role file with the chosen rules added under "## Project rules" and the chosen skills listed. */
export function roleFileWith(current: string | null, role: RoleId, rules: string[], skills: string[]): string {
  const text = current ?? roleTemplate(role);
  const parsed = parseFrontmatter(text);
  const data = { ...parsed.data };
  const listed = Array.isArray(data.skills) ? data.skills : typeof data.skills === 'string' && data.skills ? [data.skills] : [];
  data.skills = [...new Set([...listed, ...skills])];
  const front = Object.entries(data).map(([key, value]) => `${key}: ${Array.isArray(value) ? `[${value.join(', ')}]` : value}`).join('\n');
  let body = parsed.body.startsWith('Project-specific rules for the') ? '' : parsed.body;
  const fresh = rules.filter(rule => !body.includes(rule));
  if (fresh.length) {
    const block = fresh.map(rule => `- ${rule}`).join('\n');
    body = /^## Project rules$/m.test(body) ? body.replace(/^## Project rules$/m, match => `${match}\n\n${block}`) : `${body ? `${body}\n\n` : ''}## Project rules\n\n${block}`;
  }
  return `---\n${front}\n---\n\n${body.trim()}\n`;
}

export function skillFileText(skill: Pick<DraftSkill, 'id' | 'description' | 'body'>): string {
  return `---\nname: ${skill.id}\ndescription: ${skill.description.replace(/\n/g, ' ')}\n---\n\n${skill.body.trim()}\n`;
}

export interface ApplyChoice {
  rules: Partial<Record<RoleId, string[]>>;
  skills: Array<Pick<DraftSkill, 'id' | 'role' | 'description' | 'body' | 'should' | 'shouldNot'>>;
}

/** Writes what the user kept: skills first (role files may list only existing skills), then the role files. */
export function applyTeamDraft(project: string, choice: ApplyChoice): { written: string[]; errors: string[] } {
  const written: string[] = [];
  const errors: string[] = [];
  const skillsOf: Partial<Record<RoleId, string[]>> = {};
  for (const skill of choice.skills) {
    if (!SKILL_ID.test(skill.id) || !ROLE_IDS.includes(skill.role)) { errors.push(`skill "${skill.id}": invalid id or role`); continue; }
    const saved = saveProjectFile(project, { kind: 'skill', id: skill.id, text: skillFileText(skill) });
    if (!saved.ok) { errors.push(`skill "${skill.id}": ${saved.errors.join('; ')}`); continue; }
    written.push(`.agent-desk/skills/${skill.id}/SKILL.md`);
    if (skill.should.length || skill.shouldNot.length) {
      fs.writeFileSync(path.join(project, '.agent-desk', 'skills', skill.id, 'triggers.json'), `${JSON.stringify({ should: skill.should, shouldNot: skill.shouldNot }, null, 2)}\n`);
      written.push(`.agent-desk/skills/${skill.id}/triggers.json`);
    }
    (skillsOf[skill.role] ??= []).push(skill.id);
  }
  for (const role of ROLE_IDS) {
    const rules = choice.rules[role] ?? [];
    const skills = skillsOf[role] ?? [];
    if (!rules.length && !skills.length) continue;
    const file = roleFilePath(project, role);
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const saved = saveProjectFile(project, { kind: 'role', id: role, text: roleFileWith(current, role, rules, skills) });
    if (saved.ok) written.push(`.agent-desk/agents/${role}.md`);
    else errors.push(`${role}: ${saved.errors.join('; ')}`);
  }
  return { written, errors };
}
