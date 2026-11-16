import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError, followRun } from './api.ts';
import type { ActiveRun, FolderListing, Pending, RunDetail, RunRow } from './api.ts';
import { applyEvents, emptyTimeline, formatDuration, formatTokens, gateLabel, gateSummary, STATUS_LABEL, statusTone, stepDurationMs } from './model.ts';
import type { Timeline } from './model.ts';

const PROJECT_KEY = 'agent-desk.project';
const readProject = (): string => { try { return localStorage.getItem(PROJECT_KEY) ?? ''; } catch { return ''; } };
const saveProject = (value: string): void => { try { localStorage.setItem(PROJECT_KEY, value); } catch { /* storage may be unavailable */ } };
const errorText = (error: unknown): string => (error instanceof ApiError || error instanceof Error ? error.message : 'Something went wrong');

function Badge({ status }: { status: string }) {
  return <span className={`badge tone-${statusTone(status)}`}>{STATUS_LABEL[status] ?? status}</span>;
}

function FolderPicker({ start, onPick, onClose }: { start: string; onPick: (path: string) => void; onClose: () => void }) {
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
      <div className="dialog card" role="dialog" aria-label="Choose a project folder" onClick={event => event.stopPropagation()}>
        <div className="step-head"><h2>Choose a project folder</h2><button className="push" onClick={onClose}>Close</button></div>
        <div className="crumbs">
          <button onClick={() => { void open(''); }}>Computer</button>
          {listing?.home ? <button onClick={() => { void open(listing.home); }}>Home</button> : null}
          {segments.map((segment, index) => <button key={index} onClick={() => { void open(crumbPath(index)); }}>{segment}</button>)}
        </div>
        {error ? <p className="error">{error}</p> : null}
        <div className="folders">
          {listing && listing.parent !== null && listing.path ? <button className="folder" onClick={() => { void open(listing.parent!); }}>.. (up)</button> : null}
          {listing?.entries.map(entry => (
            <button key={entry.path} className="folder" onClick={() => { void open(entry.path); }}>
              <span>{entry.name}</span>{entry.isProject ? <span className="badge tone-accent">project</span> : null}
            </button>
          ))}
          {listing && !listing.entries.length ? <p className="muted">No subfolders.</p> : null}
        </div>
        <div className="row">
          <span className="muted current">{listing?.path || 'Select a drive'}</span>
          <button className="push" disabled={!listing?.path} onClick={() => { if (listing?.path) onPick(listing.path); }}>Select this folder</button>
        </div>
      </div>
    </div>
  );
}

function StartForm({ active, onStarted }: { active: ActiveRun | null; onStarted: (runId: number) => void }) {
  const [project, setProject] = useState(readProject);
  const [request, setRequest] = useState('');
  const [runtime, setRuntime] = useState<'codex' | 'claude' | ''>('');
  const [review, setReview] = useState<'always' | 'auto' | 'never' | ''>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError('');
    if (!project.trim()) { setError('Enter the project folder (an absolute path).'); return; }
    if (!request.trim()) { setError('Describe what should be done.'); return; }
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
      <label>Project folder
        <span className="row"><input value={project} onChange={event => setProject(event.target.value)} placeholder="Choose a folder" /><button type="button" onClick={() => setBrowsing(true)}>Browse…</button></span>
      </label>
      {browsing ? <FolderPicker start={project} onPick={path => { setProject(path); saveProject(path); setBrowsing(false); }} onClose={() => setBrowsing(false)} /> : null}
      <label>What should be done?<textarea value={request} onChange={event => setRequest(event.target.value)} rows={4} placeholder="Add a due date field to todos" /></label>
      <div className="row">
        <label>Runtime<select value={runtime} onChange={event => setRuntime(event.target.value as typeof runtime)}><option value="">From config</option><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
        <label>Review<select value={review} onChange={event => setReview(event.target.value as typeof review)}><option value="">From config</option><option value="auto">Auto</option><option value="always">Always</option><option value="never">Never</option></select></label>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <button type="submit" disabled={busy || active !== null}>{active ? `Run ${active.runId} is active` : 'Run'}</button>
    </form>
  );
}

function RunList({ runs, selected, onSelect }: { runs: RunRow[]; selected: number | null; onSelect: (id: number) => void }) {
  if (!runs.length) return <div className="card muted">No runs yet. Start one above.</div>;
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
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const send = async (answer: string): Promise<void> => {
    if (!answer.trim()) { setError('Enter an answer first.'); return; }
    setError('');
    try { await api.answer(answer); setText(''); } catch (caught) { setError(errorText(caught)); }
  };
  return (
    <div className="card accent">
      <strong>Claude needs an answer</strong>
      <p className="pending-question">{pending.question}</p>
      {pending.options?.length ? <div className="row">{pending.options.map(option => <button key={option} onClick={() => { void send(option); }}>{option}</button>)}</div> : null}
      <div className="row"><input value={text} onChange={event => setText(event.target.value)} placeholder="Your answer" /><button onClick={() => { void send(text); }}>Send</button></div>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

function Timeline({ timeline }: { timeline: Timeline }) {
  if (!timeline.steps.length) return <p className="muted">Waiting for the first step…</p>;
  return (
    <ol className="timeline">
      {timeline.steps.map((step, index) => (
        <li key={`${step.step}-${index}`}>
          <div className="step-head"><strong>{step.step}</strong><span className="muted">{step.role}{stepDurationMs(step) !== null ? `, ${formatDuration(stepDurationMs(step)!)}` : ''}</span>
            {step.ok === false ? <span className="badge tone-danger">failed</span> : null}</div>
          <div className="chips">
            {step.gates.map((gate, gateIndex) => <span key={gateIndex} className={`badge tone-${gate.skipped ? 'neutral' : gate.ok ? 'success' : 'danger'}`}>{gateLabel(gate)}</span>)}
            {step.commands ? <span className="badge tone-neutral">{step.commands} command(s)</span> : null}
            {step.fileChanges ? <span className="badge tone-neutral">{step.fileChanges} file change(s)</span> : null}
          </div>
          {step.redo.map(redo => <div key={redo.attempt} className="problems"><span className="muted">redo {redo.attempt} ({redo.mode})</span><ul>{redo.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul></div>)}
          {step.gates.filter(gate => !gate.ok && !gate.skipped && gate.problems?.length).map((gate, i) => <ul key={i} className="problems">{gate.problems!.map((problem, j) => <li key={j}>{problem}</li>)}</ul>)}
        </li>
      ))}
    </ol>
  );
}

function RunView({ runId, active, onFinished }: { runId: number; active: ActiveRun | null; onFinished: () => void }) {
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
      setRevertNote(`${yes ? 'Reverted' : 'Would revert'}: restore ${plan.restore.length} file(s), remove ${plan.remove.length} file(s).${yes ? '' : ' Press "Apply revert" to do it.'}`);
    } catch (caught) { setRevertNote(errorText(caught)); }
  };

  return (
    <div className="stack">
      <div className="card">
        <div className="step-head"><h2>Run {runId}</h2><Badge status={status} />
          <span className="muted push">{detail ? `${formatTokens(detail.usageTotal)} tokens` : ''}</span></div>
        {detail ? <p className="request-full">{detail.run.request}</p> : null}
        {detail?.run.reason ? <p className="muted">{detail.run.reason}</p> : null}
        <div className="chips">{summary.map(entry => <span key={entry.gate} className={`badge tone-${entry.failed ? 'danger' : 'success'}`}>{entry.gate} {entry.failed ? `failed x${entry.failed}` : 'ok'}</span>)}</div>
        <div className="row">
          {isActive ? <button onClick={() => { void api.cancel(); }}>Stop run</button> : null}
          {!isActive && (status === 'needs_review' || status === 'failed') ? <><button onClick={() => { void revert(false); }}>Preview revert</button><button onClick={() => { void revert(true); }}>Apply revert</button></> : null}
        </div>
        {revertNote ? <p className="muted">{revertNote}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </div>
      {pending && isActive ? <PendingCard pending={pending} /> : null}
      <div className="card"><Timeline timeline={timeline} /></div>
    </div>
  );
}

export function App() {
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
    <div className="shell">
      <header><strong>Agent Desk</strong><span className="muted">v2</span></header>
      {error ? <p className="error banner">Can't reach the server: {error}</p> : null}
      <main>
        <section className="column">
          <StartForm active={active} onStarted={start} />
          <RunList runs={runs} selected={selected} onSelect={setSelected} />
        </section>
        <section className="column wide">
          {selected !== null ? <RunView key={selected} runId={selected} active={active} onFinished={() => { void refresh(); }} /> : <div className="card muted">Select a run, or start a new one.</div>}
        </section>
      </main>
    </div>
  );
}
