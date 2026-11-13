// PC-specific data (database, discovered executables) lives in the Agent Desk
// data folder, never inside a project, so it is not committed by accident.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function dataDirectory(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  if (env.AGENT_DESK_HOME) return env.AGENT_DESK_HOME;
  if (platform === 'win32') return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'agent-desk');
  return path.join(env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'agent-desk');
}

export interface MachineSettings {
  codex?: { path: string; version?: string; checkedAt: string };
  claude?: { path: string; version?: string; checkedAt: string };
}

export function readMachineSettings(dir: string): MachineSettings {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'machine.json'), 'utf8')) as MachineSettings; } catch { return {}; }
}

export function writeMachineSettings(dir: string, settings: MachineSettings): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'machine.json'), `${JSON.stringify(settings, null, 2)}\n`);
}
