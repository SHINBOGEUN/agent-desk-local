// team/ notes: a read-only mirror of the role files and skills inside the vault, so Obsidian's graph (and the
// dashboard's) shows which role uses which skill and in which runs a skill was really read. The originals stay
// in .agent-desk/agents and .agent-desk/skills; these notes are rewritten from them and say so at the top.
// Only notes marked `generated: true` are ever rewritten or removed.

import fs from 'node:fs';
import path from 'node:path';
import { planRuntimes, ROLE_NAMES } from './config.ts';
import type { LoadedProject } from './index.ts';
import { checkSkills } from './skills.ts';
import { listNotes, safeNotePath } from './vault.ts';

type Lang = 'en' | 'ko';

/** How often each skill was read in recent runs (from the run store), newest first. */
export type SkillUsage = Record<string, { runs: { id: number; note: string | null }[] }>;

export const TEAM_ROLE = (role: string): string => `team/roles/${role}`;
export const TEAM_SKILL = (id: string): string => `team/skills/${id}`;

const alias = (target: string, label: string): string => `[[${target}|${label}]]`;

function writeIfChanged(root: string, rel: string, text: string): boolean {
  const safe = safeNotePath(root, rel);
  if (!safe.ok) return false;
  try { if (fs.readFileSync(safe.abs, 'utf8') === text) return false; } catch { /* new note */ }
  fs.mkdirSync(path.dirname(safe.abs), { recursive: true });
  fs.writeFileSync(safe.abs, text);
  return true;
}

export interface TeamSyncResult { written: string[]; removed: string[] }

/** Rewrites team/roles/*.md and team/skills/*.md from the project's role files and skills. */
export function syncTeamNotes(project: string, root: string, loaded: LoadedProject, options: { usage?: SkillUsage; lang?: Lang } = {}): TeamSyncResult {
  const ko = options.lang === 'ko';
  const say = (en: string, kr: string): string => (ko ? kr : en);
  const result: TeamSyncResult = { written: [], removed: [] };
  const skills = checkSkills(project, loaded.config, loaded.roles).skills;
  const assignment = planRuntimes(loaded.config).assignment;
  const usersOf = (id: string): string[] => ROLE_NAMES.filter(role => loaded.roles[role].skills.includes(id));
  const keep = new Set<string>();

  for (const role of ROLE_NAMES) {
    const definition = loaded.roles[role];
    const rel = `${TEAM_ROLE(role)}.md`;
    keep.add(rel);
    const source = definition.file ? path.relative(project, definition.file).split(path.sep).join('/') : null;
    const models = [definition.model ? `model: ${definition.model}` : '', definition.modelByRuntime?.codex ? `model-codex: ${definition.modelByRuntime.codex}` : '', definition.modelByRuntime?.claude ? `model-claude: ${definition.modelByRuntime.claude}` : ''].filter(Boolean);
    const text = [
      '---', 'type: role', 'generated: true', `role: ${role}`, `runtime: ${assignment[role]}`,
      ...(definition.access ? [`access: ${definition.access}`] : []), ...(definition.effort ? [`effort: ${definition.effort}`] : []), ...models,
      ...(source ? [`source: ${source}`] : []), '---',
      `# ${role}`, '',
      `> ${say('Generated from the role file; edit it in the dashboard settings (Roles), not here.', '역할 파일에서 자동으로 만든 노트입니다. 수정은 여기가 아니라 대시보드 설정의 역할 탭에서 하세요.')}`, '',
      ...(definition.description ? [definition.description, ''] : []),
      `- ${say('Runtime', '런타임')}: ${assignment[role]}`,
      ...(definition.effort ? [`- ${say('Effort', '추론 강도')}: ${definition.effort}`] : []),
      ...(models.length ? [`- ${say('Model', '모델')}: ${models.map(entry => entry.split(': ')[1]).join(', ')}`] : []),
      `- ${say('Role file', '역할 파일')}: ${source ? `\`${source}\`` : say('none (built-in defaults)', '없음 (기본값 사용)')}`, '',
      `## ${say('Skills', '스킬')}`, '',
      ...(definition.skills.length ? definition.skills.map(id => `- ${alias(TEAM_SKILL(id), id)}`) : [`- ${say('none', '없음')}`]), '',
    ].join('\n');
    if (writeIfChanged(root, rel, text)) result.written.push(rel);
  }

  for (const skill of skills) {
    const rel = `${TEAM_SKILL(skill.id)}.md`;
    keep.add(rel);
    const users = usersOf(skill.id);
    const runs = options.usage?.[skill.id]?.runs ?? [];
    const text = [
      '---', 'type: skill', 'generated: true', `skill: ${skill.id}`, `reads: ${runs.length}`, ...(runs[0] ? [`last-run: ${runs[0].id}`] : []), `source: ${skill.path}`, '---',
      `# ${skill.id}`, '',
      `> ${say('Generated from the skill; edit it in the dashboard settings (Skills), not here.', '스킬에서 자동으로 만든 노트입니다. 수정은 여기가 아니라 대시보드 설정의 스킬 탭에서 하세요.')}`, '',
      skill.description, '',
      `- ${say('Skill file', '스킬 파일')}: \`${skill.path}\``,
      `- ${say('Used by', '쓰는 역할')}: ${users.length ? users.map(role => alias(TEAM_ROLE(role), role)).join(', ') : say('no role (it is never offered)', '없음 (어느 역할에도 주어지지 않음)')}`,
      `- ${say('Read in recent runs', '최근 실행에서 읽힌 횟수')}: ${runs.length}${runs[0] ? ` (${say('last', '마지막')} #${runs[0].id})` : ''}`, '',
      ...(runs.length ? [`## ${say('Runs that read it', '이 스킬을 읽은 실행')}`, '', ...runs.slice(0, 10).map(run => `- ${run.note ? `[[${run.note}|#${run.id}]]` : `#${run.id}`}`), ''] : []),
    ].join('\n');
    if (writeIfChanged(root, rel, text)) result.written.push(rel);
  }

  // A skill or role that no longer exists: its generated note goes, user notes in team/ stay.
  for (const note of listNotes(root).filter(entry => entry.folder === 'team' && !keep.has(entry.path))) {
    if (String(note.frontmatter.generated) !== 'true') continue;
    const safe = safeNotePath(root, note.path);
    if (safe.ok) { try { fs.unlinkSync(safe.abs); result.removed.push(note.path); } catch { /* in use: next time */ } }
  }
  return result;
}
