// The development plan: a checklist per project. "AI로 설계하기" drafts it from the documents and code (nothing is
// kept until the user saves it); each item can be started as a run, and a completed run checks it off.

import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import type { NewTodo, TodoItem, TodoPlan } from './api.ts';
import { useI18n } from './i18n.ts';
import { errorText } from './util.ts';

const groups = <T extends { phase?: string }>(items: readonly T[]): [string, T[]][] => {
  const order = [...new Set(items.map(item => item.phase ?? ''))];
  return order.map(phase => [phase, items.filter(item => (item.phase ?? '') === phase)]);
};

export function useTodo(project: string): { plan: TodoPlan | null; reload: () => void } {
  const [plan, setPlan] = useState<TodoPlan | null>(null);
  const reload = useCallback(() => { api.todo(project).then(setPlan).catch(() => setPlan(null)); }, [project]);
  useEffect(() => { reload(); }, [reload]);
  return { plan, reload };
}

export function TodoPanel({ project, busy, designFirst, onStart, onClose, onChanged }: {
  project: string;
  /** A run is going: starting an item or designing would wait. */
  busy: boolean;
  designFirst?: boolean;
  onStart: (item: TodoItem) => Promise<void>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t, lang } = useI18n();
  const [plan, setPlan] = useState<TodoPlan | null>(null);
  const [error, setError] = useState('');
  const [designOpen, setDesignOpen] = useState(!!designFirst);
  const [brief, setBrief] = useState('');
  const [designing, setDesigning] = useState(false);
  const [draft, setDraft] = useState<{ goal: string; items: NewTodo[] } | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newRequest, setNewRequest] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => { api.todo(project).then(loaded => { setPlan(loaded); if (!loaded.items.length) setDesignOpen(true); }).catch(caught => setError(errorText(caught))); }, [project]);
  useEffect(() => { const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [onClose]);

  const apply = async (work: Promise<TodoPlan>): Promise<void> => {
    try { setPlan(await work); setError(''); onChanged(); } catch (caught) { setError(errorText(caught)); }
  };
  const design = async (): Promise<void> => {
    setDesigning(true); setError('');
    try {
      const reply = await api.todoDesign(project, brief, lang);
      if (reply.ok && reply.draft) setDraft(reply.draft); else setError(reply.error ?? t('todoDesignFailed'));
    } catch (caught) { setError(errorText(caught)); } finally { setDesigning(false); }
  };
  const saveDraft = async (): Promise<void> => {
    if (!draft) return;
    await apply(api.todoReplace(project, draft.goal, draft.items, lang));
    setDraft(null); setDesignOpen(false);
  };
  const add = async (): Promise<void> => {
    if (!newTitle.trim()) return;
    await apply(api.todoAdd(project, [{ title: newTitle.trim(), request: newRequest.trim() || newTitle.trim() }], lang));
    setNewTitle(''); setNewRequest('');
  };
  const start = async (item: TodoItem): Promise<void> => {
    try { await onStart(item); onClose(); } catch (caught) { setError(errorText(caught)); }
  };

  const items = plan?.items ?? [];
  const done = items.filter(item => item.status === 'done').length;
  const next = items.find(item => item.status === 'doing') ?? items.find(item => item.status === 'todo') ?? null;

  return (
    <div className="overlay" onClick={onClose}>
      <section className="todo-panel" role="dialog" aria-modal="true" aria-label={t('todoTitle')} onClick={event => event.stopPropagation()}>
        <header className="settings-head">
          <h2>{t('todoTitle')}</h2>
          {items.length ? <span className="todo-progress"><span className="todo-bar"><span style={{ width: `${Math.round((done / items.length) * 100)}%` }} /></span>{t('todoProgress', { done, total: items.length })}</span> : null}
          <button className="ghost small push" onClick={() => setDesignOpen(value => !value)}>{items.length ? t('todoRedesign') : t('todoDesign')}</button>
          <button className="ghost" onClick={onClose}>{t('close')}</button>
        </header>
        <div className="todo-body">
          {error ? <p className="error">{error}</p> : null}
          {plan?.goal ? <p className="todo-goal"><span className="label">{t('todoGoal')}</span>{plan.goal}</p> : null}

          {designOpen && !draft ? (
            <div className="todo-design">
              <p>{items.length ? t('todoRedesignHint') : t('todoDesignHint')}</p>
              <textarea rows={3} value={brief} onChange={event => setBrief(event.target.value)} placeholder={t('todoBriefPlaceholder')} />
              <button disabled={busy || designing} onClick={() => { void design(); }}>{designing ? t('todoDesigning') : t('todoDesignRun')}</button>
            </div>
          ) : null}

          {draft ? (
            <div className="todo-draft">
              <div className="label">{t('todoDraftTitle')}</div>
              {draft.goal ? <p className="todo-goal">{draft.goal}</p> : null}
              {groups(draft.items).map(([phase, list]) => (
                <div key={phase} className="todo-phase">
                  {phase ? <h4>{phase}</h4> : null}
                  <ul>{list.map((item, index) => (
                    <li key={index} className={item.status === 'done' ? 'is-done' : ''}>
                      <span className={`todo-check${item.status === 'done' ? ' on' : ''}`} aria-hidden="true" />
                      <span className="todo-text"><strong>{item.title}</strong>{item.detail ? <span className="muted">{item.detail}</span> : null}{item.evidence ? <span className="todo-evidence">{item.evidence}</span> : null}</span>
                    </li>
                  ))}</ul>
                </div>
              ))}
              {items.length ? <p className="muted small">{t('todoReplaceNote')}</p> : null}
              <div className="draft-actions">
                <button onClick={() => { void saveDraft(); }}>{t('todoSavePlan')}</button>
                <button className="ghost" onClick={() => setDraft(null)}>{t('teamDraftDiscard')}</button>
              </div>
            </div>
          ) : null}

          {!draft && items.length ? (
            <>
              {next ? <p className="todo-next">{t('todoNextUp')}: <strong>{next.id} {next.title}</strong></p> : <p className="todo-next">{t('todoAllDone')}</p>}
              {groups(items).map(([phase, list]) => (
                <div key={phase} className="todo-phase">
                  {phase ? <h4>{phase} <span className="muted">{list.filter(item => item.status === 'done').length}/{list.length}</span></h4> : null}
                  <ul>{list.map(item => (
                    <li key={item.id} className={`todo-item status-${item.status}`}>
                      <input type="checkbox" checked={item.status === 'done'} aria-label={item.title} onChange={event => { void apply(api.todoEdit(project, { id: item.id, status: event.target.checked ? 'done' : 'todo' }, lang)); }} />
                      <button className="todo-text plain" onClick={() => setOpen(open === item.id ? null : item.id)}>
                        <strong><span className="todo-id">{item.id}</span> {item.title}</strong>
                        {item.status === 'doing' ? <span className="badge tone-warning">{t('todoDoing')}{item.runs.length ? ` #${item.runs.at(-1)}` : ''}</span> : null}
                        {item.detail ? <span className="muted">{item.detail}</span> : null}
                      </button>
                      {item.status !== 'done' ? <button className="small" disabled={busy} onClick={() => { void start(item); }}>{t('todoStart')}</button> : <span />}
                      {open === item.id ? (
                        <div className="todo-more">
                          <div className="label">{t('todoRequest')}</div>
                          <p className="prose small">{item.request}</p>
                          {item.evidence ? <p className="todo-evidence">{item.evidence}</p> : null}
                          {item.runs.length ? <p className="muted small">{t('todoRuns')}: {item.runs.map(run => `#${run}`).join(', ')}</p> : null}
                          <button className="ghost danger small" onClick={() => { if (window.confirm(t('todoConfirmRemove', { title: item.title }))) void apply(api.todoEdit(project, { id: item.id, remove: true }, lang)); }}>{t('todoRemove')}</button>
                        </div>
                      ) : null}
                    </li>
                  ))}</ul>
                </div>
              ))}
            </>
          ) : null}

          {!draft ? (
            <div className="todo-add">
              <input value={newTitle} onChange={event => setNewTitle(event.target.value)} placeholder={t('todoNewTitle')} />
              <input value={newRequest} onChange={event => setNewRequest(event.target.value)} placeholder={t('todoNewRequest')} />
              <button disabled={!newTitle.trim()} onClick={() => { void add(); }}>{t('todoAdd')}</button>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
