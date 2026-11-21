// Notes page: the project's vault (the same .md files Obsidian opens) as a graph of [[links]], a list and an
// editor. Edits are written straight to the files; a note changed elsewhere in the meantime (Obsidian) is not
// overwritten: the save is refused and the note can be reloaded.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { api, ApiError } from './api.ts';
import type { NoteRow, NotesInfo } from './api.ts';
import { insertLink, layoutGraph, layoutGraph3D, neighbours, project3D } from './graph.ts';
import { serverLines, useI18n } from './i18n.ts';
import type { Key } from './i18n.ts';
import { projectName } from './model.ts';
import { SettingsPanel } from './settings.tsx';
import { errorText } from './util.ts';

const FOLDERS = ['specs', 'decisions', 'inbox', 'runs', 'team'] as const;
const W = 860;
const H = 420;
const MAX_NODES = 300;

type Open = { path: string; text: string; saved: string; mtimeMs: number; backlinks: string[] };
type Status = { kind: 'ok' | 'error' | 'conflict'; text: string } | null;

const folderKey = (folder: string): Key => (FOLDERS.includes(folder as (typeof FOLDERS)[number]) ? `nf_${folder}` : 'nf_other') as Key;
const folderClass = (folder: string, kind: string): string => (kind === 'missing' ? 'g-missing' : FOLDERS.includes(folder as (typeof FOLDERS)[number]) ? `g-${folder}` : 'g-other');
const RUN_STATUSES = ['running', 'completed', 'needs_review', 'needs_user', 'interrupted', 'failed'];
/** A note's status in the dashboard language: memory notes (proposed / approved / rejected) and run notes (run statuses). */
const statusLabel = (status: string, t: (key: Key) => string): string => {
  const value = status.trim().toLowerCase();
  if (['approved', '승인'].includes(value)) return t('ns_approved');
  if (['rejected', '거절'].includes(value)) return t('ns_rejected');
  if (value === 'proposed') return t('ns_proposed');
  return RUN_STATUSES.includes(value) ? t(`status_${value}` as Key) : status;
};
const statusTone = (status: string): string => {
  const value = status.trim().toLowerCase();
  if (['approved', '승인', 'completed'].includes(value)) return 'success';
  if (['proposed', 'needs_review', 'needs_user', 'interrupted'].includes(value)) return 'warning';
  if (['rejected', '거절', 'failed'].includes(value)) return 'danger';
  return 'neutral';
};
const short = (text: string, max = 22): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Labels for every node in a small graph; in a big one only for hubs, specs, decisions and what is in focus. */
const showLabel = (count: number, node: { links: number; folder: string }, focused: boolean): boolean => count <= 40 || focused || node.links >= 3 || node.folder === 'specs' || node.folder === 'decisions';

type GraphNode = NotesInfo['graph']['nodes'][number];

function Graph({ info, selected, showRuns, showMissing, mode, onPick }: { info: NotesInfo; selected: string | null; showRuns: boolean; showMissing: boolean; mode: '2d' | '3d'; onPick: (id: string, kind: string, title: string) => void }) {
  const { t } = useI18n();
  const [hover, setHover] = useState<string | null>(null);
  const { nodes, edges, cut } = useMemo(() => {
    let kept = info.graph.nodes.filter(node => (showRuns || node.folder !== 'runs') && (showMissing || node.kind !== 'missing'));
    const total = kept.length;
    if (kept.length > MAX_NODES) kept = [...kept].sort((a, b) => b.links - a.links).slice(0, MAX_NODES);
    const ids = new Set(kept.map(node => node.id));
    return { nodes: kept, edges: info.graph.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)), cut: total - kept.length };
  }, [info, showRuns, showMissing]);
  const focus = hover ?? selected;
  const near = useMemo(() => (focus ? neighbours(focus, edges) : new Set<string>()), [focus, edges]);
  if (!nodes.length) return <div className="graph-empty">{t('notesGraphEmpty')}</div>;
  const view = mode === '3d'
    ? <Graph3D nodes={nodes} edges={edges} focus={focus} near={near} setHover={setHover} onPick={onPick} />
    : <Graph2D nodes={nodes} edges={edges} focus={focus} near={near} setHover={setHover} onPick={onPick} />;
  return (
    <div className="graph-wrap">
      {view}
      <div className="graph-legend">
        {FOLDERS.map(folder => <span key={folder}><i className={`dot g-${folder}`} />{t(folderKey(folder))}</span>)}
        <span><i className="dot g-other" />{t('nf_other')}</span>
        <span><i className="dot g-missing" />{t('notesMissing')}</span>
        {cut > 0 ? <span className="muted">{t('notesCut', { n: cut })}</span> : null}
        {mode === '3d' ? <span className="muted push">{t('notes3dHint')}</span> : null}
      </div>
    </div>
  );
}

interface ViewProps { nodes: GraphNode[]; edges: NotesInfo['graph']['edges']; focus: string | null; near: Set<string>; setHover: (id: string | null) => void; onPick: (id: string, kind: string, title: string) => void }

function NodeMark({ node, x, y, radius, opacity, focus, near, count, setHover, onPick, labelHidden }: { node: GraphNode; x: number; y: number; radius: number; opacity: number; focus: string | null; near: Set<string>; count: number; setHover: (id: string | null) => void; onPick: (id: string, kind: string, title: string) => void; labelHidden?: boolean }) {
  const on = node.id === focus;
  const faded = focus !== null && !on && !near.has(node.id);
  const label = !labelHidden && showLabel(count, node, on || near.has(node.id));
  return (
    <g className={`gnode ${folderClass(node.folder, node.kind)}${on ? ' on' : ''}${faded ? ' faded' : ''}`} transform={`translate(${x} ${y})`} style={faded ? undefined : { opacity }}
      onMouseEnter={() => setHover(node.id)} onMouseLeave={() => setHover(null)} onClick={() => onPick(node.id, node.kind, node.title)}
      tabIndex={0} role="button" aria-label={node.title} onKeyDown={event => { if (event.key === 'Enter') onPick(node.id, node.kind, node.title); }}>
      <circle r={radius} />
      {label ? <text y={radius + 12} textAnchor="middle">{short(node.title)}</text> : null}
    </g>
  );
}

function Graph2D({ nodes, edges, focus, near, setHover, onPick }: ViewProps) {
  const { t } = useI18n();
  const positions = useMemo(() => layoutGraph(nodes, edges, { width: W, height: H }), [nodes, edges]);
  return (
    <svg className="notes-graph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('notesGraph')}>
      {edges.map((edge, index) => {
        const a = positions.get(edge.from)!; const b = positions.get(edge.to)!;
        const lit = focus !== null && (edge.from === focus || edge.to === focus);
        return <line key={index} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={lit ? 'edge lit' : focus ? 'edge dim' : 'edge'} />;
      })}
      {nodes.map(node => { const point = positions.get(node.id)!; return <NodeMark key={node.id} node={node} x={point.x} y={point.y} radius={4 + Math.min(node.links, 8) * 0.8} opacity={1} focus={focus} near={near} count={nodes.length} setHover={setHover} onPick={onPick} />; })}
    </svg>
  );
}

/**
 * The rotating view: the 3D layout turns slowly (not with reduced motion), drag to turn it, wheel to zoom.
 * Far nodes are smaller and paler and are drawn first, so near ones sit on top.
 */
function Graph3D({ nodes, edges, focus, near, setHover, onPick }: ViewProps) {
  const { t } = useI18n();
  const positions = useMemo(() => layoutGraph3D(nodes, edges), [nodes, edges]);
  const [angle, setAngle] = useState({ yaw: 0.6, pitch: -0.35 });
  const [zoom, setZoom] = useState(1);
  const drag = useRef<{ x: number; y: number; moved: number } | null>(null);
  const idleUntil = useRef(0);
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (still) return undefined;
    let frame = 0;
    const tick = (): void => {
      if (!drag.current && focus === null && Date.now() > idleUntil.current) setAngle(current => ({ ...current, yaw: current.yaw + 0.0025 }));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [focus]);
  useEffect(() => {
    const element = svg.current;
    if (!element) return undefined;
    const onWheel = (event: WheelEvent): void => { event.preventDefault(); setZoom(current => Math.min(3, Math.max(0.5, current * (1 - event.deltaY * 0.0012)))); };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);
  const down = (event: ReactPointerEvent<SVGSVGElement>): void => { drag.current = { x: event.clientX, y: event.clientY, moved: 0 }; };
  const move = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const current = drag.current;
    if (!current) return;
    const dx = event.clientX - current.x; const dy = event.clientY - current.y;
    current.x = event.clientX; current.y = event.clientY; current.moved += Math.abs(dx) + Math.abs(dy);
    if (current.moved > 4) event.currentTarget.setPointerCapture?.(event.pointerId);
    setAngle(value => ({ yaw: value.yaw + dx * 0.008, pitch: Math.min(1.3, Math.max(-1.3, value.pitch + dy * 0.008)) }));
  };
  const up = (): void => { idleUntil.current = Date.now() + 2500; setTimeout(() => { drag.current = null; }, 0); };
  const radius = Math.min(W, H) * 0.46 * zoom;
  const projected = new Map(nodes.map(node => { const p = project3D(positions.get(node.id)!, angle.yaw, angle.pitch); return [node.id, { x: W / 2 + p.x * radius, y: H / 2 + p.y * radius, scale: p.scale, depth: p.depth }]; }));
  const order = [...nodes].sort((a, b) => projected.get(a.id)!.depth - projected.get(b.id)!.depth);
  const pick = (id: string, kind: string, title: string): void => { if ((drag.current?.moved ?? 0) <= 4) onPick(id, kind, title); };
  return (
    <svg ref={svg} className="notes-graph g3d" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('notesGraph')} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={() => { if (drag.current) up(); }}>
      {edges.map((edge, index) => {
        const a = projected.get(edge.from)!; const b = projected.get(edge.to)!;
        const lit = focus !== null && (edge.from === focus || edge.to === focus);
        return <line key={index} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={lit ? 'edge lit' : focus ? 'edge dim' : 'edge'} style={lit || focus ? undefined : { opacity: 0.35 + 0.65 * ((a.depth + b.depth) / 2) }} />;
      })}
      {order.map(node => {
        const point = projected.get(node.id)!;
        return <NodeMark key={node.id} node={node} x={point.x} y={point.y} radius={(4 + Math.min(node.links, 8) * 0.8) * point.scale} opacity={0.45 + 0.55 * point.depth} focus={focus} near={near} count={nodes.length > 15 ? 99 : nodes.length} setHover={setHover} onPick={pick} labelHidden={point.depth < 0.35 && node.id !== focus && !near.has(node.id)} />;
      })}
    </svg>
  );
}

export function NotesView({ project, busy }: { project: string | null; busy: boolean }) {
  const { t, lang } = useI18n();
  const [settingsFor, setSettingsFor] = useState<{ role?: string; skill?: string } | null>(null);
  const [info, setInfo] = useState<NotesInfo | null>(null);
  const [error, setError] = useState('');
  const [folder, setFolder] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [showRuns, setShowRuns] = useState(true);
  const [showMissing, setShowMissing] = useState(true);
  const [mode, setMode] = useState<'2d' | '3d'>(() => { try { return localStorage.getItem('agent-desk.graph') === '2d' ? '2d' : '3d'; } catch { return '3d'; } });
  const pickMode = (next: '2d' | '3d'): void => { setMode(next); try { localStorage.setItem('agent-desk.graph', next); } catch { /* not kept */ } };
  const [open, setOpen] = useState<Open | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [picker, setPicker] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ folder: string; title: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!project) return;
    try { setInfo(await api.notes(project, lang)); setError(''); } catch (caught) { setError(errorText(caught)); }
  }, [project, lang]);
  const importOld = async (): Promise<void> => {
    if (!project) return;
    try { const done = await api.importNotes(project, lang); await load(); setStatus({ kind: 'ok', text: t('notesImported', { runs: done.runs, decisions: done.decisions }) }); }
    catch (caught) { setStatus({ kind: 'error', text: errorText(caught) }); }
  };
  useEffect(() => { setOpen(null); setStatus(null); void load(); }, [load]);

  const dirty = open !== null && open.text !== open.saved;
  const confirmLeave = (): boolean => !dirty || window.confirm(t('notesDiscard'));
  const openNote = async (path: string, force = false): Promise<void> => {
    if (!project || (!force && !confirmLeave())) return;
    try {
      const read = await api.readNote(project, path);
      setOpen({ path: read.path, text: read.text, saved: read.text, mtimeMs: read.mtimeMs, backlinks: read.backlinks });
      setStatus(null); setPicker(null); setRenaming(null);
    } catch (caught) { setStatus({ kind: 'error', text: errorText(caught) }); }
  };
  const save = async (): Promise<void> => {
    if (!project || !open) return;
    try {
      const written = await api.writeNote({ project, path: open.path, text: open.text, expectedMtimeMs: open.mtimeMs });
      setOpen({ ...open, saved: open.text, mtimeMs: written.mtimeMs });
      setStatus({ kind: 'ok', text: t('saved') });
      await load();
    } catch (caught) {
      setStatus(caught instanceof ApiError && caught.status === 409 ? { kind: 'conflict', text: t('notesConflict') } : { kind: 'error', text: errorText(caught) });
    }
  };
  const create = async (): Promise<void> => {
    if (!project || !creating || !creating.title.trim()) return;
    const title = creating.title.trim();
    const path = `${creating.folder ? `${creating.folder}/` : ''}${title}.md`;
    try {
      await api.writeNote({ project, path, text: `# ${title}\n\n`, create: true });
      setCreating(null); await load(); await openNote(path, true);
    } catch (caught) { setStatus({ kind: 'error', text: errorText(caught) }); }
  };
  const rename = async (): Promise<void> => {
    if (!project || !open || !renaming) return;
    const to = renaming.trim().endsWith('.md') ? renaming.trim() : `${renaming.trim()}.md`;
    try { const moved = await api.moveNote(project, open.path, to); setRenaming(null); await load(); await openNote(moved.path, true); setStatus({ kind: 'ok', text: t('notesMoved') }); }
    catch (caught) { setStatus({ kind: 'error', text: errorText(caught) }); }
  };
  const trash = async (): Promise<void> => {
    if (!project || !open || !window.confirm(t('notesTrashConfirm', { name: open.path }))) return;
    try { await api.trashNote(project, open.path); setOpen(null); setStatus(null); await load(); } catch (caught) { setStatus({ kind: 'error', text: errorText(caught) }); }
  };
  const approve = async (): Promise<void> => {
    if (!project || !open) return;
    if (dirty) await save();
    try { const done = await api.approveNote(project, open.path); await load(); await openNote(done.decision, true); setStatus({ kind: 'ok', text: t('notesApproved') }); }
    catch (caught) { setStatus({ kind: 'error', text: errorText(caught) }); }
  };
  const link = (target: string): void => {
    if (!open) return;
    const area = editor.current;
    const next = insertLink(open.text, area?.selectionStart ?? open.text.length, area?.selectionEnd ?? open.text.length, target);
    setOpen({ ...open, text: next.text }); setPicker(null);
    requestAnimationFrame(() => { area?.focus(); area?.setSelectionRange(next.cursor, next.cursor); });
  };

  if (!project) return <div className="notes-page"><p className="muted">{t('notesNoProject')}</p></div>;
  const notes = info?.notes ?? [];
  const words = query.trim().toLowerCase();
  const listed = notes.filter(note => (folder === 'all' || (folder === 'other' ? !FOLDERS.includes(note.folder as (typeof FOLDERS)[number]) : note.folder === folder)) && (!words || note.path.toLowerCase().includes(words)));
  const count = (name: string): number => notes.filter(note => (name === 'other' ? !FOLDERS.includes(note.folder as (typeof FOLDERS)[number]) : note.folder === name)).length;
  const current: NoteRow | undefined = open ? notes.find(note => note.path === open.path) : undefined;
  const generated = current?.generated === true;
  const mirrorOf = (path: string): { role?: string; skill?: string } => { const [, kind, id] = path.replace(/\.md$/i, '').split('/'); return kind === 'roles' ? { role: id! } : { skill: id! }; };
  const pickable = picker === null ? [] : notes.filter(note => note.path !== open?.path && note.path.toLowerCase().includes(picker.toLowerCase())).slice(0, 12);

  return (
    <div className="notes-page">
      <header className="notes-head">
        <h2>{t('notesTitle', { name: projectName(project) })}</h2>
        {info ? <span className="mono notes-root" title={info.root}>{info.inProject ?? info.root}</span> : null}
        <button className="ghost push" disabled={busy} title={t('notesImportHint')} onClick={() => { void importOld(); }}>{t('notesImport')}</button>
        <button className="ghost" onClick={() => { void load(); }}>{t('notesReload')}</button>
      </header>
      <p className="notes-hint">{t('notesHint')}</p>
      {error ? <p className="error">{serverLines([error])[0]}</p> : null}
      <div className="notes-body">
        <aside className="notes-side">
          <input className="notes-search" value={query} placeholder={t('notesSearch')} aria-label={t('notesSearch')} onChange={event => setQuery(event.target.value)} />
          <nav className="notes-folders">
            <button className={folder === 'all' ? 'on' : ''} onClick={() => setFolder('all')}>{t('nf_all')} <span>{notes.length}</span></button>
            {[...FOLDERS, 'other'].map(name => <button key={name} className={folder === name ? 'on' : ''} title={name === 'other' ? '' : t(`nfd_${name}` as Key)} onClick={() => setFolder(name)}><i className={`dot g-${name}`} />{t(folderKey(name))} <span>{count(name)}</span></button>)}
          </nav>
          <ul className="notes-list">
            {listed.map(note => (
              <li key={note.path}><button className={open?.path === note.path ? 'on' : ''} onClick={() => { void openNote(note.path); }}>
                <span className="note-title">{note.title}</span>
                {note.status ? <span className={`badge tone-${statusTone(note.status)}`}>{statusLabel(note.status, t)}</span> : null}
              </button></li>
            ))}
            {!listed.length ? <li className="muted small">{folder !== 'all' && folder !== 'other' ? t(`nfd_${folder}` as Key) : t('notesNone')}</li> : null}
          </ul>
          {creating ? (
            <div className="note-create">
              <select value={creating.folder} onChange={event => setCreating({ ...creating, folder: event.target.value })} aria-label={t('notesFolder')}>
                {['specs', 'decisions', ''].map(name => <option key={name} value={name}>{name ? t(folderKey(name)) : t('notesRootFolder')}</option>)}
              </select>
              <input autoFocus value={creating.title} placeholder={t('notesNewTitle')} aria-label={t('notesNewTitle')} onChange={event => setCreating({ ...creating, title: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') void create(); if (event.key === 'Escape') setCreating(null); }} />
              <div className="row"><button disabled={!creating.title.trim()} onClick={() => { void create(); }}>{t('notesCreate')}</button><button className="ghost" onClick={() => setCreating(null)}>{t('cancel')}</button></div>
            </div>
          ) : <button className="note-new" onClick={() => setCreating({ folder: 'specs', title: '' })}>+ {t('notesNew')}</button>}
        </aside>
        <section className="notes-main">
          <div className="graph-tools">
            <label><input type="checkbox" checked={showRuns} onChange={event => setShowRuns(event.target.checked)} /> {t('notesShowRuns')}</label>
            <label><input type="checkbox" checked={showMissing} onChange={event => setShowMissing(event.target.checked)} /> {t('notesShowMissing')}</label>
            <span className="lang graph-mode push" role="group" aria-label={t('notesView')}>
              <button className={mode === '2d' ? 'on' : ''} onClick={() => pickMode('2d')}>2D</button>
              <button className={mode === '3d' ? 'on' : ''} onClick={() => pickMode('3d')}>3D</button>
            </span>
          </div>
          {info ? <Graph info={info} selected={open?.path ?? null} showRuns={showRuns} showMissing={showMissing} mode={mode} onPick={(id, kind, title) => {
            if (kind === 'note') void openNote(id);
            else setStatus({ kind: 'ok', text: t('notesMissingInfo', { name: title }) });
          }} /> : null}
          {open ? (
            <div className="note-editor">
              <div className="editor-head">
                <strong className="mono">{open.path}</strong>
                {dirty ? <span className="badge tone-warning">{t('unsaved')}</span> : null}
                <span className="push" />
                {generated ? <><span className="badge tone-neutral">{t('notesGenerated')}</span><button onClick={() => setSettingsFor(mirrorOf(open.path))}>{t('notesEditInSettings')}</button></> : <>
                {open.path.startsWith('inbox/') ? <button disabled={busy} title={busy ? t('busyProject') : ''} onClick={() => { void approve(); }}>{t('notesApprove')}</button> : null}
                <button className="ghost" onClick={() => setPicker(picker === null ? '' : null)}>{t('notesInsertLink')}</button>
                <button className="ghost" onClick={() => setRenaming(renaming === null ? open.path.replace(/\.md$/i, '') : null)}>{t('notesRename')}</button>
                <button className="ghost danger" onClick={() => { void trash(); }}>{t('notesTrash')}</button>
                <button className="send" disabled={!dirty} onClick={() => { void save(); }}>{t('save')}</button></>}
              </div>
              {picker !== null ? (
                <div className="link-picker">
                  <input autoFocus value={picker} placeholder={t('notesLinkSearch')} aria-label={t('notesLinkSearch')} onChange={event => setPicker(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setPicker(null); if (event.key === 'Enter' && pickable[0]) link(pickable[0].title); }} />
                  <ul>{pickable.map(note => <li key={note.path}><button onClick={() => link(note.title)}><i className={`dot g-${FOLDERS.includes(note.folder as (typeof FOLDERS)[number]) ? note.folder : 'other'}`} />{note.title} <span className="muted small">{note.folder}</span></button></li>)}
                    {picker.trim() && !notes.some(note => note.title.toLowerCase() === picker.trim().toLowerCase()) ? <li><button onClick={() => link(picker.trim())}>{t('notesLinkNew', { name: picker.trim() })}</button></li> : null}
                  </ul>
                </div>
              ) : null}
              {renaming !== null ? (
                <div className="link-picker">
                  <input autoFocus value={renaming} aria-label={t('notesRename')} onChange={event => setRenaming(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void rename(); if (event.key === 'Escape') setRenaming(null); }} />
                  <p className="editor-note">{t('notesRenameHint')}</p>
                  <div className="row"><button onClick={() => { void rename(); }}>{t('notesRename')}</button><button className="ghost" onClick={() => setRenaming(null)}>{t('cancel')}</button></div>
                </div>
              ) : null}
              <textarea ref={editor} className="mono editor-text" spellCheck={false} value={open.text} aria-label={open.path} readOnly={generated}
                onChange={event => setOpen({ ...open, text: event.target.value })}
                onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); void save(); } }} />
              {status ? (
                <div className={`editor-status ${status.kind === 'conflict' ? 'error' : status.kind}`} role="status">
                  {status.text}
                  {status.kind === 'conflict' ? <button className="ghost" onClick={() => { void openNote(open.path, true); }}>{t('notesReloadNote')}</button> : null}
                </div>
              ) : null}
              <div className="note-links">
                <div><span className="label">{t('notesOutgoing')}</span>
                  {current?.links.length ? current.links.map(entry => entry.resolved
                    ? <button key={entry.target} className="chip" onClick={() => { void openNote(entry.resolved!); }}>{entry.target}</button>
                    : <span key={entry.target} className="chip missing" title={t('notesMissing')}>{entry.target}</span>) : <span className="muted small">{t('notesNoLinks')}</span>}
                </div>
                <div><span className="label">{t('notesBacklinks')}</span>
                  {open.backlinks.length ? open.backlinks.map(path => <button key={path} className="chip" onClick={() => { void openNote(path); }}>{path.split('/').pop()!.replace(/\.md$/i, '')}</button>) : <span className="muted small">{t('notesNoLinks')}</span>}
                </div>
              </div>
            </div>
          ) : status ? <p className={`editor-status ${status.kind === 'conflict' ? 'error' : status.kind}`}>{status.text}</p> : <p className="muted">{t('notesPick')}</p>}
        </section>
      </div>
      {settingsFor && project ? <SettingsPanel project={project} runtimes={null} busy={busy} initialRole={settingsFor.role} initialSkill={settingsFor.skill} onClose={() => setSettingsFor(null)} onSaved={() => { void load(); }} /> : null}
    </div>
  );
}
