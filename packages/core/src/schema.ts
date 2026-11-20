// Small dependency-free validators for reports submitted by models.
// Errors carry a path ("requirements[1].status") so the harness can tell the
// model exactly what to fix (gate G1), instead of a generic "invalid report".

import type { ReportByKind, ReportKind } from './types.ts';
import { WORKFLOW_IDS } from './types.ts';

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

type Check = (value: unknown, path: string, errors: string[]) => void;

const describe = (value: unknown): string => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

const string = ({ min = 0, max = 20_000 }: { min?: number; max?: number } = {}): Check => (value, path, errors) => {
  if (typeof value !== 'string') { errors.push(`${path}: expected string, got ${describe(value)}`); return; }
  if (value.trim().length < min) errors.push(`${path}: must not be empty`);
  if (value.length > max) errors.push(`${path}: longer than ${max} characters`);
};

const integer = (): Check => (value, path, errors) => {
  if (!Number.isInteger(value)) errors.push(`${path}: expected integer, got ${describe(value)}`);
};

const oneOf = (allowed: readonly string[]): Check => (value, path, errors) => {
  if (typeof value !== 'string' || !allowed.includes(value)) errors.push(`${path}: expected one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`);
};

const array = (item: Check, { max = 500 }: { max?: number } = {}): Check => (value, path, errors) => {
  if (!Array.isArray(value)) { errors.push(`${path}: expected array, got ${describe(value)}`); return; }
  if (value.length > max) errors.push(`${path}: more than ${max} items`);
  value.forEach((entry, index) => item(entry, `${path}[${index}]`, errors));
};

const object = (fields: Record<string, Check>, optional: Record<string, Check> = {}): Check => (value, path, errors) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) { errors.push(`${path}: expected object, got ${describe(value)}`); return; }
  const record = value as Record<string, unknown>;
  for (const [key, check] of Object.entries(fields)) {
    if (!(key in record)) errors.push(`${path}.${key}: required`);
    else check(record[key], `${path}.${key}`, errors);
  }
  for (const [key, check] of Object.entries(optional)) if (key in record && record[key] !== undefined) check(record[key], `${path}.${key}`, errors);
  for (const key of Object.keys(record)) if (!(key in fields) && !(key in optional)) errors.push(`${path}.${key}: unknown field`);
};

const requirementId = string({ min: 1, max: 40 });

const schemas: { [K in ReportKind]: Check } = {
  classify: object({
    workflow: oneOf(WORKFLOW_IDS),
    requirements: array(object({ id: requirementId, text: string({ min: 1, max: 1_000 }) }, { quote: string({ max: 500 }), source: string({ min: 1, max: 300 }) }), { max: 30 }),
    reason: string({ min: 1, max: 1_000 }),
  }),
  answer: object({
    answer: string({ min: 1 }),
    sources: array(string({ min: 1, max: 1_000 }), { max: 50 }),
  }),
  builder: object({
    summary: string({ min: 1, max: 4_000 }),
    changedFiles: array(string({ min: 1, max: 1_000 })),
    commandsRun: array(object({ command: string({ min: 1, max: 2_000 }), exitCode: integer() })),
    requirements: array(object({ id: requirementId, status: oneOf(['done', 'not_done', 'unverified']), evidence: string({ max: 2_000 }) }), { max: 30 }),
    unverified: array(string({ min: 1, max: 1_000 }), { max: 50 }),
  }, { memorySuggestions: array(string({ min: 1, max: 1_000 }), { max: 5 }) }),
  verifier: object({
    verdict: oneOf(['PASS', 'REDO', 'BLOCKED']),
    blocking: array(object({ reason: string({ min: 1, max: 2_000 }), evidence: string({ min: 1, max: 4_000 }) }, { file: string({ min: 1, max: 1_000 }), line: integer() }), { max: 50 }),
    optional: array(string({ min: 1, max: 1_000 }), { max: 50 }),
  }),
  plan: object({
    approach: string({ min: 1, max: 4_000 }),
    steps: array(string({ min: 1, max: 1_000 }), { max: 30 }),
    files: array(string({ min: 1, max: 1_000 }), { max: 100 }),
    risks: array(string({ min: 1, max: 1_000 }), { max: 30 }),
  }),
  research: object({
    angle: string({ min: 1, max: 1_000 }),
    summary: string({ min: 1, max: 6_000 }),
    findings: array(object({ claim: string({ min: 1, max: 1_000 }), evidence: string({ min: 1, max: 2_000 }) }), { max: 50 }),
    sources: array(string({ min: 1, max: 1_000 }), { max: 50 }),
  }),
};

export function validateReport<K extends ReportKind>(kind: K, value: unknown): Validation<ReportByKind[K]> {
  const errors: string[] = [];
  schemas[kind](value, kind, errors);
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: value as ReportByKind[K] };
}

/** Cross-field rules that the shape check cannot express. */
export function reportConsistencyErrors<K extends ReportKind>(kind: K, report: ReportByKind[K]): string[] {
  const errors: string[] = [];
  if (kind === 'verifier') {
    const verifier = report as ReportByKind['verifier'];
    if (verifier.verdict === 'PASS' && verifier.blocking.length) errors.push('verifier.verdict: PASS cannot have blocking findings');
    if (verifier.verdict === 'REDO' && !verifier.blocking.length) errors.push('verifier.blocking: REDO needs at least one blocking finding');
  }
  if (kind === 'plan') {
    if (!(report as ReportByKind['plan']).steps.length) errors.push('plan.steps: give at least one step');
  }
  if (kind === 'classify') {
    const classify = report as ReportByKind['classify'];
    const ids = classify.requirements.map(requirement => requirement.id);
    if (new Set(ids).size !== ids.length) errors.push('classify.requirements: ids must be unique');
    if (classify.workflow !== 'answer' && classify.workflow !== 'investigate' && !ids.length) errors.push('classify.requirements: build workflows need at least one requirement');
  }
  return errors;
}
