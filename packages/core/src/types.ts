// Domain model for Agent Desk v2. The harness (code) decides order, gates,
// permissions, budgets and retries; runtimes (Codex, Claude, fake) only do the
// work inside a step. See the v2 design doc, "핵심 개념 모델".

export type RoleId = 'lead' | 'builder' | 'verifier' | 'researcher';
export const ROLE_IDS: readonly RoleId[] = ['lead', 'builder', 'verifier', 'researcher'];

export type WorkflowId = 'answer' | 'investigate' | 'build' | 'plan-build';
export const WORKFLOW_IDS: readonly WorkflowId[] = ['answer', 'investigate', 'build', 'plan-build'];

export type StepKind = 'classify' | 'plan' | 'research' | 'build' | 'gate' | 'review' | 'report';

export type Access = 'read-only' | 'workspace-write';
export type Effort = 'low' | 'medium' | 'high';
export type RuntimeId = 'codex' | 'claude' | 'fake';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'completed'      // every gate passed
  | 'needs_review'   // REDO limit reached or a gate could not be satisfied
  | 'needs_user'     // waiting on an answer or approval from the user
  | 'failed'         // environment or runtime error the harness cannot fix
  | 'interrupted';   // cancelled, timed out or stopped by a budget

/** Token counts for ONE turn. Runtimes must report increments, never running totals. */
export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface Requirement {
  id: string;   // stable within a run, e.g. "R1"
  text: string;
  /** The words of the user's request this requirement comes from (checked by the harness). */
  quote?: string;
}

// ---------------------------------------------------------------------------
// Reports submitted by steps through the `submit_report` harness tool.

export interface ClassifyReport {
  workflow: WorkflowId;
  requirements: Requirement[];
  reason: string;
}

export interface AnswerReport {
  answer: string;
  sources: string[];   // files or links the answer is based on
}

export type RequirementStatus = 'done' | 'not_done' | 'unverified';

export interface BuilderReport {
  summary: string;
  changedFiles: string[];                                   // gate G2 compares this with the real diff
  commandsRun: { command: string; exitCode: number }[];
  requirements: { id: string; status: RequirementStatus; evidence: string }[];
  unverified: string[];                                     // what could not be checked, stated openly
  /** Optional: facts about the project (not about this change) that later runs should know. The user decides whether they are kept. */
  memorySuggestions?: string[];
}

export interface VerifierFinding {
  file?: string;
  line?: number;
  reason: string;
  evidence: string;
}

export interface VerifierReport {
  verdict: 'PASS' | 'REDO' | 'BLOCKED';
  blocking: VerifierFinding[];   // only correctness or stated requirements
  optional: string[];            // suggestions; never a reason for REDO
}

/** Output of the plan step of `plan-build`: how the builder should approach the work. */
export interface PlanReport {
  approach: string;       // the chosen approach, in a few sentences
  steps: string[];        // ordered implementation steps
  files: string[];        // files expected to change (a hint, not a limit)
  risks: string[];        // what could go wrong or is still unknown
}

/** Output of one researcher in `investigate`. */
export interface ResearchReport {
  angle: string;          // the angle this researcher was given
  summary: string;
  findings: { claim: string; evidence: string }[];
  sources: string[];
}

export type ReportKind = 'classify' | 'answer' | 'builder' | 'verifier' | 'plan' | 'research';

export interface ReportByKind {
  classify: ClassifyReport;
  answer: AnswerReport;
  builder: BuilderReport;
  verifier: VerifierReport;
  plan: PlanReport;
  research: ResearchReport;
}

// ---------------------------------------------------------------------------
// Runtime contract. Every runtime adapter implements these interfaces and
// translates its own protocol into RuntimeEvent.

export type RuntimeEvent =
  | { type: 'message'; text: string; final: boolean }
  | { type: 'command'; command: string; exitCode: number | null; output: string }
  | { type: 'file_change'; path: string; kind: 'add' | 'update' | 'delete' }
  /** A file the session read with a read tool (Claude's Read). Codex reads through commands. */
  | { type: 'file_read'; path: string }
  | { type: 'approval_request'; id: string; kind: string; detail: unknown }
  | { type: 'usage'; delta: TokenUsage }
  | { type: 'turn_end'; status: 'completed' | 'interrupted' | 'failed'; error?: string };

export interface UserQuestion {
  question: string;
  options?: string[];
}

export interface ToolResult {
  ok: boolean;
  message: string;   // shown to the model; explains what to fix when ok is false
}

/** A permission question from a runtime that asks the harness to decide (Claude's permission prompt tool). */
export interface ApprovalRequest {
  toolName: string;
  input: unknown;
  toolUseId?: string;
}

export type ApprovalDecision =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'deny'; message: string };

/**
 * Harness tools a session may call. Real runtimes reach these through the
 * local MCP server (tools-mcp); the fake runtime calls them directly.
 */
export interface HarnessTools {
  submitReport(report: unknown): Promise<ToolResult>;
  requestUserInput(question: UserQuestion): Promise<string>;
  /** Optional: runtimes that delegate permission prompts call this. Missing means deny. */
  approve?(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface SkillRef {
  id: string;
  description: string;
  path: string;        // SKILL.md location
}

export interface SessionOptions {
  role: RoleId;
  cwd: string;
  access: Access;
  instructions: string;
  model?: string;
  effort?: Effort;
  skills: SkillRef[];
  tools: HarnessTools;
}

export interface TurnInput {
  text: string;
  images?: string[];   // local file paths
}

export interface Session {
  readonly id: string;
  runTurn(input: TurnInput, signal: AbortSignal): AsyncIterable<RuntimeEvent>;
  close(): Promise<void>;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;        // one concrete action when not ok
}

export interface DoctorResult {
  runtime: RuntimeId;
  ok: boolean;
  checks: DoctorCheck[];
}

export interface Runtime {
  readonly id: RuntimeId;
  doctor(): Promise<DoctorResult>;
  startSession(options: SessionOptions): Promise<Session>;
}
