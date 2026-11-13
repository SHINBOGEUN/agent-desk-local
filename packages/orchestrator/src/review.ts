// Gate G4: independent review. The policy decides whether a review is worth its
// cost; the prompt gives the verifier only what it needs (requirements, the real
// diff, the harness's own check results), never the builder's reasoning.

import type { Requirement } from '#core';
import { isTestPath } from './gates.ts';

export type ReviewPolicy = 'always' | 'auto' | 'never';

export interface AutoReviewLimits {
  maxFiles: number;
  maxLines: number;
}

export const DEFAULT_AUTO_LIMITS: AutoReviewLimits = { maxFiles: 3, maxLines: 60 };

const SECURITY_PATH = /(auth|login|passw|secret|token|crypto|credential|permission|security|\.env|csrf|session)/i;

export const isSecurityPath = (rel: string): boolean => SECURITY_PATH.test(rel);

export interface ReviewFacts {
  policy: ReviewPolicy;
  /** True when no verify command ran (none configured). */
  verifySkipped: boolean;
  changedFiles: readonly string[];
  changedLines: number;
  linesUnknown: boolean;
  limits: AutoReviewLimits;
}

export interface ReviewDecision {
  review: boolean;
  reason: string;
}

export function decideReview(facts: ReviewFacts): ReviewDecision {
  if (facts.policy === 'never') return { review: false, reason: 'review policy is "never"' };
  if (facts.policy === 'always') return { review: true, reason: 'review policy is "always"' };
  if (facts.verifySkipped) return { review: true, reason: 'no verify commands, so review stays on' };
  const tests = facts.changedFiles.filter(isTestPath);
  if (tests.length) return { review: true, reason: `test or check files changed (${tests.join(', ')})` };
  const security = facts.changedFiles.filter(isSecurityPath);
  if (security.length) return { review: true, reason: `security-related files changed (${security.join(', ')})` };
  if (facts.changedFiles.length > facts.limits.maxFiles) return { review: true, reason: `${facts.changedFiles.length} files changed (limit ${facts.limits.maxFiles})` };
  if (facts.linesUnknown) return { review: true, reason: 'the size of the change could not be measured' };
  if (facts.changedLines > facts.limits.maxLines) return { review: true, reason: `${facts.changedLines} lines changed (limit ${facts.limits.maxLines})` };
  return { review: false, reason: 'small change, verify commands passed, no test or security files touched' };
}

export function reviewPrompt(input: { request: string; requirements: Requirement[]; verifyLines: string[]; diffText: string; changedFiles: readonly string[]; testFiles: readonly string[] }): string {
  const list = input.requirements.map(requirement => `- ${requirement.id}: ${requirement.text}`).join('\n');
  const testNote = input.testFiles.length
    ? `\nTest or check files were changed: ${input.testFiles.join(', ')}. Decide explicitly whether each change is required by the requirements or weakens a check (removed or loosened assertions, skipped tests). A weakened check is a blocking finding.\n`
    : '';
  const checks = input.verifyLines.length ? input.verifyLines.map(line => `- ${line}`).join('\n') : '- (no verify commands are configured; nothing was checked automatically)';
  return `Step: review.\nUser's original request:\n${input.request}\n\nRequirements the work must meet:\n${list}\n\nChecks the harness ran itself:\n${checks}\n${testNote}\nFiles changed: ${input.changedFiles.join(', ') || '(none)'}\n\nDiff:\n${input.diffText || '(no textual diff available; read the files)'}\n\nReview the actual files, not only the diff. Report a verdict.`;
}
