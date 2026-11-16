// Public types of the orchestrator: what a run takes, what it records, and how
// it ends. The orchestrator is the "harness": it decides step order, which
// role runs which step, and when a run is over. Models only work inside steps.

import type { FailureType } from './failure.ts';
import type { Budget, GateResult } from './gates.ts';
import type { ReviewPolicy } from './review.ts';
import type { Access, AnswerReport, BuilderReport, ClassifyReport, PlanReport, ResearchReport, Effort, RoleId, SkillRef, Requirement, Runtime, RunStatus, RuntimeEvent, StepKind, TokenUsage, UsageEntry, UserQuestion, VerifierReport, WorkflowId } from '#core';

export interface RunConfig {
  /** Project folder the run works in. */
  cwd: string;
  /** One runtime for every role, or a map when roles use different runtimes. */
  runtime: Runtime | Partial<Record<RoleId, Runtime>>;
  /** Answers `request_user_input`. Without it the question is declined and the run ends as needs_user. */
  askUser?: (question: UserQuestion) => Promise<string>;
  /** Receives every event as it happens. */
  onEvent?: (event: RunEvent) => void;
  signal?: AbortSignal;
  /** Run Brief of the previous run in this project; only the classify step receives it. */
  previousBrief?: string;
  /** Gate G3: commands the harness runs itself; all must exit 0. Empty means no automatic verification. */
  verify?: string[];
  /** Time limit per verify command. Default 120 000 ms. */
  verifyTimeoutMs?: number;
  /** Gate G2: extra paths ignored when comparing changes ("dir/", "*.ext" or a path prefix). node_modules/ is always ignored. */
  ignore?: string[];
  /** Gate G5. */
  budget?: Budget;
  /** Gate G4. Default "always". */
  review?: ReviewPolicy;
  /** Limits for the "auto" policy. Defaults: 3 files, 60 changed lines. */
  autoReview?: { maxFiles?: number; maxLines?: number };
  /** Folder where a restore point is written before the build step. Omitted means none is made. */
  restorePointDir?: string;
  /** Contents of .agent-desk/memory.md, added to every role's instructions. */
  projectMemory?: string;
  /** Extra shell command prefixes sessions may run without asking (runtimes that use the approval broker). */
  allowCommands?: string[];
  /** plan-build: called with the plan before the build starts; returning false stops the run (needs_user). Omitted means the plan is accepted. */
  confirmPlan?: (plan: PlanReport, requirements: Requirement[]) => Promise<boolean>;
  /** Maximum REDO rounds after the first build attempt. Default 2. */
  redoLimit?: number;
  /** Per-role access from role files. Only the builder can be restricted; other roles are always read-only. */
  access?: Partial<Record<RoleId, Access>>;
  models?: Partial<Record<RoleId, string>>;
  effort?: Partial<Record<RoleId, Effort>>;
  /** Language of everything the user reads: agents are told to write answers, summaries and reasons in it, and the harness's own messages follow it. Default "en". */
  language?: 'en' | 'ko';
  /** Extra text appended to a role's instructions (project rules). */
  roleNotes?: Partial<Record<RoleId, string>>;
  /** Skills per role (from role files). Each session gets them as SessionOptions.skills and as a list in its instructions; SKILL.md is read only when needed. */
  skills?: Partial<Record<RoleId, SkillRef[]>>;
}

export type RunEventBody =
  | { type: 'run_started'; request: string }
  | { type: 'step_started'; step: StepKind; role: RoleId }
  | { type: 'runtime'; step: StepKind; role: RoleId; event: RuntimeEvent }
  | { type: 'report'; step: StepKind; kind: string; accepted: boolean; detail: string }
  | { type: 'user_question'; step: StepKind; question: string; answered: boolean }
  | { type: 'gate'; result: GateResult }
  | { type: 'retry'; step: StepKind; reason: string }
  | { type: 'redo'; attempt: number; mode: 'same-session' | 'new-session'; reasons: string[] }
  | { type: 'step_finished'; step: StepKind; ok: boolean; detail: string }
  | { type: 'run_finished'; status: RunStatus; reason: string };

export type RunEvent = RunEventBody & { seq: number; at: string };

export interface RunResult {
  status: RunStatus;
  /** One sentence for the user: why the run ended this way. */
  reason: string;
  workflow?: WorkflowId;
  requirements: Requirement[];
  classify?: ClassifyReport;
  answer?: AnswerReport;
  builder?: BuilderReport;
  /** Facts the builder proposed for .agent-desk/memory.md; nothing is written automatically. */
  memorySuggestions?: string[];
  plan?: PlanReport;
  research?: ResearchReport[];
  review?: VerifierReport;
  /** Why no review ran, when none did. */
  reviewSkipped?: string;
  /** Every gate evaluation in order. */
  gates: GateResult[];
  /** REDO rounds used. */
  redo: number;
  /** Things the user should know although the run ended: no verify commands, changed test files. */
  warnings: string[];
  /** What the builder could not check, passed through unchanged. */
  unverified: string[];
  /** Why a failed run failed, when the harness can tell. */
  failureType?: FailureType;
  /** Where a run stopped by a budget can be picked up. */
  resume?: { step: StepKind; redo: number; note: string };
  /** Present when a restore point was made before the build step. */
  restorePoint?: { dir: string; files: number; bytes: number };
  usage: TokenUsage;
  usageEntries: readonly UsageEntry[];
  events: RunEvent[];
}
