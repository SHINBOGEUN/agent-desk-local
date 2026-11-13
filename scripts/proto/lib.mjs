// Shared helpers for the phase-1 prototypes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const protoDirectory = path.dirname(fileURLToPath(import.meta.url));
export const mcpServerPath = path.join(protoDirectory, 'mini-mcp-server.mjs');

export function makeWorkspace(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `agent-desk-${prefix}-`));
  fs.writeFileSync(path.join(directory, 'README.md'), '# Prototype workspace\n\nThis folder is a scratch workspace for an Agent Desk prototype.\n');
  spawnSync('git', ['init', '-q'], { cwd: directory, windowsHide: true });
  return directory;
}

export function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function waitFor(predicate, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return true; await sleep(intervalMs); }
  return false;
}

export class Checks {
  constructor(name) { this.name = name; this.items = []; }
  add(id, ok, detail) { this.items.push({ id, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`); }
  finish(outputFile, extra = {}) {
    const result = { prototype: this.name, at: new Date().toISOString(), platform: process.platform, node: process.version, ok: this.items.every(item => item.ok), checks: this.items, ...extra };
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));
    console.log(`\n${result.ok ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'} -> ${outputFile}`);
    process.exitCode = result.ok ? 0 : 1;
    return result;
  }
}
