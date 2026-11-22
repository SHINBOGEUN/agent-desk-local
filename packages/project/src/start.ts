// "Start" for a project opened for the first time: is it a new (empty) folder or existing code, and what the harness
// can tell about it without a model call (stack, verify commands, tests, git state). Also the two things the start
// card writes: the verify commands into config.json, and the overview note a new project begins from.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { configPath, loadProjectConfig } from './config.ts';
import { saveProjectFile } from './edit.ts';
import { inspectProject } from './init.ts';
import type { VerifyCandidate } from './init.ts';

export interface ProjectStart {
  /** "new": nothing but harness folders; "existing": there is code or content. */
  kind: 'new' | 'existing';
  /** Top-level entries, not counting .agent-desk, .git and other dot folders. */
  entries: number;
  stack: string[];
  verifyCandidates: VerifyCandidate[];
  /** Verify commands already in config.json. */
  verify: string[];
  hasTests: boolean;
  git: { repo: boolean; commits: number | null; uncommitted: number | null };
}

export function projectStart(project: string): ProjectStart {
  const entries = fs.readdirSync(project, { withFileTypes: true }).filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules').length;
  const inspection = inspectProject(project);
  const config = loadProjectConfig(project);
  const repo = fs.existsSync(path.join(project, '.git'));
  let uncommitted: number | null = null;
  if (repo) {
    try {
      const out = execFileSync('git', ['status', '--porcelain'], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
      // the harness's own folder is not the user's work
      uncommitted = out.split('\n').filter(line => line.trim() && !/\s\.agent-desk\//.test(line)).length;
    } catch { uncommitted = null; }
  }
  return {
    kind: entries === 0 ? 'new' : 'existing',
    entries,
    stack: inspection.stack,
    verifyCandidates: inspection.verifyCandidates,
    verify: config.ok ? config.config.verify ?? [] : [],
    hasTests: inspection.hasTests,
    git: { repo, commits: inspection.gitCommits, uncommitted },
  };
}

/** Sets the verify commands in .agent-desk/config.json, keeping every other key. */
export function setVerifyCommands(project: string, commands: readonly string[]): { ok: true } | { ok: false; errors: string[] } {
  const file = configPath(project);
  let current: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try { current = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { return { ok: false, errors: ['config.json is not valid JSON; fix it in the settings first'] }; }
  }
  const clean = commands.map(command => command.trim()).filter(Boolean);
  const next = { ...current, verify: clean };
  if (!clean.length) delete (next as Record<string, unknown>).verify;
  const saved = saveProjectFile(project, { kind: 'config', text: `${JSON.stringify(next, null, 2)}\n` });
  return saved.ok ? { ok: true } : { ok: false, errors: saved.errors };
}

export interface Overview { goal: string; stack: string; rules: string[] }

/** The overview note a new project starts from; requirements can quote it (Requirement.source). */
export function overviewNote(overview: Overview, lang: 'en' | 'ko', today: string): { path: string; text: string } {
  const ko = lang === 'ko';
  const stack = overview.stack.trim() || (ko ? '아직 정하지 않음. 첫 요청에서 목표에 맞는 기술을 제안받는다.' : 'Not chosen yet. The first request asks for a proposal that fits the goal.');
  const rules = overview.rules.map(rule => rule.trim()).filter(Boolean);
  const text = [
    '---', 'type: spec', `created: ${today}`, '---',
    `# ${ko ? '프로젝트 개요' : 'Project overview'}`, '',
    `## ${ko ? '만들 것' : 'What to build'}`, overview.goal.trim(), '',
    `## ${ko ? '기술' : 'Technology'}`, stack, '',
    `## ${ko ? '지킬 규칙' : 'Rules'}`, ...(rules.length ? rules.map(rule => `- ${rule}`) : [ko ? '- (없음)' : '- (none)']), '',
  ].join('\n');
  return { path: ko ? 'specs/프로젝트 개요.md' : 'specs/Project overview.md', text };
}
