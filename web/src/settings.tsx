// Project settings overlay: the team (config.json), the four role files and the
// skills, edited as the files themselves. The server checks every save with the
// harness's own rules and writes nothing that fails.

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api.ts';
import type { ModelChoice, ModelChoices, ProjectFiles } from './api.ts';
import { useI18n } from './i18n.ts';
import type { Key } from './i18n.ts';
import { asList, memoryChars, projectName, readFrontmatter, setFrontmatterValue } from './model.ts';
import { errorText } from './util.ts';

const ROLES = ['lead', 'builder', 'verifier', 'researcher'] as const;
type Tab = 'config' | 'roles' | 'skills' | 'memory';
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

function ModelSelect({ value, choices, fallback, busy, onPick, label }: { value: string; choices: ModelChoice[]; fallback: string; busy: boolean; onPick: (value: string | null) => void; label: string }) {
  const { t } = useI18n();
  const ids = choices.map(choice => choice.id);
  return (
    <select aria-label={label} value={value} disabled={busy} onChange={event => onPick(event.target.value || null)}>
      <option value="">{fallback}</option>
      {value && !ids.includes(value) ? <option value={value}>{t('currentValue', { value })}</option> : null}
      {choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label !== choice.id ? `${choice.label} (${choice.id})` : choice.id}</option>)}
    </select>
  );
}

const EFFORTS = ['low', 'medium', 'high'];

function RoleSummary({ text, skills, runtime, models, busy, onSet }: { text: string; skills: ProjectFiles['skills']; runtime: string | undefined; models: ModelChoices | null; busy: boolean; onSet: (key: string, value: string | null) => Promise<Status> }) {
  const { t } = useI18n();
  const [note, setNote] = useState<Status>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setNote(null); }, [text]);
  const { data } = readFrontmatter(text);
  const linked = asList(data.skills);
  const value = (key: string): string => (typeof data[key] === 'string' ? data[key] as string : '');
  const set = async (key: string, next: string | null): Promise<void> => { setSaving(true); try { setNote(await onSet(key, next)); } finally { setSaving(false); } };
  const fallback = (name: string | null | undefined): string => (name ? t('defaultModel', { name }) : t('defaultModelUnknown'));
  const disabled = busy || saving;
  return (
    <div className="role-summary">
      {typeof data.description === 'string' ? <p>{data.description}</p> : null}
      <dl>
        <dt>{t('roleRuntime')}</dt><dd>{runtime ? <span className={`rt rt-${runtime}`}>{runtime === 'codex' ? 'Codex' : runtime === 'claude' ? 'Claude' : runtime}</span> : t('defaultValue')}</dd>
        <dt>{t('roleAccess')}</dt><dd>{value('access') || t('defaultValue')}</dd>
        <dt>{t('roleEffort')}</dt>
        <dd>
          <select aria-label={t('roleEffort')} value={value('effort')} disabled={disabled} onChange={event => { void set('effort', event.target.value || null); }}>
            <option value="">{t('defaultValue')}</option>
            {EFFORTS.map(effort => <option key={effort} value={effort}>{effort}</option>)}
          </select>
        </dd>
        <dt className={runtime === 'codex' ? 'active-runtime' : ''}>{t('roleModelCodex')}</dt>
        <dd className={runtime === 'codex' ? 'active-runtime' : ''}>
          <ModelSelect label={t('roleModelCodex')} value={value('model-codex')} choices={models?.codex.models ?? []} fallback={fallback(models?.codex.default)} busy={disabled} onPick={next => { void set('model-codex', next); }} />
          {models?.codex.reason ? <div className="editor-note warn">{t('modelsUnavailable', { reason: models.codex.reason })}</div> : null}
        </dd>
        <dt className={runtime === 'claude' ? 'active-runtime' : ''}>{t('roleModelClaude')}</dt>
        <dd className={runtime === 'claude' ? 'active-runtime' : ''}>
          <ModelSelect label={t('roleModelClaude')} value={value('model-claude')} choices={models?.claude.models ?? []} fallback={fallback(models?.claude.default)} busy={disabled} onPick={next => { void set('model-claude', next); }} />
        </dd>
        {value('model') ? <><dt>{t('roleModel')}</dt><dd className="editor-note">{t('roleGenericModel', { value: value('model') })}</dd></> : null}
        <dt>{t('roleSkills')}</dt>
        <dd>{linked.length ? <ul className="skill-refs">{linked.map(id => { const skill = skills.find(entry => entry.id === id); const description = skill ? readFrontmatter(skill.text).data.description : undefined; return <li key={id}><strong>{id}</strong>{typeof description === 'string' ? <span>{description}</span> : <span className="error">{t('skillMissing')}</span>}</li>; })}</ul> : t('noRoleSkills')}</dd>
      </dl>
      {note ? <p className={`editor-note ${note.kind === 'error' ? 'error' : note.kind === 'warn' ? 'warn' : ''}`} role="status">{note.kind === 'error' ? note.lines.join(' ') : note.kind === 'warn' ? note.lines.join(' ') : t('roleSettingSaved')}</p> : null}
    </div>
  );
}

/** The project memory as a list: every entry goes into lead and builder instructions, so wrong ones are fixed here. */
function MemoryTab({ project, busy, onSaved }: { project: string; busy: boolean; onSaved: () => void }) {
  const { t } = useI18n();
  const [saved, setSaved] = useState<string[] | null>(null);
  const [facts, setFacts] = useState<string[]>([]);
  const [max, setMax] = useState(2000);
  const [fresh, setFresh] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const [saving, setSaving] = useState(false);
  const load = useCallback(async (): Promise<void> => {
    try { const loaded = await api.memory(project); setSaved(loaded.facts); setFacts(loaded.facts); setMax(loaded.maxChars); } catch (caught) { setStatus({ kind: 'error', lines: [errorText(caught)] }); }
  }, [project]);
  useEffect(() => { void load(); }, [load]);
  if (!saved) return status ? <p className="error">{status.lines[0]}</p> : null;
  const dirty = JSON.stringify(facts) !== JSON.stringify(saved);
  const used = memoryChars(facts);
  const save = async (): Promise<void> => {
    setSaving(true);
    try { await api.saveMemory(project, facts); await load(); onSaved(); setStatus({ kind: 'ok', lines: [] }); }
    catch (caught) { setStatus({ kind: 'error', lines: caught instanceof ApiError && caught.details.length ? caught.details : [errorText(caught)] }); }
    finally { setSaving(false); }
  };
  const add = (): void => { const fact = fresh.trim(); if (!fact) return; setFacts(list => [...list, fact]); setFresh(''); setStatus(null); };
  return (
    <div className="editor memory-editor">
      <div className="editor-head">
        <strong>{t('tabMemory')}</strong>
        <span className="mono editor-file">.agent-desk/memory.md</span>
        <span className={`badge ${used > max ? 'tone-danger' : used > max * 0.8 ? 'tone-warning' : 'tone-neutral'}`}>{t('memoryUsed', { used, max })}</span>
        {dirty ? <span className="badge tone-warning">{t('unsaved')}</span> : null}
        <button className="send push" disabled={busy || saving || !dirty} onClick={() => { void save(); }}>{t('save')}</button>
      </div>
      <p className="editor-note">{t('memoryHint')}</p>
      {facts.length ? (
        <ol className="memory-list">
          {facts.map((fact, index) => (
            <li key={index}>
              <input value={fact} maxLength={240} aria-label={t('memoryEntry', { n: index + 1 })} onChange={event => { const next = event.target.value; setFacts(list => list.map((item, at) => (at === index ? next : item))); setStatus(null); }} />
              <button className="ghost danger" onClick={() => { setFacts(list => list.filter((_, at) => at !== index)); setStatus(null); }}>{t('memoryDelete')}</button>
            </li>
          ))}
        </ol>
      ) : <p className="editor-note">{t('memoryEmpty')}</p>}
      <div className="memory-add">
        <input value={fresh} maxLength={240} placeholder={t('memoryPlaceholder')} aria-label={t('memoryAdd')} onChange={event => setFresh(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') add(); }} />
        <button disabled={!fresh.trim()} onClick={add}>{t('memoryAdd')}</button>
      </div>
      {status ? (
        <div className={`editor-status ${status.kind}`} role="status">
          <strong>{status.kind === 'error' ? t('saveFailed') : t('saved')}</strong>
          {status.lines.length ? <ul>{status.lines.map((line, index) => <li key={index}>{line}</li>)}</ul> : null}
        </div>
      ) : null}
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
  const [models, setModels] = useState<ModelChoices | null>(null);
  useEffect(() => { api.models().then(setModels).catch(() => setModels(null)); }, []);

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
            {(['config', 'roles', 'skills', 'memory'] as const).map(name => <button key={name} role="tab" aria-selected={tab === name} className={tab === name ? 'on' : ''} onClick={() => setTab(name)}>{t(name === 'config' ? 'tabConfig' : name === 'roles' ? 'tabRoles' : name === 'skills' ? 'tabSkills' : 'tabMemory')}</button>)}
          </nav>
          <button className="ghost push" onClick={onClose}>{t('close')}</button>
        </header>
        {busy ? <p className="editor-note warn">{t('busyProject')}</p> : null}
        {error ? <p className="error">{error}</p> : null}
        {files && (!files.config.exists || missingRoles.length) ? (
          <div className="drafts"><p>{t('draftsHint')}</p><button disabled={busy} onClick={() => { void drafts(); }}>{t('createDrafts')}</button>{draftNote ? <span className="editor-note">{draftNote}</span> : null}</div>
        ) : null}
        {tab === 'memory' ? (
          <MemoryTab project={project} busy={busy} onSaved={onSaved} />
        ) : !files ? null : tab === 'config' ? (
          <Editor label={t('tabConfig')} file=".agent-desk/config.json" initial={files.config.text} exists={files.config.exists} busy={busy} onSave={save('config')} />
        ) : tab === 'roles' ? (
          <div className="split">
            <nav className="split-list">{ROLES.map(name => <button key={name} className={role === name ? 'on' : ''} onClick={() => setRole(name)}><span className={`avatar avatar-${name}`} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>{name}{runtimes?.[name] ? <span className={`rt rt-${runtimes[name]}`}>{runtimes[name] === 'codex' ? 'Codex' : 'Claude'}</span> : null}</button>)}</nav>
            <div className="split-main">
              <RoleSummary text={files.roles[role]?.text ?? ''} skills={files.skills} runtime={runtimes?.[role]} models={models} busy={busy}
                onSet={(key, next) => save('role', role)(setFrontmatterValue(files.roles[role]?.text ?? '', key, next))} />
              <Editor label={role} file={`.agent-desk/agents/${role}.md`} initial={files.roles[role]?.text ?? ''} exists={files.roles[role]?.exists ?? false} busy={busy} onSave={save('role', role)} />
            </div>
          </div>
        ) : (
          <div className="split">
            <nav className="split-list">
              {files.skills.map(entry => <button key={entry.id} className={skill === entry.id ? 'on' : ''} onClick={() => setSkill(entry.id)}>{entry.id}</button>)}
              {!files.skills.length ? <div className="editor-note"><p>{t('noSkillsYet')}</p><p>{t('skillDraftsHint')}</p><button disabled={busy} onClick={() => { void drafts(); }}>{t('createDrafts')}</button></div> : null}
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
