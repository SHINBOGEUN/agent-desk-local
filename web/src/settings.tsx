// Project settings overlay: the team (config.json), the four role files and the
// skills, edited as the files themselves. The server checks every save with the
// harness's own rules and writes nothing that fails.

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api.ts';
import type { ProjectFiles } from './api.ts';
import { useI18n } from './i18n.ts';
import type { Key } from './i18n.ts';
import { asList, projectName, readFrontmatter } from './model.ts';
import { errorText } from './util.ts';

const ROLES = ['lead', 'builder', 'verifier', 'researcher'] as const;
type Tab = 'config' | 'roles' | 'skills';
type Status = { kind: 'ok' | 'warn' | 'error'; lines: string[] } | null;

function Editor({ label, file, initial, exists, busy, onSave, extra }: { label: string; file: string; initial: string; exists: boolean; busy: boolean; onSave: (text: string) => Promise<Status>; extra?: React.ReactNode }) {
  const { t } = useI18n();
  const [text, setText] = useState(initial);
  const [status, setStatus] = useState<Status>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setText(initial); setStatus(null); }, [initial]);
  const dirty = text !== initial;
  const save = async (): Promise<void> => { setSaving(true); try { setStatus(await onSave(text)); } finally { setSaving(false); } };
  return (
    <div className="editor">
      <div className="editor-head">
        <strong>{label}</strong>
        <span className="mono editor-file">{file}</span>
        {dirty ? <span className="badge tone-warning">{t('unsaved')}</span> : null}
        {extra}
        <button className="send push" disabled={busy || saving || (!dirty && exists)} onClick={() => { void save(); }}>{t('save')}</button>
      </div>
      {!exists ? <p className="editor-note">{t('notCreated')}</p> : null}
      <textarea className="mono editor-text" spellCheck={false} value={text} onChange={event => setText(event.target.value)} aria-label={file} />
      <p className="editor-note">{t('fileHint', { file })}</p>
      {status ? (
        <div className={`editor-status ${status.kind}`} role="status">
          <strong>{status.kind === 'error' ? t('saveFailed') : status.kind === 'warn' ? t('savedWarnings') : t('saved')}</strong>
          {status.lines.length ? <ul>{status.lines.map((line, index) => <li key={index}>{line}</li>)}</ul> : null}
        </div>
      ) : null}
    </div>
  );
}

function RoleSummary({ text, skills, runtime }: { text: string; skills: ProjectFiles['skills']; runtime: string | undefined }) {
  const { t } = useI18n();
  const { data } = readFrontmatter(text);
  const linked = asList(data.skills);
  const value = (key: string): string => (typeof data[key] === 'string' ? data[key] as string : t('defaultValue'));
  return (
    <div className="role-summary">
      {typeof data.description === 'string' ? <p>{data.description}</p> : null}
      <dl>
        <dt>{t('roleRuntime')}</dt><dd>{runtime ? <span className={`rt rt-${runtime}`}>{runtime === 'codex' ? 'Codex' : runtime === 'claude' ? 'Claude' : runtime}</span> : t('defaultValue')}</dd>
        <dt>{t('roleAccess')}</dt><dd>{value('access')}</dd>
        <dt>{t('roleEffort')}</dt><dd>{value('effort')}</dd>
        <dt>{t('roleModel')}</dt><dd>{[data['model-codex'] ? `Codex: ${String(data['model-codex'])}` : '', data['model-claude'] ? `Claude: ${String(data['model-claude'])}` : '', typeof data.model === 'string' ? data.model : ''].filter(Boolean).join(' · ') || t('defaultValue')}</dd>
        <dt>{t('roleSkills')}</dt>
        <dd>{linked.length ? <ul className="skill-refs">{linked.map(id => { const skill = skills.find(entry => entry.id === id); const description = skill ? readFrontmatter(skill.text).data.description : undefined; return <li key={id}><strong>{id}</strong>{typeof description === 'string' ? <span>{description}</span> : <span className="error">{t('skillMissing')}</span>}</li>; })}</ul> : t('noRoleSkills')}</dd>
      </dl>
    </div>
  );
}

export function SettingsPanel({ project, runtimes, busy, initialRole, initialSkill, onClose, onSaved }: { project: string; runtimes: Record<string, string> | null; busy: boolean; initialRole?: string | undefined; initialSkill?: string | undefined; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [files, setFiles] = useState<ProjectFiles | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>(initialSkill ? 'skills' : initialRole ? 'roles' : 'config');
  const [role, setRole] = useState<string>(initialRole ?? 'builder');
  const [skill, setSkill] = useState<string | null>(initialSkill ?? null);
  const [newId, setNewId] = useState('');
  const [draftNote, setDraftNote] = useState('');

  const load = useCallback(async (): Promise<void> => {
    try { const loaded = await api.files(project); setFiles(loaded); setError(''); setSkill(current => current ?? loaded.skills[0]?.id ?? null); } catch (caught) { setError(errorText(caught)); }
  }, [project]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [onClose]);

  const save = (kind: 'config' | 'role' | 'skill', id?: string) => async (text: string): Promise<Status> => {
    try {
      const reply = await api.saveFile({ project, kind, ...(id ? { id } : {}), text });
      await load(); onSaved();
      return reply.warnings?.length ? { kind: 'warn', lines: reply.warnings } : { kind: 'ok', lines: [] };
    } catch (caught) {
      return { kind: 'error', lines: caught instanceof ApiError && caught.details.length ? caught.details : [errorText(caught)] };
    }
  };
  const createSkill = async (): Promise<void> => {
    const id = newId.trim();
    const template = `---\nname: ${id}\ndescription: Checks ... when the user asks to .... Do not use for ....\n---\n\n# ${id}\n\nWhy: ...\n\n- ...\n`;
    const status = await save('skill', id)(template);
    if (status?.kind === 'error') setDraftNote(status.lines.join(' ')); else { setNewId(''); setDraftNote(''); setSkill(id); }
  };
  const removeSkill = async (id: string): Promise<void> => {
    if (!window.confirm(t('confirmDeleteSkill', { id }))) return;
    try { await api.saveFile({ project, kind: 'skill', id, remove: true }); setSkill(null); await load(); onSaved(); } catch (caught) { setDraftNote(caught instanceof ApiError && caught.details.length ? caught.details.join(' ') : errorText(caught)); }
  };
  const drafts = async (): Promise<void> => {
    try { const result = await api.initProject(project); setDraftNote(result.written.length ? t('draftsDone', { n: result.written.length }) : t('draftsNone')); await load(); onSaved(); } catch (caught) { setDraftNote(errorText(caught)); }
  };
  const missingRoles = files ? ROLES.filter(name => !files.roles[name]?.exists) : [];
  const current = files?.skills.find(entry => entry.id === skill) ?? null;

  return (
    <div className="overlay" onClick={onClose}>
      <section className="settings" role="dialog" aria-modal="true" aria-label={t('settingsTitle', { name: projectName(project) })} onClick={event => event.stopPropagation()}>
        <header className="settings-head">
          <h2>{t('settingsTitle', { name: projectName(project) })}</h2>
          <nav className="settings-tabs" role="tablist">
            {(['config', 'roles', 'skills'] as const).map(name => <button key={name} role="tab" aria-selected={tab === name} className={tab === name ? 'on' : ''} onClick={() => setTab(name)}>{t(name === 'config' ? 'tabConfig' : name === 'roles' ? 'tabRoles' : 'tabSkills')}</button>)}
          </nav>
          <button className="ghost push" onClick={onClose}>{t('close')}</button>
        </header>
        {busy ? <p className="editor-note warn">{t('busyProject')}</p> : null}
        {error ? <p className="error">{error}</p> : null}
        {files && (!files.config.exists || missingRoles.length) ? (
          <div className="drafts"><p>{t('draftsHint')}</p><button disabled={busy} onClick={() => { void drafts(); }}>{t('createDrafts')}</button>{draftNote ? <span className="editor-note">{draftNote}</span> : null}</div>
        ) : null}
        {!files ? null : tab === 'config' ? (
          <Editor label={t('tabConfig')} file=".agent-desk/config.json" initial={files.config.text} exists={files.config.exists} busy={busy} onSave={save('config')} />
        ) : tab === 'roles' ? (
          <div className="split">
            <nav className="split-list">{ROLES.map(name => <button key={name} className={role === name ? 'on' : ''} onClick={() => setRole(name)}><span className={`avatar avatar-${name}`} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>{name}{runtimes?.[name] ? <span className={`rt rt-${runtimes[name]}`}>{runtimes[name] === 'codex' ? 'Codex' : 'Claude'}</span> : null}</button>)}</nav>
            <div className="split-main">
              <RoleSummary text={files.roles[role]?.text ?? ''} skills={files.skills} runtime={runtimes?.[role]} />
              <Editor label={role} file={`.agent-desk/agents/${role}.md`} initial={files.roles[role]?.text ?? ''} exists={files.roles[role]?.exists ?? false} busy={busy} onSave={save('role', role)} />
            </div>
          </div>
        ) : (
          <div className="split">
            <nav className="split-list">
              {files.skills.map(entry => <button key={entry.id} className={skill === entry.id ? 'on' : ''} onClick={() => setSkill(entry.id)}>{entry.id}</button>)}
              {!files.skills.length ? <p className="editor-note">{t('noSkillsYet')}</p> : null}
              <div className="new-skill">
                <label>{t('skillIdLabel')}<input value={newId} onChange={event => setNewId(event.target.value.toLowerCase())} placeholder="api-rules" /></label>
                <button disabled={busy || !/^[a-z0-9][a-z0-9-]*$/.test(newId)} onClick={() => { void createSkill(); }}>{t('createSkill')}</button>
              </div>
              {draftNote && tab === 'skills' ? <p className="editor-note">{draftNote}</p> : null}
            </nav>
            <div className="split-main">
              {current ? (
                <>
                  {(() => { const description = readFrontmatter(current.text).data.description; return typeof description === 'string' ? <p className="trigger-note"><strong>{t('roleSkills')}</strong> {description}</p> : null; })()}
                  <Editor label={current.id} file={`.agent-desk/skills/${current.id}/SKILL.md`} initial={current.text} exists busy={busy} onSave={save('skill', current.id)}
                    extra={<button className="ghost danger" disabled={busy} onClick={() => { void removeSkill(current.id); }}>{t('deleteSkill')}</button>} />
                </>
              ) : null}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export const roleKey = (role: string): Key => `role_${role}` as Key;
