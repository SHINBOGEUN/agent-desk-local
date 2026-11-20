// Project settings: <project>/.agent-desk/config.json. Role instructions live in
// .agent-desk/agents/<role>.md (roles.ts); this file keeps only runtime
// assignment, verify commands, review policy and limits. Unknown keys are
// errors so a typo cannot silently change behaviour.

import fs from 'node:fs';
import path from 'node:path';
import type { RoleId } from '#core';

export type RuntimeKind = 'codex' | 'claude' | 'fake';
export type ReviewPolicy = 'always' | 'auto' | 'never' | 'self';
export type RuntimeSlot = 'primary' | 'review';
/**
 * Shorthand for runtimes.primary/review used by the dashboard and `--mode`:
 * one runtime for everything, or "<builder>+<reviewer>" (the first does the
 * work, the second reviews it in its own session).
 */
export type RuntimeMode = 'codex' | 'claude' | 'codex+claude' | 'claude+codex';
export const RUNTIME_MODES: readonly RuntimeMode[] = ['codex', 'claude', 'codex+claude', 'claude+codex'];
/** Used when config.runtimes is absent: Codex builds, Claude reviews (falls back to Codex when Claude is not installed). */
export const DEFAULT_MODE: RuntimeMode = 'codex+claude';

export function modeRuntimes(mode: RuntimeMode): { primary: RuntimeKind; review: RuntimeKind } {
  const [primary, review = primary] = mode.split('+') as [RuntimeKind, RuntimeKind?];
  return { primary, review };
}

/** The mode a config describes, or null when it uses something a mode cannot express (fake runtime). */
export function modeOf(config: ProjectConfig): RuntimeMode | null {
  if (config.mode) return config.mode;
  if (!config.runtimes) return DEFAULT_MODE;
  const primary = config.runtimes.primary ?? 'codex';
  const review = config.runtimes.review ?? primary;
  const mode = (primary === review ? primary : `${primary}+${review}`) as RuntimeMode;
  return RUNTIME_MODES.includes(mode) ? mode : null;
}

export interface ProjectConfig {
  /** Shorthand for runtimes: "codex", "claude", "codex+claude" (default: Codex builds, Claude reviews) or "claude+codex". */
  mode?: RuntimeMode;
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
  /** switchAtCodexPercent: Claude takes Codex's roles when Codex's 5-hour window is at least this full (default 95, 0 = off). */
  /** Notes folder (an Obsidian vault, or a folder inside one): absolute, or relative to the project. Default .agent-desk/notes. */
  vault?: string;
  limits?: { redo?: number; tokens?: number; minutes?: number; codexUsagePercent?: number; switchAtCodexPercent?: number };
}

export type ConfigResult = { ok: true; config: ProjectConfig; exists: boolean } | { ok: false; errors: string[] };

export const ROLE_NAMES: readonly RoleId[] = ['lead', 'builder', 'verifier', 'researcher'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim() !== '');
const KINDS = ['codex', 'claude', 'fake'];

export function validateConfig(raw: unknown): ConfigResult {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['config: expected a JSON object'] };
  for (const key of Object.keys(raw)) if (!['mode', 'runtimes', 'roles', 'skills', 'verify', 'review', 'language', 'ignore', 'allowCommands', 'limits', 'vault'].includes(key)) errors.push(`config.${key}: unknown key`);
  if (raw.mode !== undefined) {
    if (!(RUNTIME_MODES as readonly unknown[]).includes(raw.mode)) errors.push(`config.mode: expected one of ${RUNTIME_MODES.map(mode => `"${mode}"`).join(', ')}`);
    if (raw.runtimes !== undefined) errors.push('config.mode and config.runtimes both set; keep one');
  }
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
  if (raw.review !== undefined && !['always', 'auto', 'never', 'self'].includes(raw.review as string)) errors.push('config.review: expected "always", "auto", "never" or "self"');
  if (raw.language !== undefined && !['en', 'ko'].includes(raw.language as string)) errors.push('config.language: expected "en" or "ko"');
  if (raw.vault !== undefined && (typeof raw.vault !== 'string' || !raw.vault.trim())) errors.push('config.vault: expected a folder path');
  if (raw.limits !== undefined) {
    if (!isRecord(raw.limits)) errors.push('config.limits: expected an object');
    else for (const [key, value] of Object.entries(raw.limits)) {
      if (!['redo', 'tokens', 'minutes', 'codexUsagePercent', 'switchAtCodexPercent'].includes(key)) errors.push(`config.limits.${key}: unknown key`);
      else if (!Number.isFinite(value) || (value as number) < (key === 'redo' || key === 'switchAtCodexPercent' ? 0 : 1) || (key === 'switchAtCodexPercent' && (value as number) > 100)) errors.push(`config.limits.${key}: expected a ${key === 'redo' ? 'non-negative' : key === 'switchAtCodexPercent' ? '0-100' : 'positive'} number`);
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

export interface RuntimePlan {
  assignment: Record<RoleId, RuntimeKind>;
  primary: RuntimeKind;
  review: RuntimeKind;
  /** True when the review runtime comes from the built-in default (not from config, --mode or --runtime), so it may fall back to primary. */
  reviewIsDefault: boolean;
}

/**
 * Runtime per role. Precedence: `override` (--runtime, one kind for every role)
 * > `mode` (--mode / dashboard) > config.runtimes > DEFAULT_MODE.
 */
export function planRuntimes(config: ProjectConfig, options: { override?: RuntimeKind | undefined; mode?: RuntimeMode | undefined } = {}): RuntimePlan {
  const { override, mode } = options;
  const fromDefault = !override && !mode && !config.mode && !config.runtimes;
  const slots = override ? { primary: override, review: override } : mode ? modeRuntimes(mode) : config.mode ? modeRuntimes(config.mode) : config.runtimes ? { primary: config.runtimes.primary ?? 'codex', review: config.runtimes.review ?? config.runtimes.primary ?? 'codex' } : modeRuntimes(DEFAULT_MODE);
  const { primary, review } = slots;
  const pick = (role: RoleId): RuntimeKind => {
    if (override) return override;
    const slot = config.roles?.[role]?.runtime ?? (role === 'verifier' ? 'review' : 'primary');
    return slot === 'review' ? review : primary;
  };
  return { assignment: { lead: pick('lead'), builder: pick('builder'), verifier: pick('verifier'), researcher: pick('researcher') }, primary, review, reviewIsDefault: fromDefault && primary !== review };
}

/** Same plan with the review runtime replaced by the primary one (used when the default reviewer is not installed). */
export function withoutReviewRuntime(plan: RuntimePlan): RuntimePlan {
  const assignment = Object.fromEntries(Object.entries(plan.assignment).map(([role, kind]) => [role, kind === plan.review ? plan.primary : kind])) as Record<RoleId, RuntimeKind>;
  return { assignment, primary: plan.primary, review: plan.primary, reviewIsDefault: false };
}

/** Runtime kind per role (see planRuntimes). */
export function assignRuntimes(config: ProjectConfig, override?: RuntimeKind, mode?: RuntimeMode): Record<RoleId, RuntimeKind> {
  return planRuntimes(config, { override, mode }).assignment;
}
