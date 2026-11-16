// `agent-desk init`: looks at a project and drafts .agent-desk/ files. It only
// reads the project; writing happens in writeDraft, which never overwrites an
// existing file and is called only after the user confirmed.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { RoleId } from '#core';
import { ROLE_NAMES, configPath } from './config.ts';
import type { ProjectConfig, RuntimeKind } from './config.ts';
import { roleFilePath, roleTemplate } from './roles.ts';

export interface VerifyCandidate {
  command: string;
  source: string;
}

export interface ProjectInspection {
  project: string;
  /** Short labels such as "Node.js", "TypeScript", "React". */
  stack: string[];
  verifyCandidates: VerifyCandidate[];
  /** Instruction and agent files already in the project, relative paths. */
  existingAgentFiles: string[];
  hasTests: boolean;
  hasCi: boolean;
  gitCommits: number | null;
  existingConfig: boolean;
  existingRoleFiles: RoleId[];
  /** AGENTS.md and CLAUDE.md both exist but say different things. */
  instructionFilesDiffer: boolean;
  notes: string[];
}

const exists = (project: string, rel: string): boolean => fs.existsSync(path.join(project, rel));
const readJson = (file: string): Record<string, unknown> | null => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { return null; } };
const norm = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();

export function inspectProject(project: string): ProjectInspection {
  const stack: string[] = [];
  const verifyCandidates: VerifyCandidate[] = [];
  const notes: string[] = [];
  const pkg = readJson(path.join(project, 'package.json'));
  if (pkg) {
    stack.push('Node.js');
    const deps = { ...(pkg.dependencies as Record<string, string> | undefined), ...(pkg.devDependencies as Record<string, string> | undefined) };
    for (const [name, label] of [['typescript', 'TypeScript'], ['react', 'React'], ['next', 'Next.js'], ['express', 'Express'], ['vue', 'Vue'], ['vite', 'Vite'], ['@supabase/supabase-js', 'Supabase']] as const) if (deps[name]) stack.push(label);
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    for (const name of ['test', 'typecheck', 'lint', 'build']) if (scripts[name]) verifyCandidates.push({ command: name === 'test' ? 'npm test' : `npm run ${name}`, source: `package.json scripts.${name}` });
    if (scripts.test && /no test specified/.test(scripts.test)) { verifyCandidates.shift(); notes.push('package.json has the default placeholder test script; it checks nothing.'); }
  }
  if (exists(project, 'pyproject.toml') || exists(project, 'requirements.txt')) { stack.push('Python'); if (exists(project, 'pytest.ini') || exists(project, 'tests') || exists(project, 'test')) verifyCandidates.push({ command: 'pytest', source: 'tests folder' }); }
  if (!stack.includes('Python')) {
    const testsDir = path.join(project, 'tests');
    const unittestFiles = fs.existsSync(testsDir) ? fs.readdirSync(testsDir).filter(name => /^test.*\.py$/.test(name)) : [];
    if (exists(project, 'setup.py') || unittestFiles.length) {
      stack.push('Python');
      if (unittestFiles.length) verifyCandidates.push({ command: 'python -m unittest discover -s tests', source: 'tests/test_*.py' });
    }
  }
  if (exists(project, 'index.html')) stack.push('Web');
  if (exists(project, 'Cargo.toml')) { stack.push('Rust'); verifyCandidates.push({ command: 'cargo test', source: 'Cargo.toml' }); }
  if (exists(project, 'go.mod')) { stack.push('Go'); verifyCandidates.push({ command: 'go test ./...', source: 'go.mod' }); }
  if (exists(project, 'pom.xml')) { stack.push('Java'); verifyCandidates.push({ command: 'mvn -q test', source: 'pom.xml' }); }
  if (exists(project, 'Makefile') && /^test:/m.test(fs.readFileSync(path.join(project, 'Makefile'), 'utf8'))) verifyCandidates.push({ command: 'make test', source: 'Makefile test target' });

  const agentCandidates = ['AGENTS.md', 'CLAUDE.md', '.claude', '.agents', '.codex', '.cursorrules', '.github/copilot-instructions.md'];
  const existingAgentFiles = agentCandidates.filter(rel => exists(project, rel));
  const hasTests = ['test', 'tests', '__tests__', 'spec'].some(dir => exists(project, dir)) || verifyCandidates.some(candidate => /test/.test(candidate.command));
  const hasCi = exists(project, '.github/workflows') || exists(project, '.gitlab-ci.yml') || exists(project, '.circleci');

  let gitCommits: number | null = null;
  if (exists(project, '.git')) {
    try { gitCommits = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim()); } catch { gitCommits = null; }
  } else notes.push('Not a git repository: changes cannot be compared with history, and restore points are plain file copies.');

  let instructionFilesDiffer = false;
  if (exists(project, 'AGENTS.md') && exists(project, 'CLAUDE.md')) {
    const a = norm(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8'));
    const c = norm(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8'));
    instructionFilesDiffer = a !== c && !c.includes('@AGENTS.md');
  }
  return {
    project, stack, verifyCandidates, existingAgentFiles, hasTests, hasCi, gitCommits,
    existingConfig: fs.existsSync(configPath(project)),
    existingRoleFiles: ROLE_NAMES.filter(role => fs.existsSync(roleFilePath(project, role))),
    instructionFilesDiffer, notes,
  };
}

export interface DraftFile {
  /** Path relative to the project. */
  path: string;
  content: string;
  /** False when the file already exists and will be left alone. */
  willWrite: boolean;
  reason: string;
}

export interface Draft {
  config: ProjectConfig;
  files: DraftFile[];
  /** Why the draft looks the way it does, one line each. */
  rationale: string[];
}

/** Drafts config and role files. `available` lists the runtimes found on this PC. */
export function draftFromInspection(inspection: ProjectInspection, available: readonly RuntimeKind[]): Draft {
  const rationale: string[] = [];
  const config: ProjectConfig = {};
  const mode = available.includes('codex') && available.includes('claude') ? 'codex+claude' : available.includes('claude') && !available.includes('codex') ? 'claude' : 'codex';
  config.mode = mode;
  rationale.push(`mode = ${mode}${available.length ? ` (found on this PC: ${available.join(', ')})` : ' (no runtime found yet; run "agent-desk doctor")'}.${mode === 'codex+claude' ? ' Codex builds and Claude reviews, so the reviewer does not share the builder\'s blind spots.' : ''}`);

  const usable = inspection.verifyCandidates.filter(candidate => candidate.command !== 'npm run build' || inspection.verifyCandidates.length === 1);
  const verify = usable.filter(candidate => /test|typecheck/.test(candidate.command) || candidate.command === 'pytest' || /cargo test|go test|mvn|make test/.test(candidate.command)).map(candidate => candidate.command);
  if (verify.length) { config.verify = verify; rationale.push(`verify = ${verify.join(', ')} (from ${usable.filter(candidate => verify.includes(candidate.command)).map(candidate => candidate.source).join(', ')}). Check that these are fast and need no setup.`); }
  else rationale.push('No test command found. Without verify commands every build ends as needs_review; add one when you have it.');

  if (!inspection.hasTests) { config.review = 'always'; rationale.push('review = always: the project has no tests, so an independent review is the only check besides the builder\'s own report.'); }
  else if (inspection.hasCi || (inspection.gitCommits ?? 0) > 50) { config.review = 'auto'; rationale.push('review = auto: tests exist and the project is established (CI or many commits), so small, verified changes can skip the review. Compare with "always" in the benchmark before relying on it.'); }
  else rationale.push('review left at the default (always).');
  if (inspection.instructionFilesDiffer) rationale.push('AGENTS.md and CLAUDE.md differ: Codex and Claude would follow different rules. Align them (for example CLAUDE.md containing "@AGENTS.md").');
  if (inspection.existingAgentFiles.length) rationale.push(`Existing agent files kept as they are: ${inspection.existingAgentFiles.join(', ')}.`);

  const files: DraftFile[] = [];
  files.push(inspection.existingConfig
    ? { path: '.agent-desk/config.json', content: '', willWrite: false, reason: 'already exists; not overwritten' }
    : { path: '.agent-desk/config.json', content: `${JSON.stringify(config, null, 2)}\n`, willWrite: true, reason: 'new project settings' });
  const skills = skillDrafts(inspection, config.verify ?? []);
  const skillOf: Partial<Record<RoleId, string[]>> = {};
  for (const skill of skills) {
    const target = `.agent-desk/skills/${skill.id}/SKILL.md`;
    const has = exists(inspection.project, target);
    files.push({ path: target, content: has ? '' : skill.content, willWrite: !has, reason: has ? 'already exists; not overwritten' : `skill draft for the ${skill.role}: ${skill.why}` });
    (skillOf[skill.role] ??= []).push(skill.id);
  }
  if (skills.length) rationale.push(`Skill drafts: ${skills.map(skill => `${skill.id} (${skill.role})`).join(', ')}. Edit them to match how this project really works; "agent-desk skills check" checks their structure.`);
  for (const role of ROLE_NAMES) {
    const has = inspection.existingRoleFiles.includes(role);
    files.push({ path: `.agent-desk/agents/${role}.md`, content: has ? '' : roleTemplate(role, skillOf[role] ?? []), willWrite: !has, reason: has ? 'already exists; not overwritten' : 'role definition with the default access and effort' });
  }
  return { config, files, rationale };
}

export interface SkillDraft { id: string; role: RoleId; why: string; content: string }

/**
 * Starter skills for a project, written the way the skill checks expect: the
 * description says what it does, when to use it and when not to; the body
 * gives the reason before the steps.
 */
export function skillDrafts(inspection: ProjectInspection, verify: string[]): SkillDraft[] {
  const drafts: SkillDraft[] = [];
  if (verify.length) {
    const list = verify.map(command => `\`${command}\``).join(', ');
    drafts.push({ id: 'verify-before-report', role: 'builder', why: 'run the project checks before reporting', content: `---
name: verify-before-report
description: Runs this project's checks (${verify.join(', ')}) and reads every failure before you submit a builder report. Use when you changed files and are about to report the work as done. Do not use for questions or investigations that change no files.
---

# Verify before you report

Why: the harness runs the same commands after you report (gate G3). A failure found there costs a whole REDO round, and a report that says "done" while checks fail is treated as untrue.

1. Run ${list} from the project folder.
2. If one fails, read the first failure and fix its cause in the code. Change a test only when the requirements make the old expectation wrong, and say so in the summary.
3. Run the commands again until they pass.
4. List each command and its exit code in "commandsRun".
5. If a command cannot run here (missing tool, needs network or a database), put that in "unverified" instead of reporting the requirement as done.
` });
  }
  const stack = inspection.stack.join(', ') || 'this project';
  const specifics: string[] = [];
  if (inspection.stack.includes('Node.js')) specifics.push('- package.json: scripts and dependencies change only when the request asks for it.');
  if (inspection.stack.includes('Python')) specifics.push('- Python: no new third-party packages unless the request asks; the standard library is preferred.');
  if (inspection.stack.some(item => /React|Vue|HTML|Web/i.test(item))) specifics.push('- UI: text that comes from users is escaped before it is put into HTML.');
  drafts.push({ id: 'review-checklist', role: 'verifier', why: 'check the change against this project\'s risk points', content: `---
name: review-checklist
description: Checks a change in ${stack} against the points that most often go wrong here (weakened tests, security-sensitive files, unrequested changes) before you give a verdict. Use when you review a builder's change in this project. Do not use for style-only remarks or when nothing was changed.
---

# Review checklist

Why: a reviewer who only reads the diff tends to approve what looks tidy. These points are where a change can look fine and still be wrong.

- Every requirement has evidence in the code or in a check that ran, not only in the builder's words.
- Changed tests: is each change required by the request, or does it remove or loosen a check? A loosened check is a blocking finding.
- Files about auth, tokens, sessions or secrets: is anything exposed or skipped?
- Changes nobody asked for (renames, reformatting, new dependencies) are noted in "optional", or blocking if they break something.
${specifics.join('\n')}
` });
  return drafts;
}

/** Writes the files marked willWrite. Existing files are never replaced. */
export function writeDraft(project: string, draft: Draft): string[] {
  const written: string[] = [];
  for (const file of draft.files) {
    if (!file.willWrite) continue;
    const target = path.join(project, ...file.path.split('/'));
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
    written.push(file.path);
  }
  return written;
}
