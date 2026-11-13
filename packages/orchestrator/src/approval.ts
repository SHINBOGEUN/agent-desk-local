// Approval broker for runtimes that ask the harness before using a tool
// (Claude's permission prompt tool). Policy decided with the user: file edits
// inside the project are allowed; shell commands are allowed only when they are
// reads, tests or builds that stay inside the project; everything else is
// denied with a message that says what is allowed. Nothing here asks the user,
// so unattended runs behave the same as interactive ones.

import path from 'node:path';
import type { ApprovalDecision, ApprovalRequest } from '#core';
import { isProtectedPath } from './snapshot.ts';

export interface ApprovalPolicy {
  /** Project folder; every path must stay inside it. */
  cwd: string;
  /** False for read-only roles: edits and mutating commands are denied. */
  canWrite: boolean;
  /** Extra command prefixes the project allows, for example "make test". */
  allowCommands?: readonly string[];
}

const deny = (message: string): ApprovalDecision => ({ behavior: 'deny', message });
const allow = (input: unknown): ApprovalDecision => ({ behavior: 'allow', updatedInput: input });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function insideProject(cwd: string, target: string): boolean {
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, target.replace(/^~(?=[/\\])/, '/__home__'));
  if (/^~/.test(target) || target.startsWith('$') || target.includes('%')) return false;
  return resolved === root || resolved.startsWith(root + path.sep);
}

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const REPO_STATE_GIT = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'blame', 'describe']);
const READ_COMMANDS = new Set(['ls', 'dir', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'pwd', 'echo', 'sort', 'uniq', 'diff', 'tree', 'type', 'which', 'where', 'stat', 'file', 'cd', 'true', 'node', 'tsc', 'pytest', 'jest', 'vitest', 'mocha']);
const WRITE_COMMANDS = new Set(['mkdir', 'touch', 'cp', 'mv']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PACKAGE_SCRIPTS = new Set(['test', 'run', 'build', 'lint', 'typecheck', 'check', 'ci']);
const NEVER = new Set(['rm', 'rmdir', 'del', 'rd', 'curl', 'wget', 'ssh', 'scp', 'sudo', 'chmod', 'chown', 'kill', 'taskkill', 'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'eval', 'format', 'shutdown']);

/** Splits a command line into words, honouring simple quotes. Returns null for syntax the policy does not try to understand. */
function words(segment: string): string[] | null {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(segment))) out.push(match[1] ?? match[2] ?? match[3] ?? '');
  return out;
}

function segmentProblem(segment: string, policy: ApprovalPolicy): string | null {
  const parts = words(segment.trim());
  if (!parts || parts.length === 0) return null;
  const [command = '', ...args] = parts;
  const name = path.basename(command).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  const line = parts.join(' ');
  for (const prefix of policy.allowCommands ?? []) if (line === prefix || line.startsWith(`${prefix} `)) return null;
  if (NEVER.has(name)) return `"${name}" is not allowed (deletion, network, privilege and shell-launching commands are denied)`;
  const pathArgs = args.filter(arg => !arg.startsWith('-') && /[\\/]|^\.\./.test(arg));
  const outside = pathArgs.find(arg => !insideProject(policy.cwd, arg));
  if (outside) return `"${outside}" is outside the project folder`;
  if (name === 'git') {
    const sub = args.find(arg => !arg.startsWith('-')) ?? '';
    return REPO_STATE_GIT.has(sub) ? null : `git ${sub || ''} is not allowed; only read-only git commands (${[...REPO_STATE_GIT].join(', ')}) are`;
  }
  if (PACKAGE_MANAGERS.has(name)) {
    const sub = args.find(arg => !arg.startsWith('-')) ?? '';
    if (!PACKAGE_SCRIPTS.has(sub)) return `${name} ${sub} is not allowed; only ${[...PACKAGE_SCRIPTS].join(', ')} scripts are (no installs)`;
    return null;
  }
  if (name === 'find' && args.some(arg => ['-exec', '-execdir', '-delete', '-ok'].includes(arg))) return 'find with -exec or -delete is not allowed';
  if (name === 'node' && args.some(arg => arg === '-e' || arg === '--eval' || arg === '-p')) return 'node -e is not allowed; put the code in a file inside the project';
  if (WRITE_COMMANDS.has(name)) return policy.canWrite ? null : `${name} changes files, which this role may not do`;
  if (READ_COMMANDS.has(name)) return null;
  return `"${name}" is not on the allowed command list. Allowed: file reads, tests/builds via npm|pnpm|yarn|bun scripts, node <file>, read-only git, mkdir/cp/mv/touch inside the project`;
}

export function checkCommand(command: string, policy: ApprovalPolicy): string | null {
  if (/[`]|\$\(|<\(|>\(|\n/.test(command)) return 'command substitution and multi-line commands are not allowed';
  if (/(^|[^>&0-9])>{1,2}\s*\S/.test(command) || /\d>/.test(command)) {
    const target = /(?:>{1,2})\s*([^\s&|;]+)/.exec(command)?.[1];
    if (!policy.canWrite) return 'output redirection changes files, which this role may not do';
    if (target && target !== '/dev/null' && target.toLowerCase() !== 'nul' && !insideProject(policy.cwd, target)) return `redirecting to "${target}" leaves the project folder`;
    if (target && isProtectedPath(path.relative(path.resolve(policy.cwd), path.resolve(policy.cwd, target)).split(path.sep).join('/'))) return 'that path is protected';
  }
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const problem = segmentProblem(segment.replace(/\d?>>?\s*\S+/g, ''), policy);
    if (problem) return problem;
  }
  return null;
}

export function decideApproval(request: ApprovalRequest, policy: ApprovalPolicy): ApprovalDecision {
  const tool = request.toolName;
  const input = isRecord(request.input) ? request.input : {};
  if (tool.startsWith('mcp__agentdesk__')) return allow(request.input);
  if (READ_TOOLS.has(tool)) {
    const target = [input.file_path, input.path, input.notebook_path].find((value): value is string => typeof value === 'string');
    return target && !insideProject(policy.cwd, target) ? deny(`${tool} may only read inside the project folder (${target} is outside)`) : allow(request.input);
  }
  if (WRITE_TOOLS.has(tool)) {
    if (!policy.canWrite) return deny('This role is read-only and may not change files.');
    const target = [input.file_path, input.notebook_path, input.path].find((value): value is string => typeof value === 'string');
    if (!target) return deny(`${tool} needs a file path.`);
    if (!insideProject(policy.cwd, target)) return deny(`${target} is outside the project folder.`);
    const rel = path.relative(path.resolve(policy.cwd), path.resolve(policy.cwd, target)).split(path.sep).join('/');
    return isProtectedPath(rel) ? deny(`${rel} is protected; the harness manages it.`) : allow(request.input);
  }
  if (tool === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (!command.trim()) return deny('Bash needs a command.');
    const problem = checkCommand(command, policy);
    return problem ? deny(`Denied: ${problem}.`) : allow(request.input);
  }
  return deny(`${tool} is not available in Agent Desk sessions.`);
}
