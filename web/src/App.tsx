import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, KeyboardEvent } from 'react';
import { api, followRun } from './api.ts';
import type { ActiveRun, FolderListing, Pending, ProjectInfo, RunDetail, RunReport, RunRow, UsageInfo } from './api.ts';
import { acceptImage, applyEvents, benchSets, isBenchWorkspace, changePercent, emptyTimeline, feedbackTargets, followUpRequest, formatTokens, gateSummary, minutesUntil, modeNeeds, projectList, projectName, roleSummary, RUNTIME_MODES, sameProject, statusTone, stepDurationMs, targetLocation } from './model.ts';
import type { BenchSet, BenchSummary, GateResult, ProjectEntry, RuntimeMode, Timeline } from './model.ts';
import { detectLanguage, durationText, I18nContext, remainingText, serverLines, setActiveLang, translate, useI18n } from './i18n.ts';
import type { I18n, Key, Lang } from './i18n.ts';
import { SettingsPanel } from './settings.tsx';
import { FeedbackBar, QualityView } from './quality.tsx';
import { NotesView } from './notes.tsx';
import { AgentScene, RoleLanes } from './agent-scene.tsx';
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
  const { answer, builder } = report;
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
      <List title={t('unverifiedTitle')} items={report.unverified ?? []} />
      <List title={t('warningsTitle')} items={report.warnings ?? []} />
      <p className="muted">{report.redo ? t('redoCount', { n: report.redo }) : ''}{report.restorePoint ? ` ${t('restorePoint', { files: report.restorePoint.files })}` : ''}</p>
    </div>
  );
}

/** The longer, secondary parts of a report (plan, research, review and its suggestions), shown beside the result. */
function ReportExtras({ report, onFollowUp }: { report: RunReport | null; onFollowUp?: ((items: string[]) => void) | undefined }) {
  const { t } = useI18n();
  if (!report) return null;
  const { plan, research, review } = report;
  if (!plan && !research?.length && !review && !report.reviewSkipped) return null;
  return (
    <div className="report report-extras">
      {plan ? <div className="section"><div className="label">{t('planTitle')}</div><p className="prose">{plan.approach}</p><List title={t('planSteps')} items={plan.steps} /><List title={t('planRisks')} items={plan.risks} /></div> : null}
      {research?.length ? <div className="section"><div className="label">{t('researchTitle')}</div>{research.map((entry, index) => <div key={index}><strong>{entry.angle}</strong><p className="prose">{entry.summary}</p><List title={t('sources')} items={entry.sources} /></div>)}</div> : null}
      {review ? <div className="section"><div className="label">{t('reviewTitle')} <span className={`badge tone-${review.verdict === 'PASS' ? 'success' : 'danger'}`}>{['PASS', 'REDO', 'BLOCKED'].includes(review.verdict) ? t(`verdict_${review.verdict}` as 'verdict_PASS') : review.verdict}</span></div>
        {review.blocking.length ? <ul>{review.blocking.map((finding, index) => <li key={index}>{finding.file ? <span className="mono">{finding.file}{finding.line ? `:${finding.line}` : ''} </span> : null}{finding.reason}<div className="muted">{finding.evidence}</div></li>)}</ul> : null}
        <Suggestions items={review.optional} onFollowUp={onFollowUp} /></div> : null}
      {report.reviewSkipped ? <p className="muted">{t('reviewSkipped', { reason: report.reviewSkipped })}</p> : null}
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
      {serverLines(info.errors).map((message, index) => <p key={`e${index}`} className="error">{message}</p>)}
      {serverLines(info.warnings).map((message, index) => <p key={`w${index}`} className="muted">{message}</p>)}
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


type Tab = 'chat' | 'bench' | 'quality' | 'notes';
const STAGE_KEY = 'agent-desk.stage';

/** The busiest Codex window as one short line in the top bar; opening it shows the full gauge. */
function UsageInline() {
  const { t, lang } = useI18n();
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  useEffect(() => { api.usage().then(setUsage).catch(() => setUsage(null)); }, []);
  const windows = usage?.limits?.windows ?? [];
  const top = windows.reduce<(typeof windows)[number] | null>((best, entry) => (!best || entry.usedPercent > best.usedPercent ? entry : best), null);
  const label = top ? t('usageShort', { window: top.windowDurationMins === 10080 ? (lang === 'ko' ? '주간' : 'week') : '5h', pct: Math.round(top.usedPercent) }) : t('usageNone');
  const tone = !top ? 'muted' : top.usedPercent >= 90 ? 'danger' : top.usedPercent >= 70 ? 'warning' : 'success';
  return (
    <details className="usage-inline">
      <summary><span className={`usage-dot tone-${tone}`} aria-hidden="true" />{label}</summary>
      <div className="usage-pop"><UsageGauge /></div>
    </details>
  );
}

function TopBar({ projects, current, activeRunId, onSelect, onOpen, onForget, onForgetBench, opening, tab, onTab }: {
  projects: ProjectEntry[]; current: string; activeRunId: number | null; onSelect: (path: string) => void; onOpen: () => void;
  onForget: (project: ProjectEntry) => Promise<void>; onForgetBench: () => Promise<void>; opening: boolean; tab: Tab; onTab: (tab: Tab) => void;
}) {
  const { t, lang, setLang } = useI18n();
  const [confirm, setConfirm] = useState<'project' | 'bench' | null>(null);
  const mine = projects.filter(project => !project.bench);
  const bench = projects.filter(project => project.bench);
  const benchRuns = bench.reduce((sum, project) => sum + project.runs, 0);
  const entry = projects.find(project => sameProject(project.path, current)) ?? null;
  const live = (project: ProjectEntry): boolean => project.active && activeRunId !== null;
  const option = (project: ProjectEntry) => <option key={project.path} value={project.path}>{project.name}{live(project) ? ` · ${t('status_running')}` : ''}</option>;
  const tabs: [Tab, Key][] = [['chat', 'tabRuns'], ['notes', 'tabNotes'], ['quality', 'tabQuality'], ['bench', 'tabBench']];
  return (
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>Agent Desk</span></div>
      <div className="project-pick">
        <select aria-label={t('projectSelect')} title={current} value={entry?.path ?? ''} disabled={opening}
          onChange={event => { const value = event.target.value; setConfirm(null); if (value === '__open') onOpen(); else if (value === '__bench') setConfirm('bench'); else if (value) { onSelect(value); onTab('chat'); } }}>
          {!entry ? <option value="">{t('projectSelect')}</option> : null}
          <option value="__open">+ {t('openProject')}</option>
          {mine.length ? <optgroup label={t('projects')}>{mine.map(option)}</optgroup> : null}
          {/* benchmark workspaces are many and rarely opened: listed only while one is open, otherwise one line to clear them */}
          {bench.length ? (
            <optgroup label={t('benchWorkspaces', { n: bench.length })}>
              {entry?.bench ? bench.map(option) : null}
              <option value="__bench">{t('forgetBench')} ({bench.length})</option>
            </optgroup>
          ) : null}
        </select>
        <button className="ghost small open-btn" disabled={opening} title={t('openProject')} onClick={() => { setConfirm(null); onOpen(); }}>+ {t('openProjectShort')}</button>
        {entry && !live(entry) ? <button className="icon-btn" title={t('forgetCurrent')} aria-label={t('forgetCurrent')} onClick={() => setConfirm(entry.bench ? 'bench' : 'project')}>×</button> : null}
        {confirm ? (
          <div className="topbar-confirm" role="group">
            <span>{confirm === 'bench' ? t('forgetBenchQuestion', { n: benchRuns }) : entry ? `${t('forgetQuestion', { name: entry.name })} ${t('forgetNote', { n: entry.runs })}` : ''}</span>
            <button className="mini danger" onClick={() => { const job = confirm === 'bench' ? onForgetBench() : entry ? onForget(entry) : Promise.resolve(); void job.finally(() => setConfirm(null)); }}>{t('delete')}</button>
            <button className="mini" onClick={() => setConfirm(null)}>{t('cancel')}</button>
          </div>
        ) : null}
      </div>
      <nav className="tabs" aria-label="Agent Desk">
        {tabs.map(([id, key]) => <button key={id} className={tab === id ? 'on' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => onTab(id)}>{t(key)}</button>)}
      </nav>
      <div className="topbar-side">
        <UsageInline />
        <span className="lang" role="group" aria-label={t('language')}>
          <button className={lang === 'ko' ? 'on' : ''} onClick={() => setLang('ko')}>한국어</button>
          <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>EN</button>
        </span>
      </div>
    </header>
  );
}

interface RunData { detail: RunDetail | null; timeline: Timeline; pending: Pending | null }

/** Follows one run: its event stream (replayed for finished runs) and its saved detail once it is not running. */
function useRunFollow(run: RunRow | null, onDone?: () => void): RunData {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [timeline, setTimeline] = useState<Timeline>(emptyTimeline);
  const [pending, setPending] = useState<Pending | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const id = run?.id ?? null;
  const running = run?.status === 'running';
  useEffect(() => { setDetail(null); setTimeline(emptyTimeline); setPending(null); }, [id]);
  const reload = useCallback(async (): Promise<void> => { if (id === null) return; try { setDetail(await api.run(id)); } catch { /* shown as missing report */ } }, [id]);
  useEffect(() => { if (id !== null && !running) void reload(); }, [id, running, reload]);
  useEffect(() => {
    if (id === null) return;
    return followRun(id, {
      onEvent: event => setTimeline(current => applyEvents(current, [event])),
      onPending: setPending,
      onDone: () => { setPending(null); done.current?.(); void reload(); },
      onError: () => { /* EventSource retries by itself */ },
    });
  }, [id, reload]);
  return { detail, timeline, pending };
}

/** The selected run: what was asked, the agent scene or role timeline, and the result with its follow-up actions. */
function RunPane({ run, data, live, canResume, onResume, projectSkills, onOpenTarget, onFollowUp }: {
  run: RunRow; data: RunData; live: boolean; canResume: boolean; onResume: (run: RunRow) => void;
  projectSkills: string[]; onOpenTarget: (target: string) => void; onFollowUp: (runId: number, items: string[]) => void;
}) {
  const { t, lang } = useI18n();
  const { detail, timeline, pending } = data;
  const [view, setView] = useState<'scene' | 'lanes' | 'hidden'>(() => { const saved = read(STAGE_KEY); return saved === 'lanes' || saved === 'hidden' ? saved : 'scene'; });
  const [revertNote, setRevertNote] = useState('');
  const [tab, setTab] = useState<'result' | 'review' | 'steps' | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);
  useEffect(() => { setRevertNote(''); setTab(null); setRequestOpen(false); }, [run.id]);
  const pick = (next: 'scene' | 'lanes' | 'hidden'): void => { setView(next); write(STAGE_KEY, next); };
  const status = detail?.run.status ?? run.status;
  const running = status === 'running';
  const settings = detail?.settings ?? null;
  const runtimes = timeline.runtimes ?? settings?.runtimes;
  const resumable = !running && (status === 'interrupted' || ((status === 'needs_review' || status === 'failed') && detail?.report?.resume !== undefined));
  const current = timeline.steps.at(-1);
  const summary = gateSummary(timeline);
  const report = detail?.report ?? null;
  const hasExtras = !!(report && (report.plan || report.research?.length || report.review || report.reviewSkipped));
  // while running only the steps exist; afterwards the result opens first
  const shownTab = running ? 'steps' : tab ?? 'result';
  const longRequest = run.request.length > 160 || run.request.split('\n').length > 3;
  const gateName = useGateName();
  const skills = timeline.skillsRead ?? detail?.report?.skillsRead ?? [];
  const time = new Date(run.startedAt).toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const revert = async (yes: boolean): Promise<void> => {
    try {
      const plan = await api.revert(run.id, yes);
      setRevertNote(t(yes ? 'revertDone' : 'revertPreview', { restore: plan.restore.length, remove: plan.remove.length }));
    } catch (caught) { setRevertNote(errorText(caught)); }
  };
  const tokens = ((): string => {
    if (!detail) return '';
    const cached = detail.usage.reduce((sum, row) => sum + (row.usage.cachedInputTokens ?? 0), 0);
    const fresh = detail.usage.reduce((sum, row) => sum + Math.max(0, (row.usage.inputTokens ?? 0) - (row.usage.cachedInputTokens ?? 0)), 0);
    return cached ? t('runMetaSplit', { id: run.id, tokens: formatTokens(detail.usageTotal), fresh: formatTokens(fresh), cached: formatTokens(cached) }) : t('runMeta', { id: run.id, tokens: formatTokens(detail.usageTotal) });
  })();
  return (
    <section className={`run-pane status-${statusTone(status)}`} aria-label={`#${run.id}`}>
      <header className="run-head">
        <div className="run-line"><span className="run-id">#{run.id}</span><Badge status={status} /><span className="muted">{time}{durationOf(run, lang)}</span>{tokens ? <span className="muted push">{tokens}</span> : null}</div>
        <h1 className={`run-request${longRequest && !requestOpen ? ' clamped' : ''}`}>{run.request}</h1>
        {longRequest ? <button className="link" onClick={() => setRequestOpen(open => !open)}>{requestOpen ? t('showLess') : t('showMore')}</button> : null}
        <div className="team-line">
          {runtimes ? (['lead', 'builder', 'verifier'] as const).map(role => <span key={role} className="team-chip">{role}<RuntimeTag kind={runtimes[role]} /></span>) : null}
          {settings?.review ? <span className="team-chip">{t('reviewPolicy')} {settings.review}</span> : null}
          {settings?.images ? <span className="team-chip">{t('imagesAttached', { n: settings.images })}</span> : null}
          {settings?.resumeOf ? <span className="team-chip">{t('resumedFrom', { id: settings.resumeOf })}</span> : null}
          {skills.map((entry, index) => <span key={index} className="team-chip skill-chip">{t('skillsUsed')} {entry.skill} · {entry.role}</span>)}
        </div>
        {settings?.fallback ? <p className="msg-meta warn-text">{(() => { const match = /Codex (5-hour|weekly) usage is (\d+)% \(switch at (\d+)%\)/.exec(settings.fallback); return match ? t('fallbackNote', { window: t(match[1] === 'weekly' ? 'fallbackWeekly' : 'fallback5h'), used: match[2]!, at: match[3]! }) : settings.fallback; })()}</p> : null}
      </header>
      <div className={`stage${view === 'hidden' ? ' folded' : ''}`}>
        <div className="stage-head">
          <div className="seg" role="group" aria-label={t('viewScene')}>
            <button className={view === 'scene' ? 'on' : ''} aria-pressed={view === 'scene'} onClick={() => pick('scene')}>{t('viewScene')}</button>
            <button className={view === 'lanes' ? 'on' : ''} aria-pressed={view === 'lanes'} onClick={() => pick('lanes')}>{t('viewLanes')}</button>
            <button className={view === 'hidden' ? 'on' : ''} aria-pressed={view === 'hidden'} onClick={() => pick('hidden')}>{t('stageFold')}</button>
          </div>
          {running ? (
            <div className="live-line">
              <span className="pulse" aria-hidden="true" />
              {current ? <span>{t('workingOn', { role: current.role, step: current.step })}</span> : <span>{t('starting')}</span>}
              {current ? <RuntimeTag kind={timeline.runtimes?.[current.role]} /> : null}
            </div>
          ) : null}
          {live && running ? <button className="ghost danger push" onClick={() => { void api.cancel(); }}>{t('stop')}</button> : null}
        </div>
        {view === 'scene' ? <AgentScene timeline={timeline} runtimes={runtimes} asking={pending !== null && live} live={running} /> : view === 'lanes' ? <RoleLanes timeline={timeline} runtimes={runtimes} live={running} /> : null}
      </div>
      {pending && live ? <QuestionBlock pending={pending} /> : null}
      {!running ? (
        // the outcome in one strip: what happened, which checks ran, what you can do next
        <div className={`outcome status-${statusTone(status)}`}>
          {detail?.run.reason ? <p className="reason">{detail.run.reason}</p> : null}
          <div className="outcome-row">
            {summary.length ? <div className="chips">{summary.map(entry => {
              // a check that only ever skipped did not pass: say so (no "tests passed" when no test ran)
              const skippedOnly = !entry.failed && !entry.ok && entry.skipped > 0;
              return <span key={entry.gate} title={gateName.help(entry.gate)} className={`badge tone-${entry.failed ? 'danger' : skippedOnly ? 'neutral' : 'success'}`}>{gateName.name(entry.gate)} {entry.failed ? t('gateFailedTimes', { n: entry.failed }) : skippedOnly ? t('gateSkipped') : t('gateOk')}</span>;
            })}</div> : null}
            <div className="outcome-actions">
              {resumable && canResume ? <button className="ghost" onClick={() => onResume(run)}>{t('resumeRun')}</button> : null}
              {status === 'needs_review' || status === 'failed' ? <><button className="ghost" onClick={() => { void revert(false); }}>{t('previewRevert')}</button><button className="ghost" onClick={() => { void revert(true); }}>{t('applyRevert')}</button></> : null}
            </div>
          </div>
          {revertNote ? <p className="msg-meta">{revertNote}</p> : null}
        </div>
      ) : null}
      {timeline.steps.length || !running ? (
        <div className="run-tabs">
          <div className="tab-row" role="tablist">
            {([['result', t('tabResult'), running], ['review', t('tabReview', { n: report?.review?.optional.length ?? 0 }), running || !hasExtras], ['steps', t('viewSteps'), !timeline.steps.length]] as const).map(([id, label, disabled]) => (
              <button key={id} role="tab" aria-selected={shownTab === id} className={shownTab === id ? 'on' : ''} disabled={disabled} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>
          <div className="tab-body" role="tabpanel">
            {shownTab === 'result' ? (
              <>
                <ReportCard report={report} workflow={detail?.run.workflow ?? null} onFollowUp={items => onFollowUp(run.id, items)} />
                {report?.memorySuggestions?.length ? <MemorySuggestions project={run.project} facts={report.memorySuggestions} runId={run.id} /> : null}
                {detail ? <FeedbackBar runId={run.id} initial={detail.feedback ?? null} onOpenTarget={onOpenTarget}
                  targetsFor={cause => feedbackTargets(cause, { skillsRead: skills.map(entry => entry.skill), projectSkills, roles: detail.steps.map(step => step.role) })} /> : null}
              </>
            ) : shownTab === 'review' ? (
              <ReportExtras report={report} onFollowUp={items => onFollowUp(run.id, items)} />
            ) : (
              <div className="steps">
                {timeline.questions?.filter(question => question.answered).map((question, index) => (
                  <div key={index} className="asked"><span className="msg-meta">{t('agentAsks', { role: question.step })} · {t('answeredTag')}</span><p>{question.question}</p></div>
                ))}
                <TimelineView timeline={timeline} />{!running ? <RoleTable timeline={timeline} detail={detail} /> : null}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function MemorySuggestions({ project, facts, runId }: { project: string; facts: string[]; runId: number }) {
  const { t, lang } = useI18n();
  const [added, setAdded] = useState<Record<number, boolean>>({});
  const [error, setError] = useState('');
  const add = async (index: number, fact: string): Promise<void> => { try { await api.addMemory(project, fact, runId, lang); setAdded(current => ({ ...current, [index]: true })); setError(''); } catch (caught) { setError(errorText(caught)); } };
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

/** The run view: the selected run on the left, the conversation and composer on the right. */
function RunsView({ project, runs, active, installed, onChanged, onOpen }: { project: string; runs: RunRow[]; active: ActiveRun | null; installed: Installed | null; onChanged: () => void; onOpen: () => void }) {
  const { t, lang } = useI18n();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [modes, setModes] = useState<Record<string, RuntimeMode | ''>>(() => readJson(MODES_KEY, {}));
  const [review, setReview] = useState<'always' | 'auto' | 'never' | 'self' | ''>('');
  const [images, setImages] = useState<Attachment[]>([]);
  const [settingsFor, setSettingsFor] = useState<{ role?: string; skill?: string } | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
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
    setError(''); setSelectedId(null);
    api.project(project).then(setInfo).catch(() => setInfo(null));
  }, [project]);

  const thread = useMemo(() => runs.filter(run => sameProject(run.project, project)).sort((a, b) => a.id - b.id), [runs, project]);
  const shown = thread.slice(-30);
  const activeHere = active !== null && sameProject(active.project, project);
  const activeElsewhere = active !== null && !activeHere;
  const activeRow = activeHere ? thread.find(run => run.id === active.runId) ?? null : null;
  // A new run in this project takes the left pane; otherwise the chosen run, or the latest one.
  const lastActive = useRef<number | null>(null);
  useEffect(() => { if (activeRow && lastActive.current !== activeRow.id) { lastActive.current = activeRow.id; setSelectedId(activeRow.id); } }, [activeRow]);
  const selected = thread.find(run => run.id === selectedId) ?? activeRow ?? thread.at(-1) ?? null;
  const liveData = useRunFollow(activeRow, onChanged);
  const otherData = useRunFollow(selected && selected.id !== activeRow?.id ? selected : null);
  const selectedData = selected && selected.id === activeRow?.id ? liveData : otherData;
  const pending = activeRow ? liveData.pending : null;
  useEffect(() => { threadEnd.current?.scrollIntoView({ block: 'end' }); }, [shown.length, pending]);

  const effectiveMode = (mode || info?.mode || null) as RuntimeMode | null;
  const missing = mode && installed ? modeNeeds(mode).filter(kind => !installed[kind]) : [];
  const liveRuntimes = activeRow ? liveData.timeline.runtimes : undefined;
  const runtimes = liveRuntimes ?? (effectiveMode ? previewRuntimes(effectiveMode) : null);
  const usesDefault = mode === '' && info !== null && !info.config.mode && !info.config.runtimes;
  const teamRuntimes = usesDefault && installed && !installed.claude && runtimes && !liveRuntimes ? { ...runtimes, verifier: runtimes.builder ?? 'codex' } : runtimes;

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
  const answering = pending !== null && activeHere;
  const submit = async (): Promise<void> => {
    const value = text.trim();
    if (!value || busy) return;
    setError('');
    setBusy(true);
    try {
      if (answering) await api.answer(value);
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
  const followUp = (runId: number, items: string[]): void => {
    const draft = followUpRequest(runId, items, lang);
    setText(current => (current.trim() ? `${current.trimEnd()}\n\n${draft}` : draft));
    requestAnimationFrame(() => { composer.current?.focus(); composer.current?.scrollIntoView({ block: 'nearest' }); });
  };
  const blocked = (activeHere && !answering) || activeElsewhere || missing.length > 0;
  const replyLine = (run: RunRow): string => {
    if (run.id === activeRow?.id) { const step = liveData.timeline.steps.at(-1); return step ? t('workingOn', { role: step.role, step: step.step }) : t('starting'); }
    return run.reason ?? '';
  };

  return (
    <div className="workspace">
      <div className="run-side">
        {selected ? <RunPane key={selected.id} run={selected} data={selectedData} live={selected.id === activeRow?.id} canResume={active === null} onResume={run => { void resume(run); }}
          projectSkills={info?.skills.map(skill => skill.id) ?? []} onOpenTarget={openTarget} onFollowUp={followUp} />
          : <div className="run-empty"><h2>{t('chatEmptyTitle', { name: projectName(project) })}</h2><p>{t('chatEmptyHint')}</p><ProjectPanel project={project} /></div>}
      </div>
      <section className="chat" aria-label={t('chatTitle')}>
        <header className="chat-head">
          <div className="chat-title">
            <h2>{t('chatTitle')}</h2>
            <button className="path" title={t('changeProject')} onClick={onOpen}>{projectName(project)}</button>
          </div>
          <button className="ghost small push" onClick={() => setSettingsFor({})}>{t('editTeam')}</button>
        </header>
        <div className="thread" aria-live="polite">
          {thread.length > shown.length ? <p className="thread-note">{t('olderRuns', { n: thread.length - shown.length })}</p> : null}
          {!shown.length ? <p className="thread-note">{t('chatEmpty')}</p> : null}
          {shown.map(run => {
            const on = run.id === selected?.id;
            const time = new Date(run.startedAt).toLocaleTimeString(lang === 'ko' ? 'ko-KR' : 'en-US', { hour: '2-digit', minute: '2-digit' });
            return (
              <article key={run.id} className="exchange">
                <div className="msg msg-user"><div className="bubble">{run.request}</div><span className="msg-meta">{t('you')} · {time}</span></div>
                <button className={`reply status-${statusTone(run.status)}${on ? ' on' : ''}`} aria-pressed={on} onClick={() => setSelectedId(run.id)}>
                  <span className="reply-head"><span className="run-id">#{run.id}</span><Badge status={run.status} /><span className="msg-meta">{durationOf(run, lang).replace(/^ · /, '')}</span>{on ? <span className="reply-viewing push">{t('viewingRun')}</span> : null}</span>
                  {replyLine(run) ? <span className="reply-text">{replyLine(run)}</span> : null}
                </button>
                {run.id === activeRow?.id && pending ? <QuestionBlock pending={pending} /> : null}
              </article>
            );
          })}
          <div ref={threadEnd} />
        </div>
        <div className="composer-wrap">
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
          {activeElsewhere && active ? <p className="composer-note">{t('otherProjectActive', { id: active.runId, name: projectName(active.project) })}</p> : null}
          {activeHere && !answering && active ? <p className="composer-note">{t('composerBusy', { id: active.runId })}</p> : null}
          {missing.length ? <p className="composer-note warn">{t('modeMissing', { name: missing.map(kind => (kind === 'codex' ? 'Codex' : 'Claude')).join(', ') })}</p> : null}
          {usesDefault && installed && !installed.claude ? <p className="composer-note">{t('modeDefaultFallback')}</p> : null}
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
            <textarea ref={composer} value={text} onChange={event => setText(event.target.value)} onKeyDown={onKey} onPaste={onPaste} rows={3} disabled={blocked}
              placeholder={answering ? t('composerAnswer') : t('composerPlaceholder')} aria-label={answering ? t('composerAnswer') : t('composerPlaceholder')} />
            <button className="send" disabled={blocked || busy || !text.trim()} onClick={() => { void submit(); }}>{answering ? t('sendAnswer') : t('sendRequest')}</button>
          </div>
          <p className="composer-hint">{t('sendHint')}</p>
        </div>
      </section>
      {settingsFor ? <SettingsPanel project={project} runtimes={teamRuntimes} busy={activeHere} initialRole={settingsFor.role} initialSkill={settingsFor.skill} onClose={() => setSettingsFor(null)} onSaved={() => { api.project(project).then(setInfo).catch(() => undefined); }} /> : null}
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
        <TopBar projects={projects} current={project} activeRunId={active?.runId ?? null} onSelect={choose} onOpen={() => { void open(); }} onForget={forget} onForgetBench={forgetBench} opening={opening} tab={tab} onTab={setTab} />
        <main className="main">
          {error ? <p className="banner">{i18n.t('serverDown')}: {error}</p> : null}
          {tab === 'bench' ? <div className="bench-page"><BenchmarkView /></div>
            : tab === 'quality' ? <div className="bench-page"><QualityView project={project} /></div>
            : tab === 'notes' ? <NotesView key={project ?? ''} project={project || null} busy={active !== null && project !== '' && sameProject(active.project, project)} />
            : project ? <RunsView key={project} project={project} runs={runs} active={active} installed={installed} onChanged={() => { void refresh(); }} onOpen={() => { void open(); }} />
              : <Welcome onOpen={() => { void open(); }} opening={opening} />}
        </main>
        {browsing ? <FolderPicker start={project} onPick={path => { choose(path); setBrowsing(false); }} onClose={() => setBrowsing(false)} /> : null}
      </div>
    </I18nContext.Provider>
  );
}
