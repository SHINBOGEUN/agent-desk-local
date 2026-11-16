import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError, followRun } from './api.ts';
import type { ActiveRun, FolderListing, Pending, ProjectInfo, RunDetail, RunReport, RunRow, UsageInfo } from './api.ts';
import { applyEvents, benchSets, changePercent, emptyTimeline, formatTokens, gateSummary, minutesUntil, roleSummary, statusTone, stepDurationMs } from './model.ts';
import type { BenchSet, BenchSummary, GateResult, Timeline } from './model.ts';
import { apiErrorText, currentLang, detectLanguage, durationText, I18nContext, remainingText, setActiveLang, translate, useI18n } from './i18n.ts';
import type { I18n, Lang } from './i18n.ts';

const PROJECT_KEY = 'agent-desk.project';
const readProject = (): string => { try { return localStorage.getItem(PROJECT_KEY) ?? ''; } catch { return ''; } };
const saveProject = (value: string): void => { try { localStorage.setItem(PROJECT_KEY, value); } catch { /* storage may be unavailable */ } };
const errorText = (error: unknown): string => (error instanceof ApiError || error instanceof Error ? apiErrorText(currentLang(), error.message) : currentLang() === 'ko' ? '문제가 발생했습니다.' : 'Something went wrong');

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
  const { t, lang } = useI18n();
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
      const { runId } = await api.start({ project: project.trim(), request: request.trim(), ...(runtime ? { runtime } : {}), ...(review ? { review } : {}), language: lang });
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
      <ProjectPanel project={project} />
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

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return <div className="section"><div className="label">{title}</div><ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul></div>;
}

function ReportCard({ report, workflow }: { report: RunReport | null; workflow: string | null }) {
  const { t } = useI18n();
  if (!report) return <div className="card muted">{t('reportMissing')}</div>;
  const { answer, builder, plan, research, review } = report;
  const requirementTone = (status: string): string => (status === 'done' ? 'success' : status === 'not_done' ? 'danger' : 'warning');
  const known = (status: string): boolean => ['done', 'not_done', 'unverified'].includes(status);
  return (
    <div className="card report">
      <h2>{t('reportTitle')}{workflow ? <span className="muted"> · {workflow}</span> : null}</h2>
      {answer ? <div className="section"><div className="label">{t('answerTitle')}</div><p className="prose">{answer.answer}</p><List title={t('sources')} items={answer.sources} /></div> : null}
      {builder ? (
        <>
          <div className="section"><div className="label">{t('summaryTitle')}</div><p className="prose">{builder.summary}</p></div>
          <div className="section"><div className="label">{t('changedFiles')}</div>
            {builder.changedFiles.length ? <ul className="mono">{builder.changedFiles.map(file => <li key={file}>{file}</li>)}</ul> : <p className="muted">{t('noChangedFiles')}</p>}</div>
          {builder.commandsRun.length ? <div className="section"><div className="label">{t('commandsRun')}</div><ul className="mono">{builder.commandsRun.map((entry, index) => <li key={index}>{entry.command} <span className={`badge tone-${entry.exitCode === 0 ? 'success' : 'danger'}`}>{t('exitCode', { code: entry.exitCode })}</span></li>)}</ul></div> : null}
          {builder.requirements.length ? <div className="section"><div className="label">{t('requirementsTitle')}</div><ul>{builder.requirements.map(req => {
            const text = report.requirements?.find(item => item.id === req.id)?.text;
            return <li key={req.id}><strong>{req.id}</strong> <span className={`badge tone-${requirementTone(req.status)}`}>{known(req.status) ? t(`req_${req.status}` as 'req_done') : req.status}</span> {text ?? ''}<div className="muted">{req.evidence}</div></li>;
          })}</ul></div> : null}
        </>
      ) : null}
      {plan ? <div className="section"><div className="label">{t('planTitle')}</div><p className="prose">{plan.approach}</p><List title={t('planSteps')} items={plan.steps} /><List title={t('planRisks')} items={plan.risks} /></div> : null}
      {research?.length ? <div className="section"><div className="label">{t('researchTitle')}</div>{research.map((entry, index) => <div key={index}><strong>{entry.angle}</strong><p className="prose">{entry.summary}</p><List title={t('sources')} items={entry.sources} /></div>)}</div> : null}
      {review ? <div className="section"><div className="label">{t('reviewTitle')} <span className={`badge tone-${review.verdict === 'PASS' ? 'success' : 'danger'}`}>{['PASS', 'REDO', 'BLOCKED'].includes(review.verdict) ? t(`verdict_${review.verdict}` as 'verdict_PASS') : review.verdict}</span></div>
        {review.blocking.length ? <ul>{review.blocking.map((finding, index) => <li key={index}>{finding.file ? <span className="mono">{finding.file}{finding.line ? `:${finding.line}` : ''} </span> : null}{finding.reason}<div className="muted">{finding.evidence}</div></li>)}</ul> : null}
        <List title={t('suggestions')} items={review.optional} /></div> : null}
      {report.reviewSkipped ? <p className="muted">{t('reviewSkipped', { reason: report.reviewSkipped })}</p> : null}
      <List title={t('unverifiedTitle')} items={report.unverified ?? []} />
      <List title={t('warningsTitle')} items={report.warnings ?? []} />
      <p className="muted">{report.redo ? t('redoCount', { n: report.redo }) : ''}{report.restorePoint ? ` ${t('restorePoint', { files: report.restorePoint.files })}` : ''}</p>
    </div>
  );
}

function UsageGauge() {
  const { t, lang } = useI18n();
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try { setUsage(await api.usage()); } catch (caught) { setUsage({ limits: null, reason: errorText(caught) }); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const windowName = (minutes: number | null): string => (minutes === 300 ? t('window5h') : minutes === 10080 ? t('windowWeek') : t('windowOther', { n: minutes ?? '?' }));
  return (
    <div className="card">
      <div className="step-head"><strong>{t('usageTitle')}</strong><button className="push small" disabled={loading} onClick={() => { void load(); }}>{t('usageRefresh')}</button></div>
      {loading && !usage ? <p className="muted">{t('usageLoading')}</p> : null}
      {usage && !usage.limits ? <p className="muted">{t('usageUnavailable', { reason: usage.reason ?? '' })}</p> : null}
      {usage?.limits?.windows.map(window => {
        const left = minutesUntil(window.resetsAt, Date.now());
        const tone = window.usedPercent >= 90 ? 'danger' : window.usedPercent >= 70 ? 'warning' : 'success';
        return (
          <div key={window.kind} className="gauge">
            <div className="step-head"><span>{windowName(window.windowDurationMins)}</span><span className="muted push">{t('usageUsed', { pct: Math.round(window.usedPercent) })}{left !== null ? ` · ${t('usageResets', { n: remainingText(lang, left) })}` : ''}</span></div>
            <div className="bar"><div className={`fill tone-${tone}`} style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }} /></div>
          </div>
        );
      })}
    </div>
  );
}

function ProjectPanel({ project }: { project: string }) {
  const { t } = useI18n();
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setInfo(null); setError('');
    if (!project.trim()) return;
    const timer = setTimeout(() => { api.project(project.trim()).then(setInfo).catch((caught: unknown) => setError(errorText(caught))); }, 500);
    return () => clearTimeout(timer);
  }, [project]);
  if (!project.trim()) return null;
  if (error) return <p className="muted">{error}</p>;
  if (!info) return <p className="muted">{t('projectLoading')}</p>;
  const { config } = info;
  const none = t('cfgNone');
  const limits = config.limits;
  return (
    <details className="project-info">
      <summary>{t('projectInfo')}</summary>
      {info.errors.map((message, index) => <p key={`e${index}`} className="error">{message}</p>)}
      {info.warnings.map((message, index) => <p key={`w${index}`} className="muted">{message}</p>)}
      <dl>
        <dt>{t('cfgRuntime')}</dt><dd>{t('cfgPrimaryReview', { primary: config.runtimes?.primary ?? t('cfgDefault'), review: config.runtimes?.review ?? config.runtimes?.primary ?? t('cfgDefault') })}</dd>
        <dt>{t('cfgReview')}</dt><dd>{config.review ?? t('cfgDefault')}</dd>
        <dt>{t('cfgVerify')}</dt><dd className="mono">{config.verify?.length ? config.verify.join(', ') : none}</dd>
        <dt>{t('cfgLimits')}</dt><dd>{limits ? t('cfgLimitsText', { redo: limits.redo ?? t('cfgDefault'), tokens: limits.tokens ?? none, minutes: limits.minutes ?? none, pct: limits.codexUsagePercent ?? none }) : t('cfgDefault')}</dd>
        <dt>{t('cfgSkills')}</dt>
        <dd>{info.skills.length ? <ul>{info.skills.map(skill => <li key={skill.id}><strong>{skill.id}</strong><div className="muted">{skill.description}</div></li>)}</ul> : t('cfgNoSkills')}
          {info.skillFindings.length ? <p className="muted">{t('cfgFindings', { n: info.skillFindings.length })}</p> : null}</dd>
        <dt>{t('cfgMemory')}</dt><dd>{t('cfgMemoryCount', { n: info.memory.length })}</dd>
      </dl>
      <p className="muted">{t('cfgReadOnly')}</p>
    </details>
  );
}

function RoleTable({ timeline, detail }: { timeline: Timeline; detail: RunDetail | null }) {
  const { t, lang } = useI18n();
  const rows = roleSummary(timeline, detail?.usage ?? []);
  if (!rows.length) return null;
  return (
    <div className="card">
      <div className="label muted">{t('roleSummaryTitle')}</div>
      <table className="roles">
        <thead><tr><th>{t('colRole')}</th><th>{t('colSteps')}</th><th>{t('colTime')}</th><th>{t('colTokens')}</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.role}><td>{row.role}</td><td>{row.steps}</td><td>{durationText(lang, row.durationMs)}</td><td>{formatTokens(row.tokens)}</td></tr>)}</tbody>
      </table>
    </div>
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
      {detail && status !== 'running' ? <ReportCard report={detail.report} workflow={detail.run.workflow} /> : null}
      <RoleTable timeline={timeline} detail={detail} />
      <div className="card"><TimelineView timeline={timeline} /></div>
    </div>
  );
}

const percentText = (value: number | null): string => (value === null ? '-' : `${Math.round(value * 100)}%`);
const changeText = (change: number | null): string => (change === null ? '-' : `${change > 0 ? '+' : ''}${change}%`);

function BenchBars({ rows, format }: { rows: { label: string; value: number | null }[]; format: (value: number) => string }) {
  const top = Math.max(...rows.map(row => row.value ?? 0), 1);
  return (
    <div className="bars">
      {rows.map(row => (
        <div key={row.label} className="bar-row">
          <span className="bar-label">{row.label}</span>
          <div className="bar"><div className={`fill tone-${row.label.startsWith('v1') ? 'neutral' : 'accent'}`} style={{ width: `${((row.value ?? 0) / top) * 100}%` }} /></div>
          <span className="bar-value">{row.value === null ? '-' : format(row.value)}</span>
        </div>
      ))}
    </div>
  );
}

function BenchSetCard({ set }: { set: BenchSet }) {
  const { t } = useI18n();
  const { baseline, challengers } = set;
  const all: BenchSummary[] = baseline ? [baseline, ...challengers] : challengers;
  const first = challengers[0];
  const metrics: { label: string; read: (summary: BenchSummary) => number | null; show: (value: number | null) => string; compare: boolean }[] = [
    { label: t('mRuns'), read: s => s.runs, show: v => (v === null ? '-' : String(v)), compare: false },
    { label: t('mSuccess'), read: s => s.successRate, show: percentText, compare: false },
    { label: t('mFalse'), read: s => s.falseCompletionRate, show: percentText, compare: false },
    { label: t('mTokens'), read: s => s.meanTokens, show: v => (v === null ? '-' : formatTokens(Math.round(v))), compare: true },
    { label: t('mMinutes'), read: s => s.meanMinutes, show: v => (v === null ? '-' : v.toFixed(1)), compare: true },
    { label: t('mAgents'), read: s => s.meanAgents, show: v => (v === null ? '-' : v.toFixed(1)), compare: true },
  ];
  const taskIds = [...new Set(all.flatMap(summary => Object.keys(summary.perTask)))].sort();
  return (
    <div className="card">
      <h2>{set.id === 'hard' ? t('benchHard') : t('benchStandard')}</h2>
      {!baseline ? <p className="muted">{t('benchNoBaseline')}</p> : null}
      <table className="roles bench">
        <thead><tr><th />{all.map(summary => <th key={summary.label}>{summary.label}</th>)}{baseline && first ? <th>{t('changeLabel')}</th> : null}</tr></thead>
        <tbody>{metrics.map(metric => (
          <tr key={metric.label}>
            <td>{metric.label}</td>
            {all.map(summary => <td key={summary.label}>{metric.show(metric.read(summary))}</td>)}
            {baseline && first ? <td>{metric.compare ? changeText(changePercent(metric.read(baseline), metric.read(first))) : ''}</td> : null}
          </tr>
        ))}</tbody>
      </table>
      <div className="label muted">{t('mTokens')}</div>
      <BenchBars rows={all.map(summary => ({ label: summary.label, value: summary.meanTokens }))} format={value => formatTokens(Math.round(value))} />
      <div className="label muted">{t('mMinutes')}</div>
      <BenchBars rows={all.map(summary => ({ label: summary.label, value: summary.meanMinutes }))} format={value => value.toFixed(1)} />
      <details className="project-info">
        <summary>{t('perTask')}</summary>
        <table className="roles">
          <thead><tr><th />{all.map(summary => <th key={summary.label}>{summary.label}</th>)}</tr></thead>
          <tbody>{taskIds.map(id => <tr key={id}><td>{id}</td>{all.map(summary => { const task = summary.perTask[id]; return <td key={summary.label}>{task ? `${task.success}/${task.runs} · ${task.meanTokens === null ? '-' : formatTokens(Math.round(task.meanTokens))}` : '-'}</td>; })}</tr>)}</tbody>
        </table>
      </details>
    </div>
  );
}

function BenchmarkView() {
  const { t } = useI18n();
  const [summaries, setSummaries] = useState<BenchSummary[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api.bench().then(result => setSummaries(result.summaries)).catch((caught: unknown) => setError(errorText(caught))); }, []);
  if (error) return <p className="error">{error}</p>;
  if (!summaries) return null;
  const sets = benchSets(summaries);
  return (
    <div className="stack bench-view">
      <div className="card"><h2>{t('benchTitle')}</h2><p className="prose">{t('benchIntro')}</p></div>
      {sets.length ? sets.map(set => <BenchSetCard key={set.id} set={set} />) : <div className="card muted">{t('benchEmpty')}</div>}
      {sets.length ? <p className="muted">{t('benchCaveat')}</p> : null}
    </div>
  );
}

export function App() {
  const [lang, setLangState] = useState<Lang>(() => { let stored: string | null = null; try { stored = localStorage.getItem('agent-desk.lang'); } catch { /* storage may be unavailable */ } return detectLanguage(stored, navigator.language); });
  const setLang = (next: Lang): void => { setLangState(next); try { localStorage.setItem('agent-desk.lang', next); } catch { /* storage may be unavailable */ } };
  setActiveLang(lang);
  const i18n: I18n = { lang, setLang, t: (key, values) => translate(lang, key, values) };
  const [active, setActive] = useState<ActiveRun | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'runs' | 'bench'>('runs');

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
        <nav className="tabs"><button className={tab === 'runs' ? 'on' : ''} onClick={() => setTab('runs')}>{i18n.t('tabRuns')}</button><button className={tab === 'bench' ? 'on' : ''} onClick={() => setTab('bench')}>{i18n.t('tabBench')}</button></nav>
        <span className="push lang" role="group" aria-label={i18n.t('language')}>
          <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>English</button>
          <button className={lang === 'ko' ? 'on' : ''} onClick={() => setLang('ko')}>한국어</button>
        </span>
      </header>
      {error ? <p className="error banner">{i18n.t('serverDown')}: {error}</p> : null}
      {tab === 'bench' ? <main className="single"><BenchmarkView /></main> : <main>
        <section className="column">
          <UsageGauge />
          <StartForm active={active} onStarted={start} />
          <RunList runs={runs} selected={selected} onSelect={setSelected} />
        </section>
        <section className="column wide">
          {selected !== null ? <RunView key={selected} runId={selected} active={active} onFinished={() => { void refresh(); }} /> : <div className="card muted">{i18n.t('selectRun')}</div>}
        </section>
      </main>}
    </div>
    </I18nContext.Provider>
  );
}
