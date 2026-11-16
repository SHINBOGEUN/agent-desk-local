// `agent-desk skills check`: structure and description checks for
// .agent-desk/skills/<id>/SKILL.md. Trigger tests and with/without comparisons
// need models and live in the benchmark (phase 6); this is the part that can be
// decided by reading files.

import fs from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from './config.ts';
import type { RoleDefinition } from './roles.ts';
import { parseFrontmatter } from './roles.ts';

export type FindingLevel = 'error' | 'warn' | 'info';

export interface SkillFinding {
  level: FindingLevel;
  /** Skill id, or "project" for cross-file findings. */
  skill: string;
  message: string;
}

export interface SkillInfo {
  id: string;
  description: string;
  path: string;
}

export interface SkillsReport {
  skills: SkillInfo[];
  findings: SkillFinding[];
}

export const skillsDirectory = (project: string): string => path.join(project, '.agent-desk', 'skills');

const ACTION = /\b(use|run|create|write|review|check|validate|generate|migrate|analy[sz]e|fix|add|update|build|test|deploy|format|convert|extract|summari[sz]e|audit|apply|follow|search|find|draft|refactor)\w*\b|합니다|하세요|작성|검토|확인|생성|실행|변환|분석|적용|점검|추가|수정/i;
const TRIGGER = /\b(when|whenever|if the user|if you|before|after|while|use this (skill )?(for|when)|trigger)\b|할 때|하는 경우|경우에|사용자가|요청|때는/i;
const EXCLUDE = /\b(do not|don't|never use|not for|not when|except|unless|only for|instead use|skip when|avoid)\b|하지 마|제외|아닐 때|아닌 경우|쓰지 않|사용하지/i;

const isDirectory = (file: string): boolean => { try { return fs.statSync(file).isDirectory(); } catch { return false; } };
function listFiles(directory: string, base = directory): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/** Relative file references in a markdown body: links and backticked paths with an extension. */
export function referencedFiles(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) if (!/^[a-z]+:\/\//i.test(match[1]!) && !match[1]!.startsWith('/')) found.add(match[1]!.replace(/^\.\//, ''));
  for (const match of body.matchAll(/`((?:references|scripts|assets|templates|examples)\/[^`\s]+)`/g)) found.add(match[1]!);
  return [...found];
}

export function checkSkills(project: string, config: ProjectConfig, roles?: Partial<Record<string, RoleDefinition>>): SkillsReport {
  const findings: SkillFinding[] = [];
  const skills: SkillInfo[] = [];
  const root = skillsDirectory(project);
  const ids = fs.existsSync(root) ? fs.readdirSync(root).filter(name => isDirectory(path.join(root, name))).sort() : [];
  const add = (level: FindingLevel, skill: string, message: string) => findings.push({ level, skill, message });

  for (const id of ids) {
    const directory = path.join(root, id);
    const file = path.join(directory, 'SKILL.md');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) add('error', id, 'folder name must be lowercase letters, digits and hyphens');
    if (!fs.existsSync(file)) { add('error', id, 'missing SKILL.md (the file must be named exactly SKILL.md)'); continue; }
    const parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    if (parsed.error) { add('error', id, `SKILL.md: ${parsed.error}`); continue; }
    const name = typeof parsed.data.name === 'string' ? parsed.data.name : '';
    const description = typeof parsed.data.description === 'string' ? parsed.data.description : '';
    for (const key of Object.keys(parsed.data)) if (!['name', 'description', 'license', 'allowed-tools', 'metadata'].includes(key)) add('warn', id, `unknown frontmatter key "${key}"`);
    if (!name) add('error', id, 'frontmatter needs "name"');
    else if (name !== id) add('error', id, `name "${name}" must match the folder name "${id}"`);
    if (!description) add('error', id, 'frontmatter needs "description"');
    else {
      if (description.length < 40) add('warn', id, 'description is very short; say what the skill does and when to use it');
      if (description.length > 600) add('warn', id, 'description is over 600 characters; it is loaded into every session, so keep it tight');
      if (!ACTION.test(description)) add('warn', id, 'description has no action verb that says what the skill does');
      if (!TRIGGER.test(description)) add('warn', id, 'description does not say when to use the skill (a trigger condition such as "when the user asks to ...")');
      if (!EXCLUDE.test(description)) add('warn', id, 'description does not say when NOT to use it; models skip or over-use skills without an exclusion');
    }
    if (!parsed.body.trim()) add('error', id, 'SKILL.md has no body');
    else {
      const lines = parsed.body.split('\n').length;
      if (lines > 500) add('warn', id, `body is ${lines} lines; move detail into references/ files that the body points to`);
      const shouting = (parsed.body.match(/\b(ALWAYS|NEVER|MUST)\b/g) ?? []).length;
      if (shouting >= 5 && !/because|why|so that|otherwise|이유|때문/i.test(parsed.body)) add('info', id, `${shouting} absolute rules (ALWAYS/NEVER/MUST) with no stated reason; explain why so the model can judge edge cases`);
    }
    const referenced = referencedFiles(parsed.body);
    for (const ref of referenced) if (!fs.existsSync(path.join(directory, ...ref.split('/')))) add('error', id, `body refers to "${ref}" which does not exist`);
    // triggers.json holds trigger-test cases for the harness (skills trigger-test), not material for the model.
    const others = listFiles(directory).filter(rel => rel !== 'SKILL.md' && rel !== 'triggers.json');
    for (const rel of others) if (!referenced.includes(rel)) add('warn', id, `"${rel}" is never mentioned in SKILL.md, so it would never be read`);
    skills.push({ id, description, path: path.relative(project, file).split(path.sep).join('/') });
  }

  const known = new Set(ids);
  for (const id of config.skills ?? []) if (!known.has(id)) add('error', 'project', `config.skills lists "${id}" but .agent-desk/skills/${id}/SKILL.md does not exist`);
  for (const [role, definition] of Object.entries(roles ?? {})) for (const id of definition?.skills ?? []) if (!known.has(id)) add('error', 'project', `.agent-desk/agents/${role}.md lists skill "${id}" which does not exist`);
  if (config.skills) for (const id of ids) if (!config.skills.includes(id)) add('info', id, 'exists but is not listed in config.skills, so it is not used');
  const descriptions = new Map<string, string>();
  for (const skill of skills) {
    const key = skill.description.toLowerCase().replace(/\s+/g, ' ');
    if (key && descriptions.has(key)) add('warn', skill.id, `description is identical to "${descriptions.get(key)}"; the model cannot tell them apart`);
    else descriptions.set(key, skill.id);
  }
  const totalChars = skills.reduce((sum, skill) => sum + skill.description.length, 0);
  if (totalChars > 4000) add('warn', 'project', `descriptions add up to ${totalChars} characters; every session pays for them on every turn`);
  return { skills, findings };
}
