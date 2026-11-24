// "AI draft" in the team settings: one read-only model session reads the project and proposes role rules and
// project skills. Nothing is written until the user picks what to keep and applies it.

import { useState } from 'react';
import { api } from './api.ts';
import type { TeamDraft } from './api.ts';
import { useI18n } from './i18n.ts';
import { errorText } from './util.ts';

const ROLES = ['lead', 'builder', 'verifier', 'researcher'] as const;

export function TeamDraftBar({ project, busy, onApplied }: { project: string; busy: boolean; onApplied: () => void }) {
  const { t, lang } = useI18n();
  const [state, setState] = useState<'idle' | 'working' | 'review'>('idle');
  const [draft, setDraft] = useState<TeamDraft | null>(null);
  const [rules, setRules] = useState<Record<string, boolean>>({});
  const [skills, setSkills] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const generate = async (): Promise<void> => {
    setState('working'); setNote('');
    try {
      const reply = await api.teamDraft(project, lang);
      if (!reply.ok || !reply.draft) { setState('idle'); setNote(reply.error ?? t('teamDraftFailed')); return; }
      setDraft(reply.draft);
      setRules(Object.fromEntries(ROLES.flatMap(role => (reply.draft!.rules[role] ?? []).map((_, index) => [`${role}:${index}`, true]))));
      setSkills(Object.fromEntries(reply.draft.skills.map(skill => [skill.id, !skill.exists])));
      setState('review');
    } catch (caught) { setState('idle'); setNote(errorText(caught)); }
  };

  const apply = async (): Promise<void> => {
    if (!draft) return;
    const chosenRules = Object.fromEntries(ROLES.map(role => [role, (draft.rules[role] ?? []).filter((_, index) => rules[`${role}:${index}`])]).filter(([, list]) => (list ?? []).length));
    const chosenSkills = draft.skills.filter(skill => skills[skill.id]);
    try {
      const result = await api.applyTeamDraft({ project, rules: chosenRules, skills: chosenSkills });
      setNote(result.errors.length ? `${t('teamDraftApplied', { n: result.written.length })} ${result.errors.join(' / ')}` : t('teamDraftApplied', { n: result.written.length }));
      setState('idle'); setDraft(null); onApplied();
    } catch (caught) { setNote(errorText(caught)); }
  };

  const picked = Object.values(rules).filter(Boolean).length + Object.values(skills).filter(Boolean).length;

  return (
    <div className="team-draft">
      <div className="drafts">
        <p>{t('teamDraftHint')}</p>
        <button disabled={busy || state === 'working'} onClick={() => { void generate(); }}>{state === 'working' ? t('teamDraftWorking') : t('teamDraftButton')}</button>
        {note ? <span className="editor-note">{note}</span> : null}
      </div>
      {state === 'review' && draft ? (
        <div className="team-draft-review">
          {ROLES.filter(role => draft.rules[role]?.length).map(role => (
            <section key={role}>
              <h4><span className={`avatar avatar-${role}`} aria-hidden="true">{role.slice(0, 1).toUpperCase()}</span>{role}</h4>
              {draft.rules[role]!.map((rule, index) => (
                <label key={index} className="draft-item"><input type="checkbox" checked={rules[`${role}:${index}`] ?? false} onChange={event => setRules(current => ({ ...current, [`${role}:${index}`]: event.target.checked }))} />{rule}</label>
              ))}
            </section>
          ))}
          {draft.skills.length ? (
            <section>
              <h4>{t('teamDraftSkills')}</h4>
              {draft.skills.map(skill => (
                <div key={skill.id} className="draft-skill">
                  <label className="draft-item"><input type="checkbox" checked={skills[skill.id] ?? false} onChange={event => setSkills(current => ({ ...current, [skill.id]: event.target.checked }))} />
                    <span><strong>{skill.id}</strong> <span className="muted">({skill.role}{skill.exists ? `, ${t('teamDraftReplaces')}` : ''})</span><br />{skill.description}</span>
                  </label>
                  <button className="ghost" onClick={() => setOpen(open === skill.id ? null : skill.id)}>{open === skill.id ? t('showLess') : t('showMore')}</button>
                  {open === skill.id ? <pre className="draft-body">{skill.body}</pre> : null}
                </div>
              ))}
            </section>
          ) : null}
          {draft.sources.length ? <p className="muted draft-sources">{t('teamDraftSources')}: {draft.sources.join(', ')}</p> : null}
          <div className="draft-actions">
            <button disabled={busy || !picked} onClick={() => { void apply(); }}>{t('teamDraftApply', { n: picked })}</button>
            <button className="ghost" onClick={() => { setState('idle'); setDraft(null); }}>{t('teamDraftDiscard')}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
