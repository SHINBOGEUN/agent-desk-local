import type { Access, Effort, RoleId, SkillRef } from '#core';
import { loadProjectConfig, ROLE_NAMES } from './config.ts';
import type { ProjectConfig, RuntimeKind } from './config.ts';
import { loadRoles } from './roles.ts';
import type { RoleDefinition } from './roles.ts';
import { checkSkills } from './skills.ts';

export * from './config.ts';
export * from './roles.ts';

export interface LoadedProject {
  config: ProjectConfig;
  configExists: boolean;
  roles: Record<RoleId, RoleDefinition>;
  missingRoles: RoleId[];
  errors: string[];
  /** Things worth telling the user that are not errors. */
  warnings: string[];
}

export function loadProject(project: string): LoadedProject {
  const config = loadProjectConfig(project);
  const roles = loadRoles(project);
  const errors = [...(config.ok ? [] : config.errors), ...roles.errors];
  const warnings: string[] = [];
  if (roles.missing.length) warnings.push(`No role file for ${roles.missing.join(', ')} in .agent-desk/agents/; built-in defaults are used. Run "agent-desk init" to create them.`);
  return { config: config.ok ? config.config : {}, configExists: config.ok ? config.exists : true, roles: roles.roles, missingRoles: roles.missing, errors, warnings };
}

/** Per-role settings for RunConfig, taken from the role files. */
/** `assignment` picks model-codex / model-claude for the runtime each role runs on; plain `model` applies otherwise. */
export function roleSettings(loaded: LoadedProject, assignment?: Partial<Record<RoleId, RuntimeKind>>): { access: Partial<Record<RoleId, Access>>; effort: Partial<Record<RoleId, Effort>>; models: Partial<Record<RoleId, string>>; roleNotes: Partial<Record<RoleId, string>> } {
  const access: Partial<Record<RoleId, Access>> = {};
  const effort: Partial<Record<RoleId, Effort>> = {};
  const models: Partial<Record<RoleId, string>> = {};
  const roleNotes: Partial<Record<RoleId, string>> = {};
  for (const role of ROLE_NAMES) {
    const definition = loaded.roles[role];
    if (definition.access) access[role] = definition.access;
    if (definition.effort) effort[role] = definition.effort;
    const kind = assignment?.[role];
    const perRuntime = kind === 'codex' || kind === 'claude' ? definition.modelByRuntime?.[kind] : undefined;
    const model = perRuntime ?? definition.model;
    if (model) models[role] = model;
    if (definition.body) roleNotes[role] = definition.body;
  }
  return { access, effort, models, roleNotes };
}
/**
 * Skills each role's sessions may use, for RunConfig.skills. Skill files stay
 * where they are (.agent-desk/skills/<id>/SKILL.md); nothing is copied into
 * runtime folders. A role gets the skills its role file lists, limited to
 * config.skills when that list exists. Skills that fail `skills check` with an
 * error, or do not exist, are left out and reported through onSkip.
 */
export function skillsByRole(project: string, loaded: LoadedProject, onSkip?: (id: string, reason: string) => void): Partial<Record<RoleId, SkillRef[]>> {
  const wanted = new Set(ROLE_NAMES.flatMap(role => loaded.roles[role].skills));
  if (!wanted.size) return {};
  const report = checkSkills(project, loaded.config, loaded.roles);
  const broken = new Map<string, string>();
  for (const finding of report.findings) if (finding.level === 'error' && finding.skill !== 'project' && !broken.has(finding.skill)) broken.set(finding.skill, finding.message);
  const usable = new Map(report.skills.filter(skill => !broken.has(skill.id)).map(skill => [skill.id, skill]));
  const enabled = loaded.config.skills ? new Set(loaded.config.skills) : null;
  const skipped = new Set<string>();
  const skip = (id: string, reason: string) => { if (!skipped.has(id)) { skipped.add(id); onSkip?.(id, reason); } };
  const out: Partial<Record<RoleId, SkillRef[]>> = {};
  for (const role of ROLE_NAMES) {
    const refs: SkillRef[] = [];
    for (const id of loaded.roles[role].skills) {
      if (enabled && !enabled.has(id)) { skip(id, 'not listed in config.skills'); continue; }
      const skill = usable.get(id);
      if (!skill) { skip(id, broken.get(id) ?? `.agent-desk/skills/${id}/SKILL.md does not exist`); continue; }
      if (!refs.some(ref => ref.id === id)) refs.push({ id: skill.id, description: skill.description, path: skill.path });
    }
    if (refs.length) out[role] = refs;
  }
  return out;
}
export * from './init.ts';
export * from './skills.ts';
export * from './memory.ts';
