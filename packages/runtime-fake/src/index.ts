// A scripted runtime for tests and benchmark self-tests. Each session takes the
// next script queued for its role and plays one script turn per runTurn call:
// emitting messages, commands, file changes, usage and report submissions as a
// real runtime would. It makes harness behaviour testable without model usage,
// including failure cases seen in v1 (claiming success without changing files,
// hanging turns, writing during a read-only step).

import fs from 'node:fs';
import path from 'node:path';
import type { DoctorResult, HistoryQuery, NotesQuery, Runtime, RuntimeEvent, RoleId, Session, SessionOptions, TokenUsage, TurnInput, UserQuestion } from '#core';

export type FakeAction =
  | { message: string; final?: boolean }
  | { command: string; exitCode?: number; output?: string }
  | { writeFile: { path: string; content: string } }
  | { deleteFile: string }
  | { report: unknown }                       // calls tools.submitReport
  | { ask: UserQuestion }                     // calls tools.requestUserInput
  | { history: HistoryQuery }                 // calls tools.readHistory; the answer goes to record.answers
  | { notes: NotesQuery }                     // calls tools.readNotes; the answer goes to record.answers
  | { model: string }                         // the runtime reports the model it runs on
  | { usage: Partial<TokenUsage> }
  | { approval: { kind: string; detail?: unknown } }
  | { fail: string }                          // ends the turn as failed
  | { hang: true };                           // waits until the turn is aborted

export type FakeTurn = FakeAction[];

/** One session's behaviour: a list of turns, played in order. */
export interface FakeScript {
  turns: FakeTurn[];
}

export interface FakeTurnRecord {
  sessionId: string;
  role: RoleId;
  input: TurnInput;
  options: Omit<SessionOptions, 'tools'>;
  toolResults: { ok: boolean; message: string }[];
  answers: string[];
}

export interface FakeRuntimeOptions {
  /** Scripts queued per role; each new session of that role takes the next one. */
  scripts: Partial<Record<RoleId, FakeScript[]>>;
  /** Simulate a missing or broken runtime in doctor(). */
  healthy?: boolean;
}

const usageOf = (partial: Partial<TokenUsage>): TokenUsage => {
  const usage: TokenUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, ...partial };
  if (partial.totalTokens === undefined) usage.totalTokens = usage.inputTokens + usage.outputTokens;
  return usage;
};

function resolveInside(cwd: string, relative: string): string {
  const root = path.resolve(cwd);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`fake runtime refused a path outside the workspace: ${relative}`);
  return target;
}

export class FakeRuntime implements Runtime {
  readonly id = 'fake' as const;
  readonly turns: FakeTurnRecord[] = [];
  readonly #queues: Map<RoleId, FakeScript[]>;
  readonly #healthy: boolean;
  #nextId = 1;

  constructor(options: FakeRuntimeOptions) {
    this.#queues = new Map(Object.entries(options.scripts).map(([role, scripts]) => [role as RoleId, [...(scripts ?? [])]]));
    this.#healthy = options.healthy ?? true;
  }

  async doctor(): Promise<DoctorResult> {
    const ok = this.#healthy;
    return { runtime: 'fake', ok, checks: [{ name: 'fake runtime', ok, detail: ok ? 'scripted runtime ready' : 'simulated failure', ...(ok ? {} : { fix: 'construct FakeRuntime with healthy: true' }) }] };
  }

  /** Scripts not yet consumed; tests assert this is empty to catch unexpected flows. */
  remaining(role: RoleId): number {
    return this.#queues.get(role)?.length ?? 0;
  }

  async startSession(options: SessionOptions): Promise<Session> {
    const script = this.#queues.get(options.role)?.shift();
    if (!script) throw new Error(`fake runtime has no script left for role "${options.role}"`);
    const sessionId = `fake-${options.role}-${this.#nextId++}`;
    const runtime = this;
    let turnIndex = 0;
    let closed = false;
    const { tools, ...recordedOptions } = options;

    async function* runTurn(input: TurnInput, signal: AbortSignal): AsyncGenerator<RuntimeEvent> {
      if (closed) throw new Error(`session ${sessionId} is closed`);
      const turn = script!.turns[turnIndex++];
      if (!turn) throw new Error(`fake script for ${sessionId} has no turn ${turnIndex}`);
      const record: FakeTurnRecord = { sessionId, role: options.role, input, options: recordedOptions, toolResults: [], answers: [] };
      runtime.turns.push(record);
      for (const action of turn) {
        if (signal.aborted) { yield { type: 'turn_end', status: 'interrupted' }; return; }
        if ('message' in action) yield { type: 'message', text: action.message, final: action.final ?? false };
        else if ('command' in action) yield { type: 'command', command: action.command, exitCode: action.exitCode ?? 0, output: action.output ?? '' };
        else if ('writeFile' in action) {
          const target = resolveInside(options.cwd, action.writeFile.path);
          const existed = fs.existsSync(target);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, action.writeFile.content);
          yield { type: 'file_change', path: action.writeFile.path, kind: existed ? 'update' : 'add' };
        } else if ('deleteFile' in action) {
          fs.rmSync(resolveInside(options.cwd, action.deleteFile), { force: true });
          yield { type: 'file_change', path: action.deleteFile, kind: 'delete' };
        } else if ('report' in action) record.toolResults.push(await tools.submitReport(action.report));
        else if ('ask' in action) record.answers.push(await tools.requestUserInput(action.ask));
        else if ('model' in action) yield { type: 'session_info', model: action.model };
        else if ('history' in action) record.answers.push(tools.readHistory ? await tools.readHistory(action.history) : '(no readHistory)');
        else if ('notes' in action) record.answers.push(tools.readNotes ? await tools.readNotes(action.notes) : '(no readNotes)');
        else if ('usage' in action) yield { type: 'usage', delta: usageOf(action.usage) };
        else if ('approval' in action) yield { type: 'approval_request', id: `${sessionId}-approval-${record.toolResults.length}`, kind: action.approval.kind, detail: action.approval.detail ?? null };
        else if ('fail' in action) { yield { type: 'turn_end', status: 'failed', error: action.fail }; return; }
        else if ('hang' in action) {
          await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
          yield { type: 'turn_end', status: 'interrupted' };
          return;
        }
      }
      yield { type: 'turn_end', status: 'completed' };
    }

    return {
      id: sessionId,
      runTurn: (input, signal) => runTurn(input, signal),
      close: async () => { closed = true; },
    };
  }
}
