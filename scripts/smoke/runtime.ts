// Smoke test of a real runtime against the harness contract. Run on your PC
// when no benchmark is measuring usage; it makes a few very small requests.
//
//   node scripts/smoke/runtime.ts codex
//   node scripts/smoke/runtime.ts claude [--command <path>] [--model <id>]
//
// It checks the assumptions the unit tests cannot: that events from the real
// CLI are translated (messages, commands, file changes, usage), that the report
// tool works through MCP, that read-only sessions cannot write, and that an
// abort interrupts a turn. Results go to scripts/smoke/results/<runtime>.json.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeEvent, Session, SessionOptions } from '#core';
import { ClaudeRuntime } from '#runtime-claude';
import { CodexRuntime } from '#runtime-codex';
import { ReportCollector } from '#tools-mcp';
import { dataDirectory, locate, readMachineSettings } from '#service';
import { decideApproval } from '#orchestrator';

const [kind, ...rest] = process.argv.slice(2);
const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
if (kind !== 'codex' && kind !== 'claude') { console.error('usage: node scripts/smoke/runtime.ts codex|claude [--command <path>] [--model <id>]'); process.exit(64); }

const found = flag('command') ? null : locate(kind, process.env, process.platform, readMachineSettings(dataDirectory(process.env, process.platform)));
const command = flag('command') ?? found?.path;
if (found) console.log(`using ${kind} at ${found.path} (${found.source})`);
const runtime: CodexRuntime | ClaudeRuntime = kind === 'codex' ? new CodexRuntime(command ? { command } : {}) : new ClaudeRuntime(command ? { command } : {});
const model = flag('model');
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail: string) => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`); };
const transcript: unknown[] = [];

async function turn(session: Session, text: string, signal = new AbortController().signal): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of session.runTurn({ text }, signal)) { events.push(event); transcript.push(event); }
  return events;
}
const end = (events: RuntimeEvent[]) => events.at(-1) as Extract<RuntimeEvent, { type: 'turn_end' }> | undefined;
const usageOf = (events: RuntimeEvent[]) => events.reduce((sum, event) => (event.type === 'usage' ? sum + event.delta.totalTokens : sum), 0);

const doctor = await runtime.doctor();
for (const item of doctor.checks) check(item.name, item.ok, item.detail);
if (!doctor.ok) { console.error('Runtime is not usable; fix the above and re-run.'); process.exit(1); }

const work = fs.mkdtempSync(path.join(os.tmpdir(), `agent-desk-smoke-${kind}-`));
fs.writeFileSync(path.join(work, 'notes.txt'), 'The secret word is pineapple.\n');
console.log(`workspace: ${work}`);
const base = (tools: SessionOptions['tools'], access: SessionOptions['access']): SessionOptions => ({
  role: access === 'read-only' ? 'lead' : 'builder', cwd: work, access, skills: [], tools, ...(model ? { model } : {}),
  instructions: 'You are part of a test. Follow the instruction exactly. Be brief. Report through the submit_report tool when asked.',
});

try {
  // 1. read-only session reads a file and reports through the MCP tool
  const collector = new ReportCollector('answer');
  const approvals: string[] = [];
  const readTools = { submitReport: collector.submit, requestUserInput: async () => '', approve: async (request: { toolName: string; input: unknown }) => { approvals.push(request.toolName); return decideApproval(request as never, { cwd: work, canWrite: false }); } };
  const reader = await runtime.startSession(base(readTools, 'read-only'));
  try {
    const events = await turn(reader, 'Read notes.txt. Then call submit_report once with exactly two fields: answer (the secret word in that file) and sources (a list containing "notes.txt"). Add no other fields.');
    check('read-only turn completes', end(events)?.status === 'completed', JSON.stringify(end(events)));
    check('usage events arrive', usageOf(events) > 0, `${usageOf(events)} tokens in ${events.filter(event => event.type === 'usage').length} event(s)`);
    check('messages are translated', events.some(event => event.type === 'message'), `${events.filter(event => event.type === 'message').length} message event(s)`);
    check('report accepted through MCP', collector.report !== null, collector.report ? JSON.stringify(collector.report).slice(0, 160) : `no report; invalid attempts ${collector.invalidAttempts}`);
    check('report content correct', JSON.stringify(collector.report ?? {}).toLowerCase().includes('pineapple'), 'answer mentions the secret word');
    check('read-only session cannot write', true, 'verified below by the workspace check');
    const second = await turn(reader, 'Reply with the single word OK. Do not call any tool.');
    check('second turn in the same session', end(second)?.status === 'completed', JSON.stringify(end(second)));
  } finally { await reader.close(); }
  check('read-only session left files untouched', fs.readdirSync(work).join(',') === 'notes.txt', fs.readdirSync(work).join(','));

  // 2. write session creates a file and runs a command; events and approvals are visible
  const builderCollector = new ReportCollector('builder');
  const writeTools = { submitReport: builderCollector.submit, requestUserInput: async () => '', approve: async (request: { toolName: string; input: unknown }) => { approvals.push(request.toolName); return decideApproval(request as never, { cwd: work, canWrite: true }); } };
  const writer = await runtime.startSession(base(writeTools, 'workspace-write'));
  try {
    const events = await turn(writer, 'Create a file hello.txt containing exactly "hi". Then run the command: node -e "console.log(1+1)" or, if that is not allowed, any harmless command that prints text. Finally call submit_report with exactly these fields and no others: summary (one sentence), changedFiles (["hello.txt"]), commandsRun (a list of {command, exitCode} for commands you ran), requirements ([]), unverified ([]).');
    check('write turn completes', end(events)?.status === 'completed', JSON.stringify(end(events)));
    check('file was created', fs.existsSync(path.join(work, 'hello.txt')) && fs.readFileSync(path.join(work, 'hello.txt'), 'utf8').trim() === 'hi', fs.existsSync(path.join(work, 'hello.txt')) ? 'content differs' : 'missing');
    check('file_change event seen', events.some(event => event.type === 'file_change'), `${events.filter(event => event.type === 'file_change').length} event(s)`);
    check('command event seen', events.some(event => event.type === 'command'), JSON.stringify(events.filter(event => event.type === 'command').slice(0, 2)));
    console.log(`  approvals asked: ${approvals.join(', ') || 'none'}`);
    check('builder report accepted', builderCollector.report !== null, builderCollector.report ? 'yes' : `no; invalid attempts ${builderCollector.invalidAttempts}`);
  } finally { await writer.close(); }

  // 3. abort interrupts a long turn
  const hanger = await runtime.startSession(base({ submitReport: async () => ({ ok: true, message: '' }), requestUserInput: async () => '' }, 'read-only'));
  try {
    const controller = new AbortController();
    setTimeout(() => { controller.abort(); }, 6000);
    const started = Date.now();
    const events = await turn(hanger, 'Count slowly from 1 to 500, one number per line, with a one-sentence comment on each.', controller.signal);
    check('abort interrupts the turn', end(events)?.status === 'interrupted', `${JSON.stringify(end(events))} after ${Date.now() - started} ms`);
  } finally { await hanger.close(); }
} catch (error) {
  check('smoke run', false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await runtime.close();
}

const out = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'results');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, `${kind}.json`), JSON.stringify({ runtime: kind, at: new Date().toISOString(), platform: process.platform, node: process.version, ok: results.every(item => item.ok), results, transcript }, null, 2));
console.log(`\n${results.every(item => item.ok) ? 'All checks passed.' : 'Some checks FAILED.'} Details: scripts/smoke/results/${kind}.json (send it back for review)`);
process.exit(results.every(item => item.ok) ? 0 : 1);
