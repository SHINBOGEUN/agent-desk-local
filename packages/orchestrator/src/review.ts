// Gate G4: independent review. The policy decides whether a review is worth its
// cost; the prompt gives the verifier only what it needs (requirements, the real
// diff, the harness's own check results), never the builder's reasoning.

import type { Requirement } from '#core';
import { isTestPath } from './gates.ts';

/** `self` (for measurement, roadmap 3-5): the builder re-checks its own work in the same session instead of an independent verifier. */
export type ReviewPolicy = 'always' | 'auto' | 'never' | 'self';

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
  if (facts.policy === 'self') return { review: true, reason: 'review policy is "self" (the builder checks its own work)' };
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

/** Same facts as reviewPrompt, for the builder checking its own work in its own session. */
export function selfReviewPrompt(input: Parameters<typeof reviewPrompt>[0]): string {
  return `${reviewPrompt(input)}\n\nThis time you check your OWN work, as a reviewer would. Do not change any file. Re-read the changed files against the requirements and the request.\nSubmit a verifier report instead of a builder report. Shape: { "verdict": "PASS" | "REDO" | "BLOCKED", "blocking": [{ "file"?: string, "line"?: number, "reason": string, "evidence": string }], "optional": [strings] }. REDO only for an unmet requirement, wrong behaviour, an untrue report or a weakened check, each with concrete evidence. PASS has an empty "blocking" list.`;
}

/** What the previous review of this run found, for a re-review after a redo. */
export interface PreviousReview { findings: { file?: string; line?: number; reason: string }[]; changedSince: readonly string[] }

export function reviewPrompt(input: { request: string; requirements: Requirement[]; verifyLines: string[]; diffText: string; changedFiles: readonly string[]; testFiles: readonly string[]; unplannedFiles?: readonly string[]; previous?: PreviousReview }): string {
  const list = input.requirements.map(requirement => `- ${requirement.id}: ${requirement.text}`).join('\n');
  const testNote = input.testFiles.length
    ? `\nTest or check files were changed: ${input.testFiles.join(', ')}. Decide explicitly whether each change is required by the requirements or weakens a check (removed or loosened assertions, skipped tests). A weakened check is a blocking finding.\n`
    : '';
  const scopeNote = input.unplannedFiles?.length ? `\nFiles changed that the plan did not list: ${input.unplannedFiles.join(', ')}. Check that each one is needed for a requirement; unrequested changes are blocking.\n` : '';
  const checks = input.verifyLines.length ? input.verifyLines.map(line => `- ${line}`).join('\n') : '- (no verify commands are configured; nothing was checked automatically)';
  if (input.previous) {
    const earlier = input.previous.findings.map((finding, index) => `${index + 1}. ${finding.reason}${finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ''})` : ''}`).join('\n');
    return `Step: review (re-review after a redo).\nUser's original request:\n${input.request}\n\nRequirements the work must meet:\n${list}\n\nChecks the harness ran itself:\n${checks}\n${testNote}\nYour earlier blocking findings:\n${earlier}\n\nFiles changed since that review: ${input.previous.changedSince.join(', ') || '(none)'}\n\nDiff since that review:\n${input.diffText || '(no textual diff available; read the files)'}\n\nThe rest of the work was already reviewed. Decide for each earlier finding whether it is fixed: keep an unfixed one in "blocking" with the same file. Add a new blocking finding only for a file changed since that review. Other remarks go in "optional".`;
  }
  return `Step: review.\nUser's original request:\n${input.request}\n\nRequirements the work must meet:\n${list}\n\nChecks the harness ran itself:\n${checks}\n${testNote}${scopeNote}\nFiles changed: ${input.changedFiles.join(', ') || '(none)'}\n\nDiff:\n${input.diffText || '(no textual diff available; read the files)'}\n\nReview the actual files, not only the diff. Report a verdict.`;
}
