import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError, followRun } from './api.ts';
import type { ActiveRun, FolderListing, Pending, RunDetail, RunRow } from './api.ts';
import { applyEvents, emptyTimeline, formatTokens, gateSummary, statusTone, stepDurationMs } from './model.ts';
import type { GateResult, Timeline } from './model.ts';
import { detectLanguage, durationText, I18nContext, translate, useI18n } from './i18n.ts';
import type { I18n, Lang } from './i18n.ts';

const PROJECT_KEY = 'agent-desk.project';
const readProject = (): string => { try { return localStorage.getItem(PROJECT_KEY) ?? ''; } catch { return ''; } };
const saveProject = (value: string): void => { try { localStorage.setItem(PROJECT_KEY, value); } catch { /* storage may be unavailable */ } };
const errorText = (error: unknown): string => (error instanceof ApiError || error instanceof Error ? error.message : 'Something went wrong');

function Badge({ status }: { status: string }) {
  const { t } = useI18n();
  const known = ['running', 'completed', 'needs_review', 'needs_user', 'interrupted', 'failed'].includes(status);
  return <span className={`badge tone-${statusTone(status)}`}>{known ? t(`status_${status}` as 'status_running') : status}</span>;
}

function useGateLabel(): (gate: GateResult) => string {
  const { t } = useI18n();
  return gate => `${gate.attempt ? `${gate.gate}#${gate.attempt}` : gate.gate} ${gate.skipped ? t('gateSkipped') : gate.ok ? t('gateOk') : t('gateFailed')}`;
}

function FolderPicker({ start, onPick, onClose }: { start: string; onPick: (path: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState('');

  const open = useCallback(async (path: string): Promise<void> => {
    try { setListing(await api.folder(path)); setError(''); } catch (caught) { setError(errorText(caught)); }
  }, []);
  useEffect(() => { void open(start); }, [open, start]);

  const segments = listing?.path ? listing.path.split(/[\\/]/).filter(Boolean) : [];
  const joiner = listing?.path.includes('\\') ? '\\' : '/';
  const crumbPath = (index: number): string => {
    const joined = segments.slice(0, index + 1).join(joiner);
    return joiner === '\\' ? (index === 0 ? `${joined}\\` : joined) : `/${joined}`;
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog card" role="dialog" aria-label={t('pickerTitle')} onClick={event => event.stopPropagation()}>
        <div className="step-head"><h2>{t('pickerTitle')}</h2><button className="push" onClick={onClose}>{t('close')}</button></div>
        <div className="crumbs">
          <button onClick={() => { void open(''); }}>{t('computer')}</button>
          {listing?.home ? <button onClick={() => { void open(listing.home); }}>{t('home')}</button> : null}
          {segments.map((segment, index) => <button key={index} onClick={() => { void open(crumbPath(index)); }}>{segment}</button>)}
        </div>
        {error ? <p className="error">{error}</p> : null}
        <div className="folders">
          {listing && listing.parent !== null && listing.path ? <button className="folder" onClick={() => { void open(listing.parent!); }}>{t('up')}</button> : null}
          {listing?.entries.map(entry => (
            <button key={entry.path} className="folder" onClick={() => { void open(entry.path); }}>
              <span>{entry.name}</span>{entry.isProject ? <span className="badge tone-accent">{t('projectTag')}</span> : null}
            </button>
          ))}
          {listing && !listing.entries.length ? <p className="muted">{t('noSubfolders')}</p> : null}
        </div>
        <div className="row">
          <span className="muted current">{listing?.path || t('selectDrive')}</span>
          <button className="push" disabled={!listing?.path} onClick={() => { if (listing?.path) onPick(listing.path); }}>{t('selectThisFolder')}</button>
        </div>
      </div>
    </div>
  );
}

function StartForm({ active, onStarted }: { active: ActiveRun | null; onStarted: (runId: number) => void }) {
  const { t } = useI18n();
  const [project, setProject] = useState(readProject);
  const [request, setRequest] = useState('');
  const [runtime, setRuntime] = useState<'codex' | 'claude' | ''>('');
  const [review, setReview] = useState<'always' | 'auto' | 'never' | ''>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  /** Opens the computer's own folder window; where that is not available the in-page browser is used instead. */
  const browse = async (): Promise<void> => {
    setError('');
    setDialogOpen(true);
    try {
      const result = await api.pickFolder(project, t('dialogTitle'));
      if (!result.supported) setBrowsing(true);
      else if (result.path) { setProject(result.path); saveProject(result.path); }
    } catch (caught) { setError(errorText(caught)); } finally { setDialogOpen(false); }
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError('');
    if (!project.trim()) { setError(t('needFolder')); return; }
    if (!request.trim()) { setError(t('needRequest')); return; }
    setBusy(true);
    try {
      saveProject(project.trim());
      const { runId } = await api.start({ project: project.trim(), request: request.trim(), ...(runtime ? { runtime } : {}), ...(review ? { review } : {}) });
      setRequest('');
      onStarted(runId);
    } catch (caught) { setError(errorText(caught)); } finally { setBusy(false); }
  };

  return (
    <form className="card form" onSubmit={event => { void submit(event); }}>
      <label>{t('projectFolder')}
        <span className="row"><input value={project} onChange={event => setProject(event.target.value)} placeholder={t('chooseFolder')} /><button type="button" disabled={dialogOpen} onClick={() => { void browse(); }}>{t('browse')}</button></span>
      </label>
      {dialogOpen ? <p className="muted">{t('dialogOpen')}</p> : null}
      {browsing ? <FolderPicker start={project} onPick={path => { setProject(path); saveProject(path); setBrowsing(false); }} onClose={() => setBrowsing(false)} /> : null}
      <label>{t('whatToDo')}<textarea value={request} onChange={event => setRequest(event.target.value)} rows={4} placeholder={t('requestPlaceholder')} /></label>
      <div className="row">
        <label>{t('runtime')}<select value={runtime} onChange={event => setRuntime(event.target.value as typeof runtime)}><option value="">{t('fromConfig')}</option><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
        <label>{t('review')}<select value={review} onChange={event => setReview(event.target.value as typeof review)}><option value="">{t('fromConfig')}</option><option value="auto">{t('reviewAuto')}</option><option value="always">{t('reviewAlways')}</option><option value="never">{t('reviewNever')}</option></select></label>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <button type="submit" disabled={busy || active !== null}>{active ? t('runIsActive', { id: active.runId }) : t('run')}</button>
    </form>
  );
}

function RunList({ runs, selected, onSelect }: { runs: RunRow[]; selected: number | null; onSelect: (id: number) => void }) {
  const { t } = useI18n();
  if (!runs.length) return <div className="card muted">{t('noRuns')}</div>;
  return (
    <div className="card list">
      {runs.map(run => (
        <button key={run.id} className={`list-row${run.id === selected ? ' selected' : ''}`} onClick={() => onSelect(run.id)}>
          <span className="id">{run.id}</span>
          <span className="request">{run.request.replace(/\s+/g, ' ').slice(0, 60)}</span>
          <Badge status={run.status} />
        </button>
      ))}
    </div>
  );
}

function PendingCard({ pending }: { pending: Pending }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const send = async (answer: string): Promise<void> => {
    if (!answer.trim()) { setError(t('needAnswerText')); return; }
    setError('');
    try { await api.answer(answer); setText(''); } catch (caught) { setError(errorText(caught)); }
  };
  return (
    <div className="card accent">
      <strong>{t('needsAnswer')}</strong>
      <p className="pending-question">{pending.question}</p>
      {pending.options?.length ? <div className="row">{pending.options.map(option => <button key={option} onClick={() => { void send(option); }}>{option}</button>)}</div> : null}
      <div className="row"><input value={text} onChange={event => setText(event.target.value)} placeholder={t('yourAnswer')} /><button onClick={() => { void send(text); }}>{t('send')}</button></div>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

function TimelineView({ timeline }: { timeline: Timeline }) {
  const { t, lang } = useI18n();
  const gateLabel = useGateLabel();
  if (!timeline.steps.length) return <p className="muted">{t('waitingStep')}</p>;
  return (
    <ol className="timeline">
      {timeline.steps.map((step, index) => (
        <li key={`${step.step}-${index}`}>
          <div className="step-head"><strong>{step.step}</strong><span className="muted">{step.role}{stepDurationMs(step) !== null ? `, ${durationText(lang, stepDurationMs(step)!)}` : ''}</span>
            {step.ok === false ? <span className="badge tone-danger">{t('failedTag')}</span> : null}</div>
          <div className="chips">
            {step.gates.map((gate, gateIndex) => <span key={gateIndex} className={`badge tone-${gate.skipped ? 'neutral' : gate.ok ? 'success' : 'danger'}`}>{gateLabel(gate)}</span>)}
            {step.commands ? <span className="badge tone-neutral">{t('commands', { n: step.commands })}</span> : null}
            {step.fileChanges ? <span className="badge tone-neutral">{t('fileChanges', { n: step.fileChanges })}</span> : null}
          </div>
          {step.redo.map(redo => <div key={redo.attempt} className="problems"><span className="muted">{t('redo', { n: redo.attempt, mode: redo.mode })}</span><ul>{redo.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul></div>)}
          {step.gates.filter(gate => !gate.ok && !gate.skipped && gate.problems?.length).map((gate, i) => <ul key={i} className="problems">{gate.problems!.map((problem, j) => <li key={j}>{problem}</li>)}</ul>)}
        </li>
      ))}
    </ol>
  );
}

function RunView({ runId, active, onFinished }: { runId: number; active: ActiveRun | null; onFinished: () => void }) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [timeline, setTimeline] = useState<Timeline>(emptyTimeline);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState('');
  const [revertNote, setRevertNote] = useState('');
  const finished = useRef(onFinished);
  finished.current = onFinished;

  const reload = useCallback(async (): Promise<void> => {
    try { setDetail(await api.run(runId)); } catch (caught) { setError(errorText(caught)); }
  }, [runId]);

  useEffect(() => {
    setDetail(null); setTimeline(emptyTimeline()); setPending(null); setError(''); setRevertNote('');
    void reload();
    return followRun(runId, {
      onEvent: event => setTimeline(current => applyEvents(current, [event])),
      onPending: setPending,
      onDone: () => { void reload(); finished.current(); },
      onError: () => { /* EventSource retries; the next event or done message clears this */ },
    });
  }, [runId, reload]);

  const isActive = active?.runId === runId;
  const status = detail?.run.status ?? 'running';
  const summary = gateSummary(timeline);

  const revert = async (yes: boolean): Promise<void> => {
    try {
      const plan = await api.revert(runId, yes);
      setRevertNote(t(yes ? 'revertDone' : 'revertPreview', { restore: plan.restore.length, remove: plan.remove.length }));
    } catch (caught) { setRevertNote(errorText(caught)); }
  };

  return (
    <div className="stack">
      <div className="card">
        <div className="step-head"><h2>{t('runTitle', { id: runId })}</h2><Badge status={status} />
          <span className="muted push">{detail ? `${formatTokens(detail.usageTotal)} ${t('tokens')}` : ''}</span></div>
        {detail ? <p className="request-full">{detail.run.request}</p> : null}
        {detail?.run.reason ? <p className="muted">{detail.run.reason}</p> : null}
        <div className="chips">{summary.map(entry => <span key={entry.gate} className={`badge tone-${entry.failed ? 'danger' : 'success'}`}>{entry.gate} {entry.failed ? t('gateFailedTimes', { n: entry.failed }) : t('gateOk')}</span>)}</div>
        <div className="row">
          {isActive ? <button onClick={() => { void api.cancel(); }}>{t('stop')}</button> : null}
          {!isActive && (status === 'needs_review' || status === 'failed') ? <><button onClick={() => { void revert(false); }}>{t('previewRevert')}</button><button onClick={() => { void revert(true); }}>{t('applyRevert')}</button></> : null}
        </div>
        {revertNote ? <p className="muted">{revertNote}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </div>
      {pending && isActive ? <PendingCard pending={pending} /> : null}
      <div className="card"><TimelineView timeline={timeline} /></div>
    </div>
  );
}

export function App() {
  const [lang, setLangState] = useState<Lang>(() => { let stored: string | null = null; try { stored = localStorage.getItem('agent-desk.lang'); } catch { /* storage may be unavailable */ } return detectLanguage(stored, navigator.language); });
  const setLang = (next: Lang): void => { setLangState(next); try { localStorage.setItem('agent-desk.lang', next); } catch { /* storage may be unavailable */ } };
  const i18n: I18n = { lang, setLang, t: (key, values) => translate(lang, key, values) };
  const [active, setActive] = useState<ActiveRun | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const state = await api.state();
      setActive(state.active);
      setRuns((await api.runs()).runs);
      setError('');
    } catch (caught) { setError(errorText(caught)); }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const start = (runId: number): void => { setSelected(runId); void refresh(); };

  return (
    <I18nContext.Provider value={i18n}>
    <div className="shell">
      <header><strong>Agent Desk</strong><span className="muted">v2</span>
        <span className="push lang" role="group" aria-label={i18n.t('language')}>
          <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>English</button>
          <button className={lang === 'ko' ? 'on' : ''} onClick={() => setLang('ko')}>한국어</button>
        </span>
      </header>
      {error ? <p className="error banner">{i18n.t('serverDown')}: {error}</p> : null}
      <main>
        <section className="column">
          <StartForm active={active} onStarted={start} />
          <RunList runs={runs} selected={selected} onSelect={setSelected} />
        </section>
        <section className="column wide">
          {selected !== null ? <RunView key={selected} runId={selected} active={active} onFinished={() => { void refresh(); }} /> : <div className="card muted">{i18n.t('selectRun')}</div>}
        </section>
      </main>
    </div>
    </I18nContext.Provider>
  );
}
