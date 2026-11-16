// Role definition files: .agent-desk/agents/<role>.md. A small frontmatter
// (access, effort, model, skills, description) followed by project-specific
// instructions that are added to the harness's built-in role instructions.
// A missing file means the built-in defaults are used, and `doctor` says so.

import fs from 'node:fs';
import path from 'node:path';
import type { Access, Effort, RoleId } from '#core';
import { ROLE_NAMES } from './config.ts';

export interface RoleDefinition {
  role: RoleId;
  /** Absolute path, or null when the file does not exist and defaults are used. */
  file: string | null;
  description?: string;
  access?: Access;
  effort?: Effort;
  model?: string;
  /** Model per runtime (frontmatter model-codex / model-claude); wins over `model` for that runtime. */
  modelByRuntime?: { codex?: string; claude?: string };
  skills: string[];
  /** Project-specific instructions (the markdown body). */
  body: string;
}

export interface RolesResult {
  roles: Record<RoleId, RoleDefinition>;
  missing: RoleId[];
  errors: string[];
}

/** Read-only by design: these roles may never be given write access by a file. */
const READ_ONLY_ROLES: ReadonlySet<RoleId> = new Set(['lead', 'verifier', 'researcher']);
const KEYS = new Set(['description', 'access', 'effort', 'model', 'model-codex', 'model-claude', 'skills']);

export function parseFrontmatter(text: string): { data: Record<string, string | string[]>; body: string; error?: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { data: {}, body: normalized.trim() };
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return { data: {}, body: '', error: 'frontmatter is not closed with "---"' };
  const data: Record<string, string | string[]> = {};
  let currentList: string | null = null;
  for (const line of normalized.slice(4, end).split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && currentList) { (data[currentList] as string[]).push(item[1]!.trim()); continue; }
    const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) return { data, body: '', error: `cannot read frontmatter line "${line.trim()}"` };
    const [, key, value] = pair as unknown as [string, string, string];
    currentList = null;
    if (value.trim() === '') { data[key] = []; currentList = key; }
    else if (value.trim().startsWith('[') && value.trim().endsWith(']')) data[key] = value.trim().slice(1, -1).split(',').map(entry => entry.trim()).filter(Boolean);
    else data[key] = value.trim().replace(/^["']|["']$/g, '');
  }
  return { data, body: normalized.slice(end + 4).replace(/^\n/, '').trim() };
}

export function roleFilePath(project: string, role: RoleId): string {
  return path.join(project, '.agent-desk', 'agents', `${role}.md`);
}

export function loadRoles(project: string): RolesResult {
  const roles = {} as Record<RoleId, RoleDefinition>;
  const missing: RoleId[] = [];
  const errors: string[] = [];
  for (const role of ROLE_NAMES) {
    const file = roleFilePath(project, role);
    if (!fs.existsSync(file)) { missing.push(role); roles[role] = { role, file: null, skills: [], body: '' }; continue; }
    const where = `.agent-desk/agents/${role}.md`;
    const parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const definition: RoleDefinition = { role, file, skills: [], body: parsed.body };
    if (parsed.error) errors.push(`${where}: ${parsed.error}`);
    for (const [key, value] of Object.entries(parsed.data)) {
      if (!KEYS.has(key)) { errors.push(`${where}: unknown frontmatter key "${key}"`); continue; }
      if (key === 'skills') { if (Array.isArray(value)) definition.skills = value; else errors.push(`${where}: skills must be a list`); continue; }
      if (typeof value !== 'string' || !value) { errors.push(`${where}: ${key} must be a single value`); continue; }
      if (key === 'access') {
        if (value !== 'read-only' && value !== 'workspace-write') errors.push(`${where}: access must be "read-only" or "workspace-write"`);
        else if (value === 'workspace-write' && READ_ONLY_ROLES.has(role)) errors.push(`${where}: the ${role} role is read-only; a file cannot grant write access`);
        else definition.access = value;
      } else if (key === 'effort') {
        if (value !== 'low' && value !== 'medium' && value !== 'high') errors.push(`${where}: effort must be "low", "medium" or "high"`);
        else definition.effort = value;
      } else if (key === 'model') definition.model = value;
      else if (key === 'model-codex' || key === 'model-claude') definition.modelByRuntime = { ...definition.modelByRuntime, [key === 'model-codex' ? 'codex' : 'claude']: value };
      else if (key === 'description') definition.description = value;
    }
    roles[role] = definition;
  }
  return { roles, missing, errors };
}

/** Template written by `init` and used when a role file is created from the dashboard. */
export function roleTemplate(role: RoleId, skills: string[] = []): string {
  const defaults: Record<RoleId, { access: Access; effort: Effort; description: string }> = {
    lead: { access: 'read-only', effort: 'low', description: 'Reads the request, chooses the workflow, writes plans.' },
    builder: { access: 'workspace-write', effort: 'high', description: 'Changes files to fulfil the requirements.' },
    verifier: { access: 'read-only', effort: 'medium', description: 'Reviews the builder\'s work independently.' },
    researcher: { access: 'read-only', effort: 'medium', description: 'Investigates one angle of a question.' },
  };
  const d = defaults[role];
  return `---\ndescription: ${d.description}\naccess: ${d.access}\neffort: ${d.effort}\nskills: [${skills.join(', ')}]\n---\n\nProject-specific rules for the ${role} go here, one per line. The harness already gives this role its built-in instructions; add only what is specific to this project.\n`;
}
