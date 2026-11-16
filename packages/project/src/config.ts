// Project settings: <project>/.agent-desk/config.json. Role instructions live in
// .agent-desk/agents/<role>.md (roles.ts); this file keeps only runtime
// assignment, verify commands, review policy and limits. Unknown keys are
// errors so a typo cannot silently change behaviour.

import fs from 'node:fs';
import path from 'node:path';
import type { RoleId } from '#core';

export type RuntimeKind = 'codex' | 'claude' | 'fake';
export type ReviewPolicy = 'always' | 'auto' | 'never';
export type RuntimeSlot = 'primary' | 'review';

export interface ProjectConfig {
  /** Named runtimes. "primary" does the work; "review" (default: primary) is used by roles assigned to it. */
  runtimes?: { primary?: RuntimeKind; review?: RuntimeKind };
  /** Which named runtime a role uses. Defaults: verifier -> review, others -> primary. */
  roles?: Partial<Record<RoleId, { runtime?: RuntimeSlot }>>;
  /** Skill ids that sessions may use (.agent-desk/skills/<id>/SKILL.md). */
  skills?: string[];
  verify?: string[];
  review?: ReviewPolicy;
  /** Language of answers, summaries and the harness's messages. Default "en". */
  language?: 'en' | 'ko';
  ignore?: string[];
  /** Extra shell command prefixes Claude sessions may run without asking. */
  allowCommands?: string[];
  limits?: { redo?: number; tokens?: number; minutes?: number; codexUsagePercent?: number };
}

export type ConfigResult = { ok: true; config: ProjectConfig; exists: boolean } | { ok: false; errors: string[] };

export const ROLE_NAMES: readonly RoleId[] = ['lead', 'builder', 'verifier', 'researcher'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim() !== '');
const KINDS = ['codex', 'claude', 'fake'];

export function validateConfig(raw: unknown): ConfigResult {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['config: expected a JSON object'] };
  for (const key of Object.keys(raw)) if (!['runtimes', 'roles', 'skills', 'verify', 'review', 'language', 'ignore', 'allowCommands', 'limits'].includes(key)) errors.push(`config.${key}: unknown key`);
  if (raw.runtimes !== undefined) {
    if (!isRecord(raw.runtimes)) errors.push('config.runtimes: expected an object like { "primary": "codex", "review": "claude" }');
    else for (const [slot, kind] of Object.entries(raw.runtimes)) {
      if (slot !== 'primary' && slot !== 'review') errors.push(`config.runtimes.${slot}: unknown name (use "primary" or "review")`);
      else if (typeof kind !== 'string' || !KINDS.includes(kind)) errors.push(`config.runtimes.${slot}: expected "codex", "claude" or "fake"`);
    }
  }
  if (raw.roles !== undefined) {
    if (!isRecord(raw.roles)) errors.push('config.roles: expected an object');
    else for (const [role, entry] of Object.entries(raw.roles)) {
      if (!(ROLE_NAMES as readonly string[]).includes(role)) { errors.push(`config.roles.${role}: unknown role`); continue; }
      if (!isRecord(entry)) { errors.push(`config.roles.${role}: expected an object`); continue; }
      for (const key of Object.keys(entry)) {
        if (key !== 'runtime') errors.push(`config.roles.${role}.${key}: unknown key (access, effort and skills belong in .agent-desk/agents/${role}.md)`);
        else if (entry.runtime !== 'primary' && entry.runtime !== 'review') errors.push(`config.roles.${role}.runtime: expected "primary" or "review"`);
      }
    }
  }
  if (raw.skills !== undefined && !stringList(raw.skills)) errors.push('config.skills: expected a list of skill ids');
  if (raw.verify !== undefined && !stringList(raw.verify)) errors.push('config.verify: expected a list of non-empty command strings');
  if (raw.ignore !== undefined && !stringList(raw.ignore)) errors.push('config.ignore: expected a list of path patterns');
  if (raw.allowCommands !== undefined && !stringList(raw.allowCommands)) errors.push('config.allowCommands: expected a list of command prefixes');
  if (raw.review !== undefined && !['always', 'auto', 'never'].includes(raw.review as string)) errors.push('config.review: expected "always", "auto" or "never"');
  if (raw.language !== undefined && !['en', 'ko'].includes(raw.language as string)) errors.push('config.language: expected "en" or "ko"');
  if (raw.limits !== undefined) {
    if (!isRecord(raw.limits)) errors.push('config.limits: expected an object');
    else for (const [key, value] of Object.entries(raw.limits)) {
      if (!['redo', 'tokens', 'minutes', 'codexUsagePercent'].includes(key)) errors.push(`config.limits.${key}: unknown key`);
      else if (!Number.isFinite(value) || (value as number) < (key === 'redo' ? 0 : 1)) errors.push(`config.limits.${key}: expected a ${key === 'redo' ? 'non-negative' : 'positive'} number`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, config: raw as ProjectConfig, exists: true };
}

export const configPath = (project: string): string => path.join(project, '.agent-desk', 'config.json');

export function loadProjectConfig(project: string): ConfigResult {
  const file = configPath(project);
  if (!fs.existsSync(file)) return { ok: true, config: {}, exists: false };
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return { ok: false, errors: [`${file}: not valid JSON (${error instanceof Error ? error.message : 'parse error'})`] }; }
  return validateConfig(raw);
}

/** Runtime kind per role after applying defaults. `override` (the --runtime flag) wins over everything. */
export function assignRuntimes(config: ProjectConfig, override?: RuntimeKind): Record<RoleId, RuntimeKind> {
  const primary = config.runtimes?.primary ?? 'codex';
  const review = config.runtimes?.review ?? primary;
  const pick = (role: RoleId): RuntimeKind => {
    if (override) return override;
    const slot = config.roles?.[role]?.runtime ?? (role === 'verifier' ? 'review' : 'primary');
    return slot === 'review' ? review : primary;
  };
  return { lead: pick('lead'), builder: pick('builder'), verifier: pick('verifier'), researcher: pick('researcher') };
}
