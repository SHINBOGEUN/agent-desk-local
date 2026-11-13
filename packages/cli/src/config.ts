// Minimal project settings for the CLI (full schema, roles and skills come in
// phase 4). File: <project>/.agent-desk/config.json. Unknown keys are errors so
// typos do not silently change behaviour.

import fs from 'node:fs';
import path from 'node:path';

export type ReviewPolicy = 'always' | 'auto' | 'never';

export interface ProjectConfig {
  runtime?: 'codex' | 'fake';
  verify?: string[];
  review?: ReviewPolicy;
  ignore?: string[];
  limits?: { redo?: number; tokens?: number; minutes?: number };
}

export type ConfigResult = { ok: true; config: ProjectConfig; exists: boolean } | { ok: false; errors: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim() !== '');

export function validateConfig(raw: unknown): ConfigResult {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['config: expected a JSON object'] };
  const known = new Set(['runtime', 'verify', 'review', 'ignore', 'limits']);
  for (const key of Object.keys(raw)) if (!known.has(key)) errors.push(`config.${key}: unknown key`);
  if (raw.runtime !== undefined && raw.runtime !== 'codex' && raw.runtime !== 'fake') errors.push('config.runtime: expected "codex" or "fake"');
  if (raw.verify !== undefined && !stringList(raw.verify)) errors.push('config.verify: expected a list of non-empty command strings');
  if (raw.ignore !== undefined && !stringList(raw.ignore)) errors.push('config.ignore: expected a list of path patterns');
  if (raw.review !== undefined && !['always', 'auto', 'never'].includes(raw.review as string)) errors.push('config.review: expected "always", "auto" or "never"');
  if (raw.limits !== undefined) {
    if (!isRecord(raw.limits)) errors.push('config.limits: expected an object');
    else {
      for (const key of Object.keys(raw.limits)) {
        if (!['redo', 'tokens', 'minutes'].includes(key)) errors.push(`config.limits.${key}: unknown key`);
        else if (!Number.isFinite(raw.limits[key]) || (raw.limits[key] as number) < (key === 'redo' ? 0 : 1)) errors.push(`config.limits.${key}: expected a ${key === 'redo' ? 'non-negative' : 'positive'} number`);
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, config: raw as ProjectConfig, exists: true };
}

export function loadProjectConfig(project: string): ConfigResult {
  const file = path.join(project, '.agent-desk', 'config.json');
  if (!fs.existsSync(file)) return { ok: true, config: {}, exists: false };
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return { ok: false, errors: [`${file}: not valid JSON (${error instanceof Error ? error.message : 'parse error'})`] }; }
  return validateConfig(raw);
}
