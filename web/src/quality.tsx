// Quality log (ADR 0012, the book's improvement loop). Under each finished run
// the user rates the result; a 👎 says where the fix belongs (a skill, a role
// file, the workflow) and can open that file. The Quality tab adds the ratings
// up next to what the harness measured, so the next change to the harness is
// aimed at the place that failed most, not at a guess.

import { useEffect, useState } from 'react';
import { api } from './api.ts';
import type { Feedback, QualityRow, QualitySummary } from './api.ts';
import { useI18n } from './i18n.ts';
import type { Key } from './i18n.ts';
import { FEEDBACK_CAUSES, formatTokens, projectName } from './model.ts';
import type { FeedbackCause } from './model.ts';
import { errorText } from './util.ts';

const causeKey = (cause: string): Key => `cause_${cause}` as Key;

export function FeedbackBar({ runId, initial, targetsFor, onOpenTarget }: { runId: number; initial: Feedback | null; targetsFor: (cause: FeedbackCause) => string[]; onOpenTarget?: ((target: string) => void) | undefined }) {
  const { t } = useI18n();
  const [saved, setSaved] = useState<Feedback | null>(initial);
  const [form, setForm] = useState<{ cause: FeedbackCause; target: string; note: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSaved(initial); }, [initial]);

  const send = async (body: Parameters<typeof api.feedback>[0]): Promise<void> => {
    setBusy(true); setError('');
    try { setSaved((await api.feedback(body)).feedback); setForm(null); } catch (caught) { setError(errorText(caught)); } finally { setBusy(false); }
  };
  const startDown = (): void => {
    const cause = saved?.cause ?? 'skill';
    setForm({ cause, target: saved?.target ?? targetsFor(cause)[0] ?? '', note: saved?.note ?? '' });
  };
  const pickCause = (cause: FeedbackCause): void => setForm(current => current && { ...current, cause, target: targetsFor(cause)[0] ?? '' });

  if (form) {
    const targets = targetsFor(form.cause);
    return (
      <div className="feedback feedback-form">
        <p className="feedback-q">{t('feedbackWhere')}</p>
        <div className="cause-list" role="radiogroup" aria-label={t('feedbackWhere')}>
          {FEEDBACK_CAUSES.map(cause => (
            <label key={cause} className={`cause${form.cause === cause ? ' on' : ''}`}>
              <input type="radio" name={`cause-${runId}`} checked={form.cause === cause} onChange={() => pickCause(cause)} />
              <span><strong>{t(causeKey(cause))}</strong><small>{t(`${causeKey(cause)}_hint` as Key)}</small></span>
            </label>
          ))}
        </div>
        {targets.length ? (
          <label className="feedback-field">{t('feedbackFile')}
            <select value={form.target} onChange={event => setForm({ ...form, target: event.target.value })}>
              <option value="">{t('feedbackNoFile')}</option>
              {targets.map(target => <option key={target} value={target}>{target}</option>)}
            </select>
          </label>
        ) : null}
        <label className="feedback-field">{t('feedbackNote')}
          <textarea rows={2} value={form.note} maxLength={2000} placeholder={t('feedbackNotePlaceholder')} onChange={event => setForm({ ...form, note: event.target.value })} />
        </label>
        <div className="row">
          <button className="send" disabled={busy} onClick={() => { void send({ runId, rating: -1, cause: form.cause, target: form.target || null, note: form.note || null }); }}>{t('feedbackSave')}</button>
          <button className="ghost" disabled={busy} onClick={() => setForm(null)}>{t('cancel')}</button>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </div>
    );
  }
  if (saved) {
    return (
      <div className={`feedback feedback-saved ${saved.rating === 1 ? 'up' : 'down'}`}>
        <span>{saved.rating === 1 ? `👍 ${t('feedbackUpSaved')}` : `👎 ${saved.cause ? t(causeKey(saved.cause)) : t('feedbackDownSaved')}`}</span>
        {saved.target ? <span className="mono">{saved.target}</span> : null}
        {saved.note ? <span className="feedback-note">“{saved.note}”</span> : null}
        <span className="push" />
        {saved.target && onOpenTarget ? <button className="link" onClick={() => onOpenTarget(saved.target!)}>{t('feedbackOpenFile')}</button> : null}
        {saved.rating === -1 ? <button className="link" onClick={startDown}>{t('feedbackEdit')}</button> : null}
        <button className="link" disabled={busy} onClick={() => { void send({ runId, rating: 0 }); }}>{t('feedbackClear')}</button>
        {error ? <p className="error">{error}</p> : null}
      </div>
    );
  }
  return (
    <div className="feedback">
      <span className="feedback-q">{t('feedbackAsk')}</span>
      <button className="ghost thumb-btn" disabled={busy} aria-label={t('feedbackUp')} title={t('feedbackUp')} onClick={() => { void send({ runId, rating: 1 }); }}>👍</button>
      <button className="ghost thumb-btn" disabled={busy} aria-label={t('feedbackDown')} title={t('feedbackDown')} onClick={startDown}>👎</button>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="stat"><span className="stat-value">{value}</span><span className="stat-label">{label}</span>{note ? <span className="stat-note">{note}</span> : null}</div>;
}

export function QualityView({ project }: { project: string }) {
  const { t, lang } = useI18n();
  const [scope, setScope] = useState<'project' | 'all'>(project ? 'project' : 'all');
  const [data, setData] = useState<{ rows: QualityRow[]; summary: QualitySummary } | null>(null);
  const [error, setError] = useState('');
  const filter = scope === 'project' && project ? project : undefined;
  useEffect(() => { setData(null); api.quality(filter).then(setData).catch((caught: unknown) => setError(errorText(caught))); }, [filter]);
  const pct = (value: number | null): string => (value === null ? '-' : `${Math.round(value * 100)}%`);
  const s = data?.summary;
  const causeTotal = s ? Math.max(1, ...Object.values(s.byCause)) : 1;
  return (
    <div className="stack quality-view">
      <div className="card">
        <div className="quality-head">
          <h2>{t('qualityTitle')}</h2>
          <span className="push" />
          {project ? (
            <span className="seg" role="group" aria-label={t('qualityScope')}>
              <button className={scope === 'project' ? 'on' : ''} onClick={() => setScope('project')}>{projectName(project)}</button>
              <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>{t('qualityAll')}</button>
            </span>
          ) : null}
          <a className="ghost button-link" href={api.qualityExportUrl('csv', filter)} download>CSV</a>
          <a className="ghost button-link" href={api.qualityExportUrl('json', filter)} download>JSON</a>
        </div>
        <p className="prose">{t('qualityIntro')}</p>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {s ? (
        <>
          <div className="card stats">
            <Stat label={t('qualityRated')} value={`${s.rated} / ${s.runs}`} />
            <Stat label={t('qualityApproval')} value={pct(s.approval)} note={`👍 ${s.up} · 👎 ${s.down}`} />
            <Stat label={t('qualityRedoRuns')} value={String(s.redoRuns)} />
            <Stat label={t('qualityRejected')} value={String(s.rejectedReports)} note={t('qualityRejectedNote')} />
            <Stat label={t('qualityTokens')} value={`${s.meanTokensUp === null ? '-' : formatTokens(s.meanTokensUp)} / ${s.meanTokensDown === null ? '-' : formatTokens(s.meanTokensDown)}`} note="👍 / 👎" />
          </div>
          <div className="quality-grid">
            <div className="card">
              <h3>{t('qualityWhereToFix')}</h3>
              {s.down ? (
                <div className="bars">
                  {(['skill', 'role', 'workflow', 'other', 'unknown'] as const).filter(cause => cause !== 'unknown' || s.byCause.unknown).map(cause => (
                    <div key={cause} className="bar-row">
                      <span className="bar-label">{t(causeKey(cause))}</span>
                      <div className="bar"><div className="fill tone-danger" style={{ width: `${((s.byCause[cause] ?? 0) / causeTotal) * 100}%` }} /></div>
                      <span className="bar-value">{s.byCause[cause] ?? 0}</span>
                    </div>
                  ))}
                </div>
              ) : <p className="muted">{t('qualityNoDown')}</p>}
              {s.targets.length ? <><h4>{t('qualityTopFiles')}</h4><ol className="target-list">{s.targets.slice(0, 8).map(entry => <li key={entry.target}><span className="mono">{entry.target}</span><span className="muted">{entry.count}</span></li>)}</ol></> : null}
            </div>
            <div className="card">
              <h3>{t('qualityByWorkflow')}</h3>
              <table className="roles">
                <thead><tr><th>{t('qualityWorkflow')}</th><th>{t('qualityRuns')}</th><th>👍</th><th>👎</th></tr></thead>
                <tbody>{s.byWorkflow.map(row => <tr key={row.workflow}><td>{row.workflow}</td><td>{row.runs}</td><td>{row.up}</td><td>{row.down}</td></tr>)}</tbody>
              </table>
            </div>
          </div>
          <div className="card">
            <h3>{t('qualityRecent')}</h3>
            {data.rows.length ? (
              <div className="table-scroll">
                <table className="roles quality-rows">
                  <thead><tr><th>#</th><th>{t('qualityWhen')}</th>{!filter ? <th>{t('projects')}</th> : null}<th>{t('qualityRequest')}</th><th>{t('qualityWorkflow')}</th><th>{t('qualityRating')}</th><th>{t('qualityWhereToFix')}</th><th>{t('tokens')}</th><th>REDO</th><th>{t('qualityRejectedShort')}</th></tr></thead>
                  <tbody>{data.rows.slice(0, 100).map(row => (
                    <tr key={row.runId}>
                      <td>{row.runId}</td>
                      <td>{new Date(row.startedAt).toLocaleDateString(lang === 'ko' ? 'ko-KR' : 'en-US', { month: 'short', day: 'numeric' })}</td>
                      {!filter ? <td>{projectName(row.project)}</td> : null}
                      <td className="cell-request" title={row.request}>{row.request}</td>
                      <td>{row.workflow ?? '-'}</td>
                      <td>{row.rating === 1 ? '👍' : row.rating === -1 ? '👎' : '-'}</td>
                      <td title={row.note ?? ''}>{row.cause ? t(causeKey(row.cause)) : ''}{row.target ? <div className="mono small">{row.target}</div> : null}</td>
                      <td>{formatTokens(row.tokens)}</td>
                      <td>{row.redo || ''}</td>
                      <td>{row.rejectedReports || ''}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : <p className="muted">{t('qualityEmpty')}</p>}
          </div>
        </>
      ) : null}
    </div>
  );
}
