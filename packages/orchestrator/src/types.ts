// Public types of the orchestrator: what a run takes, what it records, and how
// it ends. The orchestrator is the "harness": it decides step order, which
// role runs which step, and when a run is over. Models only work inside steps.

import type { AnswerReport, BuilderReport, ClassifyReport, Effort, RoleId, Requirement, Runtime, RunStatus, RuntimeEvent, StepKind, TokenUsage, UsageEntry, UserQuestion, WorkflowId } from '#core';

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
  models?: Partial<Record<RoleId, string>>;
  effort?: Partial<Record<RoleId, Effort>>;
  /** Extra text appended to a role's instructions (project rules). */
  roleNotes?: Partial<Record<RoleId, string>>;
}

export type RunEventBody =
  | { type: 'run_started'; request: string }
  | { type: 'step_started'; step: StepKind; role: RoleId }
  | { type: 'runtime'; step: StepKind; role: RoleId; event: RuntimeEvent }
  | { type: 'report'; step: StepKind; kind: string; accepted: boolean; detail: string }
  | { type: 'user_question'; step: StepKind; question: string; answered: boolean }
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
  usage: TokenUsage;
  usageEntries: readonly UsageEntry[];
  events: RunEvent[];
}
