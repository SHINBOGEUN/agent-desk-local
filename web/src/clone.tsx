// "Import from git": address, the folder to clone into, and what to do after (work branch, install, survey).
// The server does the work (git clone, checkout, install); this dialog shows each step's outcome.

import { useState } from 'react';
import { api } from './api.ts';
import type { CloneReply } from './api.ts';
import { useI18n } from './i18n.ts';
import { errorText } from './util.ts';

const PARENT_KEY = 'agent-desk.cloneParent';
const read = (key: string): string => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } };
const write = (key: string, value: string): void => { try { localStorage.setItem(key, value); } catch { /* storage may be unavailable */ } };

/** "https://github.com/me/my-app.git" -> "my-app" (the server derives the same name). */
export const repoName = (url: string): string => (url.trim().replace(/[\\/]+$/, '').split(/[\\/:]/).at(-1) ?? '').replace(/\.git$/i, '').replace(/[^\w.-]/g, '-').replace(/^[.-]+/, '');

export function CloneDialog({ startFolder, onDone, onClose }: { startFolder: string; onDone: (path: string, survey: boolean) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [url, setUrl] = useState('');
  const [parent, setParent] = useState(() => read(PARENT_KEY) || startFolder);
  const [name, setName] = useState('');
  const [useBranch, setUseBranch] = useState(true);
  const [branch, setBranch] = useState('agent-work');
  const [install, setInstall] = useState(true);
  const [survey, setSurvey] = useState(true);
  const [working, setWorking] = useState(false);
  const [reply, setReply] = useState<CloneReply | null>(null);
  const [error, setError] = useState('');
  const browse = async (): Promise<void> => {
    try { const picked = await api.pickFolder(parent, t('cloneParentPick')); if (picked.supported && picked.path) setParent(picked.path); } catch (caught) { setError(errorText(caught)); }
  };
  const go = async (): Promise<void> => {
    setWorking(true); setError(''); setReply(null);
    write(PARENT_KEY, parent);
    try {
      const result = await api.cloneProject({ url, parent, name: name.trim(), ...(useBranch && branch.trim() ? { branch: branch.trim() } : {}), install });
      setReply(result);
      if (result.ok) onDone(result.path, survey);
    } catch (caught) {
      setError(errorText(caught));
    } finally { setWorking(false); }
  };
  const stepName = (step: string): string => t(step === 'clone' ? 'cloneStepClone' : step === 'branch' ? 'cloneStepBranch' : 'cloneStepInstall');
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={t('cloneTitle')}>
      <div className="dialog card clone-dialog">
        <div className="step-head"><h2>{t('cloneTitle')}</h2><button className="ghost small push" onClick={onClose} disabled={working}>{t('close')}</button></div>
        <label className="field">{t('cloneUrl')}<input value={url} onChange={event => setUrl(event.target.value)} placeholder="https://github.com/me/my-app.git" autoFocus /></label>
        <label className="field">{t('cloneParent')}
          <span className="row tight"><input value={parent} onChange={event => setParent(event.target.value)} placeholder="D:\\work" /><button className="ghost small" onClick={() => { void browse(); }}>{t('cloneBrowse')}</button></span>
        </label>
        <label className="field">{t('cloneName')}<input value={name} onChange={event => setName(event.target.value)} placeholder={repoName(url) || 'my-app'} /></label>
        <label className="check"><input type="checkbox" checked={useBranch} onChange={event => setUseBranch(event.target.checked)} /> {t('cloneBranch')} <input className="branch-input" value={branch} disabled={!useBranch} onChange={event => setBranch(event.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={install} onChange={event => setInstall(event.target.checked)} /> {t('cloneInstall')}</label>
        {install ? <p className="editor-note">{t('cloneInstallNote')}</p> : null}
        <label className="check"><input type="checkbox" checked={survey} onChange={event => setSurvey(event.target.checked)} /> {t('cloneSurvey')}</label>
        <div className="row">
          <button className="primary" disabled={working || !url.trim() || !parent.trim()} onClick={() => { void go(); }}>{working ? t('cloneWorking') : t('cloneGo')}</button>
          {working ? <span className="muted">{t('cloneWorkingNote')}</span> : null}
        </div>
        {reply ? (
          <ul className="clone-steps">
            {reply.steps.map(step => (
              <li key={step.step} className={step.ok ? 'ok' : 'bad'}>
                <strong>{stepName(step.step)}</strong> {step.skipped ? t('cloneSkipped') : step.ok ? t('cloneOk') : t('cloneFailed')}
                {!step.ok && step.output ? <pre>{step.output.slice(-800)}</pre> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {reply && !reply.ok && reply.path ? (
          <div className="row"><span className="muted">{t('clonePartial')}</span><button className="ghost small" onClick={() => onDone(reply.path, survey)}>{t('cloneOpenAnyway')}</button></div>
        ) : null}
        {error ? <p className="error">{error}</p> : null}
      </div>
    </div>
  );
}
