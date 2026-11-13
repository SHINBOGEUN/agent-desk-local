import type { Access, Effort, RoleId } from '#core';
import { loadProjectConfig, ROLE_NAMES } from './config.ts';
import type { ProjectConfig } from './config.ts';
import { loadRoles } from './roles.ts';
import type { RoleDefinition } from './roles.ts';

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
export function roleSettings(loaded: LoadedProject): { access: Partial<Record<RoleId, Access>>; effort: Partial<Record<RoleId, Effort>>; models: Partial<Record<RoleId, string>>; roleNotes: Partial<Record<RoleId, string>> } {
  const access: Partial<Record<RoleId, Access>> = {};
  const effort: Partial<Record<RoleId, Effort>> = {};
  const models: Partial<Record<RoleId, string>> = {};
  const roleNotes: Partial<Record<RoleId, string>> = {};
  for (const role of ROLE_NAMES) {
    const definition = loaded.roles[role];
    if (definition.access) access[role] = definition.access;
    if (definition.effort) effort[role] = definition.effort;
    if (definition.model) models[role] = definition.model;
    if (definition.body) roleNotes[role] = definition.body;
  }
  return { access, effort, models, roleNotes };
}
export * from './init.ts';
