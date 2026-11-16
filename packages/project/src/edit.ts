// Editing .agent-desk/ files from the dashboard. Every save is validated with
// the same checks the harness uses when it loads the project, in a scratch copy
// first, so a bad edit never lands in the project. Files change only here, and
// only when the user presses save (design: "the dashboard edits the files; it
// keeps no copy of its own").

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RoleId } from '#core';
import { ROLE_NAMES, configPath, validateConfig } from './config.ts';
import { loadRoles, roleFilePath, roleTemplate } from './roles.ts';
import { checkSkills, skillsDirectory } from './skills.ts';
import type { SkillFinding } from './skills.ts';

export type EditKind = 'config' | 'role' | 'skill';

export interface ProjectFiles {
  config: { exists: boolean; text: string };
  roles: Record<RoleId, { exists: boolean; text: string }>;
  skills: { id: string; text: string }[];
}

const read = (file: string): string | null => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
export const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The editable files of a project. Missing role files come back as templates so there is something to start from. */
export function projectFiles(project: string): ProjectFiles {
  const configText = read(configPath(project));
  const roles = {} as ProjectFiles['roles'];
  for (const role of ROLE_NAMES) {
    const text = read(roleFilePath(project, role));
    roles[role] = text === null ? { exists: false, text: roleTemplate(role) } : { exists: true, text };
  }
  const root = skillsDirectory(project);
  const ids = fs.existsSync(root) ? fs.readdirSync(root).filter(name => fs.existsSync(path.join(root, name, 'SKILL.md'))).sort() : [];
  return {
    config: configText === null ? { exists: false, text: '{\n  "mode": "codex+claude",\n  "verify": []\n}\n' } : { exists: true, text: configText },
    roles,
    skills: ids.map(id => ({ id, text: read(path.join(root, id, 'SKILL.md')) ?? '' })),
  };
}

export interface SaveRequest { kind: EditKind; id?: string; text?: string; remove?: boolean }
export type SaveResult = { ok: true; file: string; warnings: string[] } | { ok: false; errors: string[] };

/** Copies .agent-desk/ into a scratch folder, applies the change there and runs the checks. */
function trial(project: string, apply: (scratch: string) => void): { scratch: string; cleanup: () => void } {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desk-edit-'));
  const source = path.join(project, '.agent-desk');
  if (fs.existsSync(source)) fs.cpSync(source, path.join(scratch, '.agent-desk'), { recursive: true });
  apply(scratch);
  return { scratch, cleanup: () => fs.rmSync(scratch, { recursive: true, force: true }) };
}

const findingText = (finding: SkillFinding): string => `${finding.skill}: ${finding.message}`;

export function saveProjectFile(project: string, request: SaveRequest): SaveResult {
  const text = (request.text ?? '').replace(/\r\n/g, '\n');
  if (!request.remove && text.length > 200_000) return { ok: false, errors: ['the file is too large (over 200 KB)'] };
  let target: string;
  if (request.kind === 'config') {
    let raw: unknown;
    try { raw = JSON.parse(text); } catch (error) { return { ok: false, errors: [`not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`] }; }
    const checked = validateConfig(raw);
    if (!checked.ok) return { ok: false, errors: checked.errors };
    target = configPath(project);
  } else if (request.kind === 'role') {
    const role = request.id as RoleId;
    if (!ROLE_NAMES.includes(role)) return { ok: false, errors: [`unknown role "${request.id}"`] };
    target = roleFilePath(project, role);
    const { scratch, cleanup } = trial(project, dir => { fs.mkdirSync(path.dirname(roleFilePath(dir, role)), { recursive: true }); fs.writeFileSync(roleFilePath(dir, role), text); });
    try {
      const loaded = loadRoles(scratch);
      const errors = loaded.errors.filter(error => error.includes(`agents/${role}.md`));
      for (const id of loaded.roles[role].skills) if (!fs.existsSync(path.join(skillsDirectory(project), id, 'SKILL.md'))) errors.push(`skill "${id}" does not exist in .agent-desk/skills/`);
      if (errors.length) return { ok: false, errors };
    } finally { cleanup(); }
  } else if (request.kind === 'skill') {
    const id = request.id ?? '';
    if (!SKILL_ID.test(id)) return { ok: false, errors: ['skill id must be lowercase letters, digits and hyphens (up to 64)'] };
    target = path.join(skillsDirectory(project), id, 'SKILL.md');
    if (request.remove) {
      const users = ROLE_NAMES.filter(role => loadRoles(project).roles[role].skills.includes(id));
      if (users.length) return { ok: false, errors: [`${users.join(', ')} still list "${id}"; remove it from those role files first`] };
      fs.rmSync(path.dirname(target), { recursive: true, force: true });
      return { ok: true, file: target, warnings: [] };
    }
    const { scratch, cleanup } = trial(project, dir => { fs.mkdirSync(path.join(skillsDirectory(dir), id), { recursive: true }); fs.writeFileSync(path.join(skillsDirectory(dir), id, 'SKILL.md'), text); });
    try {
      const report = checkSkills(scratch, {}, undefined);
      const mine = report.findings.filter(finding => finding.skill === id);
      const errors = mine.filter(finding => finding.level === 'error').map(findingText);
      if (errors.length) return { ok: false, errors };
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
      return { ok: true, file: target, warnings: mine.filter(finding => finding.level === 'warn').map(findingText) };
    } finally { cleanup(); }
  } else return { ok: false, errors: ['unknown file kind'] };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text.endsWith('\n') ? text : `${text}\n`);
  return { ok: true, file: target, warnings: [] };
}
