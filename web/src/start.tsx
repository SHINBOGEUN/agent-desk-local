// The start card for a project opened for the first time (or reopened from the conversation header).
// New folder: three short questions become the overview note (and the rules go into memory), then a first request
// is drafted. Existing code: what the harness can tell without a model call (stack, tests, git, verify commands),
// one button to set the verify commands, and one to survey the project into a "current state" note.

import { useEffect, useState } from 'react';
import { api } from './api.ts';
import type { ProjectStartInfo } from './api.ts';
import { useI18n } from './i18n.ts';
import { projectName } from './model.ts';
import { errorText } from './util.ts';

export const SURVEY_KEY = (project: string): string => `agent-desk.survey:${project}`;

export function StartCard({ project, busy, onDraft, onSurvey, onDesign, onClose }: {
  project: string;
  /** A run is going (here or elsewhere): starting the survey or saving settings would wait. */
  busy: boolean;
  onDraft: (text: string) => void;
  onSurvey: (request: string) => Promise<void>;
  /** Opens the to-do list with the design form. */
  onDesign?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
}) {
  const { t, lang } = useI18n();
  const [info, setInfo] = useState<ProjectStartInfo | null>(null);
  const [error, setError] = useState('');
  const load = (): void => { api.projectStart(project).then(setInfo).catch(caught => setError(errorText(caught))); };
  useEffect(load, [project]);
  if (!info) return <section className="start-card"><p className="muted">{error || t('startChecking')}</p></section>;
  return (
    <section className="start-card">
      <header className="start-head">
        <div>
          <span className="start-kind">{info.kind === 'new' ? t('startKindNew') : t('startKindExisting')}</span>
          <h2>{t('startTitleFor', { name: projectName(project) })}</h2>
          <p className="muted">{info.kind === 'new' ? t('startNewIntro') : t('startExistingIntro')}</p>
        </div>
        {onClose ? <button className="ghost small" onClick={onClose}>{t('close')}</button> : null}
      </header>
      {info.kind === 'new'
        ? <NewProject project={project} busy={busy} onDraft={onDraft} />
        : <ExistingProject project={project} info={info} busy={busy} onDraft={onDraft} onSurvey={onSurvey} onSaved={load} />}
      {onDesign ? <div className="start-design"><div><strong>{t('startDesignTitle')}</strong><p className="muted">{t('startDesignHint')}</p></div><button disabled={busy} onClick={onDesign}>{t('todoDesign')}</button></div> : null}
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}

function NewProject({ project, busy, onDraft }: { project: string; busy: boolean; onDraft: (text: string) => void }) {
  const { t, lang } = useI18n();
  const [goal, setGoal] = useState('');
  const [stack, setStack] = useState('');
  const [recommend, setRecommend] = useState(false);
  const [rules, setRules] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ note: string; rules: number } | null>(null);
  const [error, setError] = useState('');
  const create = async (): Promise<void> => {
    setSaving(true); setError('');
    try {
      const ruleList = rules.split('\n').map(rule => rule.trim()).filter(Boolean);
      const saved = await api.writeOverview({ project, goal, stack: recommend ? '' : stack, rules: ruleList, lang });
      const note = saved.note.replace(/\.md$/, '');
      setDone({ note, rules: ruleList.length });
      onDraft(recommend || !stack.trim() ? t('startDraftChoose', { note }) : t('startDraftBuild', { note }));
    } catch (caught) { setError(errorText(caught)); } finally { setSaving(false); }
  };
  if (done) {
    return (
      <div className="start-done">
        <p>{t('startNewDone', { note: done.note, n: done.rules })}</p>
        <p className="muted">{t('startNewNext')}</p>
      </div>
    );
  }
  return (
    <>
      <ol className="start-steps">
        <li>
          <label htmlFor="start-goal"><strong>{t('startGoal')}</strong><span className="muted">{t('startGoalHint')}</span></label>
          <textarea id="start-goal" rows={3} value={goal} onChange={event => setGoal(event.target.value)} placeholder={t('startGoalExample')} />
        </li>
        <li>
          <label htmlFor="start-stack"><strong>{t('startStack')}</strong><span className="muted">{t('startStackHint')}</span></label>
          <input id="start-stack" value={stack} disabled={recommend} onChange={event => setStack(event.target.value)} placeholder={t('startStackExample')} />
          <label className="check"><input type="checkbox" checked={recommend} onChange={event => setRecommend(event.target.checked)} /> {t('startStackRecommend')}</label>
        </li>
        <li>
          <label htmlFor="start-rules"><strong>{t('startRules')}</strong><span className="muted">{t('startRulesHint')}</span></label>
          <textarea id="start-rules" rows={3} value={rules} onChange={event => setRules(event.target.value)} placeholder={t('startRulesExample')} />
        </li>
      </ol>
      <div className="row">
        <button className="primary" disabled={saving || busy || !goal.trim()} onClick={() => { void create(); }}>{t('startCreateOverview')}</button>
        {busy ? <span className="muted">{t('startBusy')}</span> : null}
      </div>
      {error ? <p className="error">{error}</p> : null}
    </>
  );
}

function ExistingProject({ project, info, busy, onDraft, onSurvey, onSaved }: { project: string; info: ProjectStartInfo; busy: boolean; onDraft: (text: string) => void; onSurvey: (request: string) => Promise<void>; onSaved: () => void }) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<string[]>(() => info.verifyCandidates.map(candidate => candidate.command).filter(command => /test/.test(command)));
  const [note, setNote] = useState('');
  const [surveying, setSurveying] = useState(false);
  const git = info.git;
  const gitLine = !git.repo ? { tone: 'warn', text: t('startGitNone') }
    : git.uncommitted ? { tone: 'warn', text: t('startGitDirty', { n: git.uncommitted, commits: git.commits ?? '?' }) }
    : { tone: 'ok', text: t('startGitClean', { commits: git.commits ?? '?' }) };
  const saveVerify = async (): Promise<void> => {
    try { await api.setVerify(project, picked); setNote(t('startVerifySaved', { list: picked.join(', ') })); onSaved(); } catch (caught) { setNote(errorText(caught)); }
  };
  const survey = async (): Promise<void> => {
    setSurveying(true);
    try { await onSurvey(t('startSurveyRequest')); } catch (caught) { setNote(errorText(caught)); } finally { setSurveying(false); }
  };
  return (
    <>
      <ul className="start-checks">
        <li className="ok"><strong>{t('startStackLabel')}</strong> {info.stack.length ? info.stack.join(', ') : t('startUnknown')}</li>
        <li className={info.hasTests ? 'ok' : 'warn'}><strong>{t('startTestsLabel')}</strong> {info.hasTests ? t('startTestsYes') : t('startTestsNo')}</li>
        <li className={gitLine.tone}><strong>git</strong> {gitLine.text}</li>
        <li className={info.verify.length ? 'ok' : 'warn'}>
          <strong>{t('startVerifyLabel')}</strong>{' '}
          {info.verify.length ? <span className="mono">{info.verify.join(', ')}</span> : info.verifyCandidates.length ? t('startVerifyPick') : t('startVerifyNone')}
          {info.verifyCandidates.length ? (
            <div className="start-verify">
              {info.verifyCandidates.map(candidate => (
                <label key={candidate.command} className="check">
                  <input type="checkbox" checked={picked.includes(candidate.command)} onChange={event => setPicked(current => event.target.checked ? [...current, candidate.command] : current.filter(command => command !== candidate.command))} />
                  <span className="mono">{candidate.command}</span> <span className="muted">({candidate.source})</span>
                </label>
              ))}
              <button className="ghost small" disabled={busy} onClick={() => { void saveVerify(); }}>{t('startVerifySave')}</button>
            </div>
          ) : null}
        </li>
      </ul>
      {note ? <p className="msg-meta">{note}</p> : null}
      <div className="start-block">
        <h3>{t('startSurveyTitle')}</h3>
        <p className="muted">{t('startSurveyHint')}</p>
        <button className="primary" disabled={busy || surveying} onClick={() => { void survey(); }}>{t('startSurveyButton')}</button>
      </div>
      <div className="start-block">
        <h3>{t('startExamplesTitle')}</h3>
        <p className="muted">{t('startExamplesHint')}</p>
        <div className="row">
          {(['startExampleFix', 'startExampleAdd', 'startExampleTest'] as const).map(key => <button key={key} className="ghost small" onClick={() => onDraft(t(key))}>{t(`${key}Label` as 'startExampleFixLabel')}</button>)}
        </div>
      </div>
    </>
  );
}
