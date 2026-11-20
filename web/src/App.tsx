import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, KeyboardEvent } from 'react';
import { api, followRun } from './api.ts';
import type { ActiveRun, FolderListing, Pending, ProjectInfo, RunDetail, RunReport, RunRow, UsageInfo } from './api.ts';
import { acceptImage, applyEvents, benchSets, isBenchWorkspace, changePercent, emptyTimeline, feedbackTargets, followUpRequest, formatTokens, gateSummary, minutesUntil, modeNeeds, projectList, projectName, roleSummary, RUNTIME_MODES, sameProject, statusTone, stepDurationMs, targetLocation } from './model.ts';
import type { BenchSet, BenchSummary, GateResult, ProjectEntry, RuntimeMode, Timeline } from './model.ts';
import { detectLanguage, durationText, I18nContext, remainingText, setActiveLang, translate, useI18n } from './i18n.ts';
import type { I18n, Key, Lang } from './i18n.ts';
import { SettingsPanel } from './settings.tsx';
import { FeedbackBar, QualityView } from './quality.tsx';
import { errorText } from './util.ts';

const PROJECT_KEY = 'agent-desk.project';
const PROJECTS_KEY = 'agent-desk.projects';
const MODES_KEY = 'agent-desk.modes';
const read = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string): void => { try { localStorage.setItem(key, value); } catch { /* storage may be unavailable */ } };
const readJson = <T,>(key: string, fallback: T): T => { try { return JSON.parse(read(key) ?? '') as T; } catch { return fallback; } };
const ROLES = ['lead', 'builder', 'verifier', 'researcher'] as const;
type Installed = { codex: boolean; claude: boolean };
type Attachment = { name: string; dataUrl: string };
const readAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error ?? new Error('read failed')); reader.readAsDataURL(file); });

/** Runtime per role for a mode, before a run reports the real assignment. */
const previewRuntimes = (mode: RuntimeMode): Record<string, string> => {
  const [primary, review = primary] = mode.split('+') as [string, string?];
  return { lead: primary, builder: primary, verifier: review, researcher: primary };
};

function RuntimeTag({ kind }: { kind: string | undefined }) {
  if (!kind) return null;
  return <span className={`rt rt-${kind}`}>{kind === 'codex' ? 'Codex' : kind === 'claude' ? 'Claude' : kind}</span>;
}

function Badge({ status }: { status: string }) {
  const { t } = useI18n();
  const known = ['running', 'completed', 'needs_review', 'needs_user', 'interrupted', 'failed'].includes(status);
  return <span className={`badge tone-${statusTone(status)}`}>{known ? t(`status_${status}` as 'status_running') : status}</span>;
}

/** A gate by what it checks ("테스트"), with its G number and a one-line explanation for the tooltip. */
function useGateName(): { name: (gate: string) => string; help: (gate: string) => string } {
  const { t } = useI18n();
  const known = (gate: string): boolean => /^G[1-5]$/.test(gate);
  return { name: gate => (known(gate) ? t(`gate_${gate}` as Key) : gate), help: gate => (known(gate) ? `${gate}: ${t(`gateHelp_${gate}` as Key)}` : gate) };
}

function useGateLabel(): (gate: GateResult) => string {
  const { t } = useI18n();
  const { name } = useGateName();
  return gate => `${name(gate.gate)}${gate.attempt ? ` (${t('gateAttempt', { n: gate.attempt + 1 })})` : ''} ${gate.skipped ? t('gateSkipped') : gate.ok ? t('gateOk') : t('gateFailed')}`;
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

function TimelineView({ timeline }: { timeline: Timeline }) {
  const { t, lang } = useI18n();
  const gateLabel = useGateLabel();
  const gateName = useGateName();
  if (!timeline.steps.length) return <p className="muted">{t('waitingStep')}</p>;
  return (
    <ol className="timeline">
      {timeline.steps.map((step, index) => (
        <li key={`${step.step}-${index}`}>
          <div className="step-head"><strong>{step.step}</strong><span className="muted">{step.role}{stepDurationMs(step) !== null ? `, ${durationText(lang, stepDurationMs(step)!)}` : ''}</span>
            {step.ok === false ? <span className="badge tone-danger">{t('failedTag')}</span> : null}</div>
          <div className="chips">
            {step.gates.map((gate, gateIndex) => <span key={gateIndex} title={gateName.help(gate.gate)} className={`badge tone-${gate.skipped ? 'neutral' : gate.ok ? 'success' : 'danger'}`}>{gateLabel(gate)}</span>)}
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

/** Review suggestions with checkboxes: the picked ones become a draft of the next request (sent only when the user sends it). */
function Suggestions({ items, onFollowUp }: { items: string[]; onFollowUp?: ((items: string[]) => void) | undefined }) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<boolean[]>(() => items.map(() => true));
  if (!items.length) return null;
  if (!onFollowUp) return <List title={t('suggestions')} items={items} />;
  const chosen = items.filter((_, index) => picked[index]);
  return (
    <div className="follow-up">
      <div className="label">{t('suggestions')}</div>
      <ul className="pick-list">{items.map((item, index) => (
        <li key={index}><label><input type="checkbox" checked={picked[index] ?? false} onChange={event => { const on = event.target.checked; setPicked(list => list.map((value, at) => (at === index ? on : value))); }} /><span>{item}</span></label></li>
      ))}</ul>
      <button disabled={!chosen.length} onClick={() => onFollowUp(chosen)}>{t('followUpDraft', { n: chosen.length })}</button>
    </div>
  );
}

function ReportCard({ report, workflow, onFollowUp }: { report: RunReport | null; workflow: string | null; onFollowUp?: ((items: string[]) => void) | undefined }) {
  const { t } = useI18n();
  if (!report) return <p className="msg-meta">{t('reportMissing')}</p>;
  const { answer, builder, plan, research, review } = report;
  const requirementTone = (status: string): string => (status === 'done' ? 'success' : status === 'not_done' ? 'danger' : 'warning');
  const known = (status: string): boolean => ['done', 'not_done', 'unverified'].includes(status);
  return (
    <div className="report" data-workflow={workflow ?? undefined}>
      {answer ? <div className="section"><div className="label">{t('answerTitle')}</div><p className="prose">{answer.answer}</p><List title={t('sources')} items={answer.sources} /></div> : null}
      {builder ? (
        <>
          {report.attempts && report.attempts.length > 1 ? (
            <div className="section"><div className="label">{t('attemptsTitle')}</div>
              <ol className="attempts">{report.attempts.map(entry => (
                <li key={entry.attempt}>
                  <p className="prose">{entry.summary}</p>
                  {entry.changedFiles.length ? <div className="mono small">{entry.changedFiles.join(', ')}</div> : null}
                  {entry.sentBackFor.length ? <ul className="sent-back">{entry.sentBackFor.map((reason, index) => <li key={index}>{t('sentBack')}: {reason}</li>)}</ul> : null}
                </li>
              ))}</ol>
            </div>
          ) : <div className="section"><div className="label">{t('summaryTitle')}</div><p className="prose">{builder.summary}</p></div>}
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
        <Suggestions items={review.optional} onFollowUp={onFollowUp} /></div> : null}
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
      {usage?.claude ? (
        <div className="gauge claude-usage">
          <div className="step-head"><span className="rt rt-claude">Claude</span><span className="muted">{t('claudeUsageTitle')}</span></div>
          <p>{t('claudeUsage5h', { tokens: formatTokens(usage.claude.last5h), runs: usage.claude.runs5h })}</p>
          <p className="muted">{t('claudeUsage7d', { tokens: formatTokens(usage.claude.last7d) })}</p>
          <p className="editor-note">{t('claudeUsageNote')}</p>
        </div>
      ) : null}
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
        <dt>{t('cfgRuntime')}</dt><dd>{info.mode ? t(`mode_${info.mode}` as Key) : t('cfgPrimaryReview', { primary: config.runtimes?.primary ?? t('cfgDefault'), review: config.runtimes?.review ?? config.runtimes?.primary ?? t('cfgDefault') })}</dd>
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
        <thead><tr><th>{t('colRole')}</th><th>{t('colSteps')}</th><th>{t('colTime')}</th><th>{t('colCalls')}</th><th>{t('colNewInput')}</th><th>{t('colCached')}</th><th>{t('colOutput')}</th><th>{t('colTokens')}</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.role}><td>{row.role}</td><td>{row.steps}</td><td>{durationText(lang, row.durationMs)}</td><td>{row.calls}</td><td>{formatTokens(row.newInput)}</td><td className="muted">{formatTokens(row.cachedInput)}</td><td>{formatTokens(row.output)}</td><td>{formatTokens(row.tokens)}</td></tr>)}</tbody>
      </table>
      <p className="msg-meta">{t('tokenSplitNote')}</p>
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
      <h2>{set.id === 'hard' ? t('benchHard') : set.id === 'general' ? t('benchGeneral') : t('benchStandard')}</h2>
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


function ProjectButton({ project, on, live, onSelect, onForget }: { project: ProjectEntry; on: boolean; live: boolean; onSelect: () => void; onForget: () => Promise<void> }) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <div className="project-item confirm" role="group">
        <span className="project-text"><span className="project-name">{t('forgetQuestion', { name: project.name })}</span><span className="project-path">{t('forgetNote', { n: project.runs })}</span></span>
        <span className="confirm-actions">
          <button className="mini danger" onClick={() => { void onForget().finally(() => setConfirming(false)); }}>{t('delete')}</button>
          <button className="mini" onClick={() => setConfirming(false)}>{t('cancel')}</button>
        </span>
      </div>
    );
  }
  return (
    <div className={`project-row${on ? ' on' : ''}`}>
      <button title={project.path} className={`project-item${on ? ' on' : ''}`} onClick={onSelect}>
        <span className="project-initial" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
        <span className="project-text"><span className="project-name">{project.name}</span><span className="project-path">{project.path}</span></span>
        {live ? <span className="live-dot" aria-label={t('status_running')} /> : null}
      </button>
      {!live ? <button className="forget" aria-label={t('forgetLabel', { name: project.name })} title={t('forgetLabel', { name: project.name })} onClick={() => setConfirming(true)}>×</button> : null}
    </div>
  );
}

type Tab = 'chat' | 'bench' | 'quality';

function Sidebar({ projects, current, activeRunId, onSelect, onOpen, onForget, onForgetBench, opening, tab, onTab }: {
  projects: ProjectEntry[]; current: string; activeRunId: number | null; onSelect: (path: string) => void; onOpen: () => void;
  onForget: (project: ProjectEntry) => Promise<void>; onForgetBench: () => Promise<void>; opening: boolean; tab: Tab; onTab: (tab: Tab) => void;
}) {
  const { t, lang, setLang } = useI18n();
  const [confirmBench, setConfirmBench] = useState(false);
  const mine = projects.filter(project => !project.bench);
  const bench = projects.filter(project => project.bench);
  const benchRuns = bench.reduce((sum, project) => sum + project.runs, 0);
  const item = (project: ProjectEntry) => (
    <ProjectButton key={project.path} project={project} on={tab === 'chat' && sameProject(project.path, current)} live={project.active && activeRunId !== null}
      onSelect={() => { onSelect(project.path); onTab('chat'); }} onForget={() => onForget(project)} />
  );
  return (
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>Agent Desk</span></div>
      <div className="side-head"><span>{t('projects')}</span></div>
      <nav className="project-nav" aria-label={t('projects')}>
        {mine.map(item)}
        {!mine.length ? <p className="side-empty">{t('noProjectsYet')}</p> : null}
        {bench.length ? (
          <details className="bench-group">
            <summary>{t('benchWorkspaces', { n: bench.length })}</summary>
            {confirmBench ? (
              <div className="bench-confirm">
                <p>{t('forgetBenchQuestion', { n: benchRuns })}</p>
                <span className="confirm-actions">
                  <button className="mini danger" onClick={() => { void onForgetBench().finally(() => setConfirmBench(false)); }}>{t('delete')}</button>
                  <button className="mini" onClick={() => setConfirmBench(false)}>{t('cancel')}</button>
                </span>
              </div>
            ) : <button className="bench-clear" onClick={() => setConfirmBench(true)}>{t('forgetBench')}</button>}
            {bench.map(item)}
          </details>
        ) : null}
      </nav>
      <button className="open-project" disabled={opening} onClick={onOpen}>+ {t('openProject')}</button>
      {opening ? <p className="side-empty">{t('dialogOpen')}</p> : null}
      <div className="side-foot">
        <button className={`side-link${tab === 'quality' ? ' on' : ''}`} onClick={() => onTab('quality')}>{t('tabQuality')}</button>
        <button className={`side-link${tab === 'bench' ? ' on' : ''}`} onClick={() => onTab('bench')}>{t('tabBench')}</button>
        <span className="lang" role="group" aria-label={t('language')}>
          <button className={lang === 'ko' ? 'on' : ''} onClick={() => setLang('ko')}>한국어</button>
          <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>EN</button>
        </span>
      </div>
    </aside>
  );
}

/** One request and the team's reply. Live runs follow the event stream; finished runs load their saved report. */
function Exchange({ run, live, canResume, onResume, onPending, onTimeline, onFinished, projectSkills, onOpenTarget, onFollowUp }: {
  run: RunRow; live: boolean; canResume: boolean; onResume: (run: RunRow) => void; onPending: (pending: Pending | null) => void; onTimeline: (timeline: Timeline) => void; onFinished: () => void;
  projectSkills: string[]; onOpenTarget: (target: string) => void; onFollowUp: (runId: number, items: string[]) => void;
}) {
  const { t, lang } = useI18n();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [timeline, setTimeline] = useState<Timeline>(emptyTimeline);
  const [pending, setPending] = useState<Pending | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  const [revertNote, setRevertNote] = useState('');
  const callbacks = useRef({ onPending, onTimeline, onFinished });
  callbacks.current = { onPending, onTimeline, onFinished };
  const following = live || showSteps;
  const running = run.status === 'running';

  const reload = useCallback(async (): Promise<void> => { try { setDetail(await api.run(run.id)); } catch { /* shown as missing report */ } }, [run.id]);
  useEffect(() => { if (!running) void reload(); }, [running, reload]);
  useEffect(() => {
    if (!following) return;
    return followRun(run.id, {
      onEvent: event => setTimeline(current => applyEvents(current, [event])),
      onPending: next => { setPending(next); if (live) callbacks.current.onPending(next); },
      onDone: () => { setPending(null); if (live) { callbacks.current.onPending(null); callbacks.current.onFinished(); } void reload(); },
      onError: () => { /* EventSource retries by itself */ },
    });
  }, [following, live, run.id, reload]);
  useEffect(() => { if (live) callbacks.current.onTimeline(timeline); }, [live, timeline]);

  const status = detail?.run.status ?? run.status;
  const settings = detail?.settings ?? null;
  const runtimes = timeline.runtimes ?? settings?.runtimes;
  const resumable = !running && (status === 'interrupted' || ((status === 'needs_review' || status === 'failed') && detail?.report?.resume !== undefined));
  const current = timeline.steps.at(-1);
  const summary = gateSummary(timeline);
  const gateName = useGateName();
  const time = new Date(run.startedAt).toLocaleTimeString(lang === 'ko' ? 'ko-KR' : 'en-US', { hour: '2-digit', minute: '2-digit' });
  const revert = async (yes: boolean): Promise<void> => {
    try {
      const plan = await api.revert(run.id, yes);
      setRevertNote(t(yes ? 'revertDone' : 'revertPreview', { restore: plan.restore.length, remove: plan.remove.length }));
    } catch (caught) { setRevertNote(errorText(caught)); }
  };

  return (
    <article className="exchange">
      <div className="msg msg-user">
        <div className="bubble">{run.request}</div>
        <span className="msg-meta">{t('you')} · {time}{settings?.images ? ` · ${t('imagesAttached', { n: settings.images })}` : ''}{settings?.resumeOf ? ` · ${t('resumedFrom', { id: settings.resumeOf })}` : ''}</span>
      </div>
      <div className={`msg msg-team status-${statusTone(status)}`}>
        <div className="bubble">
          <header className="reply-head">
            <Badge status={status} />
            {detail ? <span className="msg-meta">{(() => {
              const cached = detail.usage.reduce((sum, row) => sum + (row.usage.cachedInputTokens ?? 0), 0);
              const fresh = detail.usage.reduce((sum, row) => sum + Math.max(0, (row.usage.inputTokens ?? 0) - (row.usage.cachedInputTokens ?? 0)), 0);
              return cached ? t('runMetaSplit', { id: run.id, tokens: formatTokens(detail.usageTotal), fresh: formatTokens(fresh), cached: formatTokens(cached) }) : t('runMeta', { id: run.id, tokens: formatTokens(detail.usageTotal) });
            })()}</span> : <span className="msg-meta">#{run.id}</span>}
            {!running ? <button className="link push" onClick={() => setShowSteps(value => !value)}>{showSteps ? t('hideSteps') : t('showSteps')}</button> : null}
          </header>
          {runtimes ? <div className="team-line" aria-label={t('teamUsed')}>{(['lead', 'builder', 'verifier'] as const).map(role => <span key={role} className="team-chip">{role}<RuntimeTag kind={runtimes[role]} /></span>)}{settings?.review ? <span className="team-chip">{t('reviewPolicy')} {settings.review}</span> : null}</div> : null}
          {settings?.fallback ? <p className="msg-meta warn-text">{(() => { const match = /Codex (5-hour|weekly) usage is (\d+)% \(switch at (\d+)%\)/.exec(settings.fallback); return match ? t('fallbackNote', { window: t(match[1] === 'weekly' ? 'fallbackWeekly' : 'fallback5h'), used: match[2]!, at: match[3]! }) : settings.fallback; })()}</p> : null}
          {(() => { const used = timeline.skillsRead ?? detail?.report?.skillsRead ?? []; return used.length ? <div className="team-line" aria-label={t('skillsUsed')}>{used.map((entry, index) => <span key={index} className="team-chip skill-chip">{t('skillsUsed')} {entry.skill} · {entry.role}</span>)}</div> : null; })()}
          {running ? (
            <div className="live-line">
              <span className="pulse" aria-hidden="true" />
              {current ? <span>{t('workingOn', { role: current.role, step: current.step })}</span> : <span>{t('starting')}</span>}
              {current ? <RuntimeTag kind={timeline.runtimes?.[current.role]} /> : null}
            </div>
          ) : null}
          {timeline.questions?.filter(question => question.answered).map((question, index) => (
            <div key={index} className="asked"><span className="msg-meta">{t('agentAsks', { role: question.step })} · {t('answeredTag')}</span><p>{question.question}</p></div>
          ))}
          {pending && live ? <QuestionBlock pending={pending} /> : null}
          {!running && detail?.run.reason ? <p className="reason">{detail.run.reason}</p> : null}
          {!running ? <ReportCard report={detail?.report ?? null} workflow={detail?.run.workflow ?? null} onFollowUp={items => onFollowUp(run.id, items)} /> : null}
          {!running && summary.length ? <div className="chips">{summary.map(entry => <span key={entry.gate} title={gateName.help(entry.gate)} className={`badge tone-${entry.failed ? 'danger' : 'success'}`}>{gateName.name(entry.gate)} {entry.failed ? t('gateFailedTimes', { n: entry.failed }) : t('gateOk')}</span>)}</div> : null}
          {(running || showSteps) && timeline.steps.length ? <div className="steps"><TimelineView timeline={timeline} />{!running ? <RoleTable timeline={timeline} detail={detail} /> : null}</div> : null}
          {live && running ? <div className="row"><button className="ghost danger" onClick={() => { void api.cancel(); }}>{t('stop')}</button></div> : null}
          {!running && (status === 'needs_review' || status === 'failed') ? <div className="row"><button className="ghost" onClick={() => { void revert(false); }}>{t('previewRevert')}</button><button className="ghost" onClick={() => { void revert(true); }}>{t('applyRevert')}</button></div> : null}
          {!running && detail?.report?.memorySuggestions?.length ? <MemorySuggestions project={run.project} facts={detail.report.memorySuggestions} /> : null}
          {resumable && canResume ? <div className="row"><button className="ghost" onClick={() => onResume(run)}>{t('resumeRun')}</button></div> : null}
          {revertNote ? <p className="msg-meta">{revertNote}</p> : null}
          {!running && detail ? <FeedbackBar runId={run.id} initial={detail.feedback ?? null} onOpenTarget={onOpenTarget}
            targetsFor={cause => feedbackTargets(cause, { skillsRead: (timeline.skillsRead ?? detail.report?.skillsRead ?? []).map(entry => entry.skill), projectSkills, roles: detail.steps.map(step => step.role) })} /> : null}
        </div>
        <span className="msg-meta">Agent Desk{durationOf(run, lang)}</span>
      </div>
    </article>
  );
}

function MemorySuggestions({ project, facts }: { project: string; facts: string[] }) {
  const { t } = useI18n();
  const [added, setAdded] = useState<Record<number, boolean>>({});
  const [error, setError] = useState('');
  const add = async (index: number, fact: string): Promise<void> => { try { await api.addMemory(project, fact); setAdded(current => ({ ...current, [index]: true })); setError(''); } catch (caught) { setError(errorText(caught)); } };
  return (
    <div className="memory-box">
      <strong>{t('memoryTitle')}</strong>
      <ul>{facts.map((fact, index) => <li key={index}><span>{fact}</span>{added[index] ? <span className="badge tone-success">{t('addedToMemory')}</span> : <button className="ghost" onClick={() => { void add(index, fact); }}>{t('addToMemory')}</button>}</li>)}</ul>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

const durationOf = (run: RunRow, lang: Lang): string => (run.finishedAt ? ` · ${durationText(lang, new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime())}` : '');

function QuestionBlock({ pending }: { pending: Pending }) {
  const { t } = useI18n();
  const [error, setError] = useState('');
  const send = async (answer: string): Promise<void> => { try { await api.answer(answer); } catch (caught) { setError(errorText(caught)); } };
  return (
    <div className="question" role="status">
      <strong>{t('needsAnswer')}</strong>
      <p>{pending.question}</p>
      {pending.options?.length ? <div className="row">{pending.options.map(option => <button key={option} className="option" onClick={() => { void send(option); }}>{option}</button>)}</div> : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

function TeamRail({ runtimes, timeline, info, installed, modeChoice, onEdit }: { runtimes: Record<string, string> | null; timeline: Timeline | null; info: ProjectInfo | null; installed: Installed | null; modeChoice: RuntimeMode | ''; onEdit: (role?: string) => void }) {
  const { t } = useI18n();
  const state = (role: string): 'working' | 'done' | 'idle' => {
    const steps = timeline?.steps.filter(step => step.role === role) ?? [];
    if (steps.some(step => !step.finishedAt) && !timeline?.finished) return 'working';
    return steps.length ? 'done' : 'idle';
  };
  const usesDefault = modeChoice === '' && info !== null && !info.config.mode && !info.config.runtimes;
  return (
    <aside className="rail">
      <section className="rail-block">
        <div className="rail-head"><h3>{t('teamTitle')}</h3><button className="link push" onClick={() => onEdit()}>{t('editTeam')}</button></div>
        <ul className="team">
          {ROLES.map(role => {
            const now = timeline ? state(role) : 'idle';
            return (
              <li key={role} className={`member member-${now}`} role="button" tabIndex={0} onClick={() => onEdit(role)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onEdit(role); } }}>
                <span className={`avatar avatar-${role}`} aria-hidden="true">{role.slice(0, 1).toUpperCase()}</span>
                <span className="member-text"><span className="member-name">{role}</span><span className="member-desc">{t(`role_${role}` as Key)}</span></span>
                <span className="member-side"><RuntimeTag kind={runtimes?.[role]} />{now !== 'idle' ? <span className="member-state">{now === 'working' ? t('roleWorking') : t('roleDone')}</span> : null}</span>
              </li>
            );
          })}
        </ul>
        {usesDefault && installed && !installed.claude ? <p className="rail-note">{t('modeDefaultFallback')}</p> : null}
      </section>
      <UsageGauge />
    </aside>
  );
}

function ChatView({ project, runs, active, installed, onChanged, onOpen }: { project: string; runs: RunRow[]; active: ActiveRun | null; installed: Installed | null; onChanged: () => void; onOpen: () => void }) {
  const { t, lang } = useI18n();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [liveTimeline, setLiveTimeline] = useState<Timeline | null>(null);
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [modes, setModes] = useState<Record<string, RuntimeMode | ''>>(() => readJson(MODES_KEY, {}));
  const [review, setReview] = useState<'always' | 'auto' | 'never' | 'self' | ''>('');
  const [images, setImages] = useState<Attachment[]>([]);
  const [settingsFor, setSettingsFor] = useState<{ role?: string; skill?: string } | null>(null);
  const openTarget = (target: string): void => {
    const where = targetLocation(target);
    if (!where) return;
    setSettingsFor(where.tab === 'roles' ? { role: where.id! } : where.tab === 'skills' ? { skill: where.id! } : {});
  };
  const fileInput = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const threadEnd = useRef<HTMLDivElement>(null);
  const mode = modes[project] ?? '';
  const setMode = (next: RuntimeMode | ''): void => { const all = { ...modes, [project]: next }; setModes(all); write(MODES_KEY, JSON.stringify(all)); };

  useEffect(() => {
    setInfo(null); setPending(null); setLiveTimeline(null); setError('');
    api.project(project).then(setInfo).catch(() => setInfo(null));
  }, [project]);

  const thread = useMemo(() => runs.filter(run => sameProject(run.project, project)).sort((a, b) => a.id - b.id), [runs, project]);
  const shown = thread.slice(-30);
  const activeHere = active !== null && sameProject(active.project, project);
  const activeElsewhere = active !== null && !activeHere;
  useEffect(() => { threadEnd.current?.scrollIntoView({ block: 'end' }); }, [shown.length, liveTimeline?.steps.length, pending]);

  const effectiveMode = (mode || info?.mode || null) as RuntimeMode | null;
  const missing = mode && installed ? modeNeeds(mode).filter(kind => !installed[kind]) : [];
  const runtimes = liveTimeline?.runtimes ?? (effectiveMode ? previewRuntimes(effectiveMode) : null);
  const usesDefault = mode === '' && info !== null && !info.config.mode && !info.config.runtimes;
  const railRuntimes = usesDefault && installed && !installed.claude && runtimes && !liveTimeline?.runtimes ? { ...runtimes, verifier: runtimes.builder ?? 'codex' } : runtimes;

  const addFiles = async (files: File[]): Promise<void> => {
    let next = [...images];
    for (const file of files) {
      const verdict = acceptImage(next.length, file);
      if (verdict !== 'ok') { setError(t(verdict === 'type' ? 'imageType' : verdict === 'size' ? 'imageSize' : 'imageCount')); continue; }
      try { next = [...next, { name: file.name || `image-${next.length + 1}`, dataUrl: await readAsDataUrl(file) }]; } catch (caught) { setError(errorText(caught)); }
    }
    setImages(next);
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...event.clipboardData.files].filter(file => file.type.startsWith('image/'));
    if (files.length) { event.preventDefault(); void addFiles(files); }
  };
  const askNotifications = (): void => { try { if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission(); } catch { /* not supported */ } };
  const startRun = async (request: string, extra: { resumeOf?: number } = {}): Promise<void> => {
    askNotifications();
    await api.start({ project, request, ...(mode ? { mode } : {}), ...(review ? { review } : {}), ...(images.length && !extra.resumeOf ? { images: images.map(image => image.dataUrl) } : {}), ...extra, language: lang });
  };
  const submit = async (): Promise<void> => {
    const value = text.trim();
    if (!value || busy) return;
    setError('');
    setBusy(true);
    try {
      if (pending && activeHere) await api.answer(value);
      else { await startRun(value); setImages([]); }
      setText('');
      onChanged();
    } catch (caught) { setError(errorText(caught)); } finally { setBusy(false); }
  };
  const resume = async (run: RunRow): Promise<void> => {
    setError('');
    try { await startRun(run.request, { resumeOf: run.id }); onChanged(); } catch (caught) { setError(errorText(caught)); }
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
  };
  const answering = pending !== null && activeHere;
  const blocked = (activeHere && !answering) || activeElsewhere || missing.length > 0;

  return (
    <div className="workspace">
      <section className="chat">
        <header className="chat-head">
          <div className="chat-title">
            <h1>{projectName(project)}</h1>
            <button className="path" title={t('changeProject')} onClick={onOpen}>{project}</button>
          </div>
          <div className="chat-controls">
            <label className="control">{t('teamLabel')}
              <select value={mode} onChange={event => setMode(event.target.value as RuntimeMode | '')}>
                <option value="">{t('modeFromConfig')}{info?.mode ? ` (${t(`mode_${info.mode}` as Key)})` : ''}</option>
                {RUNTIME_MODES.map(option => <option key={option} value={option}>{t(`mode_${option}` as Key)}</option>)}
              </select>
            </label>
            <label className="control">{t('reviewPolicy')}
              <select value={review} onChange={event => setReview(event.target.value as typeof review)}>
                <option value="">{t('fromConfig')}</option><option value="auto">{t('reviewAuto')}</option><option value="always">{t('reviewAlways')}</option><option value="never">{t('reviewNever')}</option><option value="self">{t('reviewSelf')}</option>
              </select>
            </label>
          </div>
        </header>
        <div className="thread" aria-live="polite">
          {thread.length > shown.length ? <p className="thread-note">{t('olderRuns', { n: thread.length - shown.length })}</p> : null}
          {!shown.length ? (
            <div className="thread-empty">
              <h2>{t('chatEmptyTitle', { name: projectName(project) })}</h2>
              <p>{t('chatEmptyHint')}</p>
              <ProjectPanel project={project} />
            </div>
          ) : shown.map(run => (
            <Exchange key={run.id} run={run} live={active?.runId === run.id} canResume={active === null} onResume={run => { void resume(run); }}
              onPending={setPending} onTimeline={setLiveTimeline} onFinished={() => { setLiveTimeline(null); onChanged(); }}
              projectSkills={info?.skills.map(skill => skill.id) ?? []} onOpenTarget={openTarget}
              onFollowUp={(runId, items) => { const draft = followUpRequest(runId, items, lang); setText(current => (current.trim() ? `${current.trimEnd()}\n\n${draft}` : draft)); requestAnimationFrame(() => { composer.current?.focus(); composer.current?.scrollIntoView({ block: 'nearest' }); }); }} />
          ))}
          <div ref={threadEnd} />
        </div>
        <div className="composer-wrap">
          {activeElsewhere && active ? <p className="composer-note">{t('otherProjectActive', { id: active.runId, name: projectName(active.project) })}</p> : null}
          {activeHere && !answering && active ? <p className="composer-note">{t('composerBusy', { id: active.runId })}</p> : null}
          {missing.length ? <p className="composer-note warn">{t('modeMissing', { name: missing.map(kind => (kind === 'codex' ? 'Codex' : 'Claude')).join(', ') })}</p> : null}
          {error ? <p className="composer-note error">{error}</p> : null}
          {images.length ? (
            <div className="attachments">{images.map((image, index) => (
              <figure key={index} className="thumb"><img src={image.dataUrl} alt={image.name} /><button className="thumb-remove" aria-label={t('removeImage')} title={t('removeImage')} onClick={() => setImages(current => current.filter((_, i) => i !== index))}>×</button></figure>
            ))}</div>
          ) : null}
          <div className={`composer${answering ? ' answering' : ''}`}>
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void addFiles(files); }} />
            <button className="attach" disabled={blocked || answering} aria-label={t('attachImage')} title={t('attachImage')} onClick={() => fileInput.current?.click()}>
              <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M13.5 6.5 7.8 12.2a1.6 1.6 0 0 0 2.3 2.3l6-6a3.2 3.2 0 0 0-4.5-4.5l-6 6a4.8 4.8 0 0 0 6.8 6.8l5.1-5.1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
            <textarea ref={composer} value={text} onChange={event => setText(event.target.value)} onKeyDown={onKey} onPaste={onPaste} rows={2} disabled={blocked}
              placeholder={answering ? t('composerAnswer') : t('composerPlaceholder')} aria-label={answering ? t('composerAnswer') : t('composerPlaceholder')} />
            <button className="send" disabled={blocked || busy || !text.trim()} onClick={() => { void submit(); }}>{answering ? t('sendAnswer') : t('sendRequest')}</button>
          </div>
          <p className="composer-hint">{t('sendHint')}</p>
        </div>
      </section>
      <TeamRail runtimes={railRuntimes} timeline={liveTimeline} info={info} installed={installed} modeChoice={mode} onEdit={role => setSettingsFor(role ? { role } : {})} />
      {settingsFor ? <SettingsPanel project={project} runtimes={railRuntimes} busy={activeHere} initialRole={settingsFor.role} initialSkill={settingsFor.skill} onClose={() => setSettingsFor(null)} onSaved={() => { api.project(project).then(setInfo).catch(() => undefined); }} /> : null}
    </div>
  );
}

function Welcome({ onOpen, opening }: { onOpen: () => void; opening: boolean }) {
  const { t } = useI18n();
  return (
    <div className="welcome">
      <div className="welcome-art" aria-hidden="true">
        <span className="node node-lead">L</span><span className="node node-builder">B</span><span className="node node-verifier">V</span>
        <svg viewBox="0 0 240 120"><path d="M40 60 C 90 10, 150 10, 200 60" /><path d="M40 60 C 90 110, 150 110, 200 60" /></svg>
      </div>
      <h1>{t('startTitle')}</h1>
      <p>{t('startHint')}</p>
      <button className="primary" disabled={opening} onClick={onOpen}>{t('openProject')}</button>
    </div>
  );
}

export function App() {
  const [lang, setLangState] = useState<Lang>(() => detectLanguage(read('agent-desk.lang'), navigator.language));
  const setLang = (next: Lang): void => { setLangState(next); write('agent-desk.lang', next); };
  setActiveLang(lang);
  const i18n: I18n = { lang, setLang, t: (key, values) => translate(lang, key, values) };
  const [active, setActive] = useState<ActiveRun | null>(null);
  const [installed, setInstalled] = useState<Installed | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [saved, setSaved] = useState<string[]>(() => readJson<string[]>(PROJECTS_KEY, []));
  const [project, setProject] = useState<string>(() => read(PROJECT_KEY) ?? '');
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('chat');
  const [opening, setOpening] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const state = await api.state();
      setActive(state.active);
      if (state.installed) setInstalled(state.installed);
      setRuns((await api.runs()).runs);
      setError('');
    } catch (caught) { setError(errorText(caught)); }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const choose = (path: string): void => {
    setProject(path); write(PROJECT_KEY, path); setTab('chat');
    setSaved(current => { const next = current.some(item => sameProject(item, path)) ? current : [path, ...current].slice(0, 30); write(PROJECTS_KEY, JSON.stringify(next)); return next; });
  };
  /** Opens the computer's own folder window; where that is not available the in-page browser is used instead. */
  const open = async (): Promise<void> => {
    setOpening(true);
    try {
      const result = await api.pickFolder(project, i18n.t('dialogTitle'));
      if (!result.supported) setBrowsing(true);
      else if (result.path) choose(result.path);
    } catch (caught) { setError(errorText(caught)); } finally { setOpening(false); }
  };

  const forget = async (entry: ProjectEntry): Promise<void> => {
    try {
      await api.deleteHistory({ project: entry.path });
      setSaved(current => { const next = current.filter(item => !sameProject(item, entry.path)); write(PROJECTS_KEY, JSON.stringify(next)); return next; });
      if (sameProject(project, entry.path)) { setProject(''); write(PROJECT_KEY, ''); }
      await refresh();
    } catch (caught) { setError(errorText(caught)); }
  };
  const forgetBench = async (): Promise<void> => {
    try {
      await api.deleteHistory({ benchWorkspaces: true });
      setSaved(current => { const next = current.filter(item => !isBenchWorkspace(item)); write(PROJECTS_KEY, JSON.stringify(next)); return next; });
      if (isBenchWorkspace(project)) { setProject(''); write(PROJECT_KEY, ''); }
      await refresh();
    } catch (caught) { setError(errorText(caught)); }
  };
  // A waiting question: browser notification (if allowed) and a marked tab title until it is answered.
  const waiting = active?.pending?.question ?? null;
  useEffect(() => {
    if (!waiting || !active) { document.title = 'Agent Desk'; return; }
    document.title = `(${i18n.t('titleWaiting')}) Agent Desk`;
    try {
      if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
        const notice = new Notification(i18n.t('notifyTitle', { name: projectName(active.project) }), { body: waiting.slice(0, 200), tag: `agent-desk-${active.runId}` });
        notice.onclick = () => { window.focus(); choose(active.project); notice.close(); };
      }
    } catch { /* notifications unavailable */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting]);
  const projects = projectList(saved, runs, active?.project ?? null);
  return (
    <I18nContext.Provider value={i18n}>
      <div className="app">
        <Sidebar projects={projects} current={project} activeRunId={active?.runId ?? null} onSelect={choose} onOpen={() => { void open(); }} onForget={forget} onForgetBench={forgetBench} opening={opening} tab={tab} onTab={setTab} />
        <main className="main">
          {error ? <p className="banner">{i18n.t('serverDown')}: {error}</p> : null}
          {tab === 'bench' ? <div className="bench-page"><BenchmarkView /></div>
            : tab === 'quality' ? <div className="bench-page"><QualityView project={project} /></div>
            : project ? <ChatView key={project} project={project} runs={runs} active={active} installed={installed} onChanged={() => { void refresh(); }} onOpen={() => { void open(); }} />
              : <Welcome onOpen={() => { void open(); }} opening={opening} />}
        </main>
        {browsing ? <FolderPicker start={project} onPick={path => { choose(path); setBrowsing(false); }} onClose={() => setBrowsing(false)} /> : null}
      </div>
    </I18nContext.Provider>
  );
}
