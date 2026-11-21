// The run's picture: a 3D room where each role is an AI character working at its own station and the harness core
// in the middle lights a lamp per check, or the same run as lanes on a time axis. Speech is never agent-to-agent:
// the packet and the bubble show what the harness passed between roles (a hand-off, a sent-back reason, the answer).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { durationText, useI18n } from './i18n.ts';
import type { Key } from './i18n.ts';
import type { Timeline } from './model.ts';
import { gateLamps, lanesOf, sceneOf, stationOf } from './scene.ts';
import type { Mood, Station } from './scene.ts';
import type { Office, OfficeState, PanelView } from './office3d.ts';

/** The robot model (CC0, by Tomás Laulhé, from the three.js examples); see web/public/models/README.md. */
const MODEL_URL = '/models/RobotExpressive.glb';

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return undefined;
    setReduced(query.matches);
    const change = (): void => setReduced(query.matches);
    query.addEventListener?.('change', change);
    return () => query.removeEventListener?.('change', change);
  }, []);
  return reduced;
}

function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

export function AgentScene({ timeline, runtimes, asking, live }: { timeline: Timeline; runtimes: Record<string, string> | undefined; asking: boolean; live: boolean }) {
  const { t, lang } = useI18n();
  const still = useReducedMotion();
  const now = useNow(live);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const office = useRef<Office | null>(null);
  const [loading, setLoading] = useState(true);
  const tags = useRef<Record<string, HTMLDivElement | null>>({});
  const bubble = useRef<HTMLDivElement>(null);
  const coreTag = useRef<HTMLDivElement>(null);
  const [broken, setBroken] = useState(false);
  const scene = sceneOf(timeline, asking);
  const lamps = gateLamps(timeline);
  const latest = scene.bubbles.at(-1) ?? null;
  const who = (role: string): string => (role === 'harness' ? t('sceneHarness') : role === 'you' ? t('sceneYou') : role);
  const runtimeName = (role: string): string => { const kind = runtimes?.[role]; return kind === 'claude' ? 'Claude' : kind === 'codex' ? 'Codex' : kind ?? ''; };

  const panel = (role: string, mood: Mood, station: Station): PanelView => {
    const tone: PanelView['tone'] = mood === 'working' ? 'work' : mood === 'done' ? 'ok' : mood === 'failed' ? 'bad' : mood === 'asking' ? 'ask' : 'idle';
    if (!station.step) return { title: `${role} · ${t('sceneMood_idle')}`, lines: [t('sceneNotYet')], foot: runtimeName(role), tone };
    const lines: string[] = [];
    if (mood === 'asking') lines.push(t('sceneAskPanel'));
    if (station.note) lines.push(station.note);
    if (station.checks.length) lines.push(station.checks.map(check => `${t(`gate_${check.gate}` as Key)} ${check.ok ? '✓' : '✗'}`).join('  '));
    const foot = [durationText(lang, station.elapsedMs), t('sceneCommands', { n: station.commands }), t('sceneFiles', { n: station.fileChanges })].join(' · ');
    return { title: `${role} · ${station.step}`, lines: lines.length ? lines : [t(`sceneMood_${mood}` as Key)], foot, tone };
  };
  const panels = Object.fromEntries(scene.robots.map(robot => [robot.role, panel(robot.role, robot.mood, stationOf(timeline, robot.role, now))]));
  const handoff = latest ? { id: latest.id, from: latest.from, to: latest.to, tone: latest.tone } : null;
  const state: OfficeState = { robots: scene.robots.map(robot => ({ role: robot.role, mood: robot.mood })), panels, lamps, handoff, runtimes, live, still };
  const stateKey = JSON.stringify(state);
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => { office.current?.setState(stateRef.current); }, [stateKey]);

  useEffect(() => {
    const el = canvas.current, box = wrap.current;
    if (!el || !box) return undefined;
    let room: Office | null = null;
    let frame = 0;
    let stopped = false;
    let observer: ResizeObserver | null = null;
    const place = (node: HTMLElement | null, at: { x: number; y: number } | null | undefined, shift = 'translate(-50%, -100%)'): void => {
      if (!node) return;
      if (!at) { node.style.visibility = 'hidden'; return; }
      node.style.visibility = 'visible';
      node.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px) ${shift}`;
    };
    // three.js is loaded only when the scene is shown, so the rest of the dashboard stays light
    void (async () => {
      try {
        const { Office: Room } = await import('./office3d.ts');
        if (stopped) return;
        room = new Room(el);
        const size = (): void => { const rect = box.getBoundingClientRect(); room?.resize(rect.width, rect.height, Math.min(2, window.devicePixelRatio || 1)); };
        size();
        observer = new ResizeObserver(size);
        observer.observe(box);
        await room.load(MODEL_URL);
        if (stopped) return;
        room.setState(stateRef.current);
        office.current = room;
        setLoading(false);
        const loop = (): void => {
          frame = requestAnimationFrame(loop);
          if (document.hidden || !room) return;
          room.frame();
          const anchors = room.anchors();
          for (const [role, node] of Object.entries(tags.current)) place(node, anchors.tags[role], 'translate(-50%, -30%)');
          // every hand-off goes through the harness, so its bubble sits over the gate
          place(bubble.current, anchors.gate);
          place(coreTag.current, anchors.gateBase, 'translate(-50%, 0)');
        };
        frame = requestAnimationFrame(loop);
      } catch {
        if (!stopped) setBroken(true);
      }
    })();
    return () => { stopped = true; cancelAnimationFrame(frame); observer?.disconnect(); room?.dispose(); office.current = null; };
  }, []);

  const drag = useRef<{ x: number; yaw: number } | null>(null);
  const onDown = (event: ReactPointerEvent<HTMLDivElement>): void => { if (!office.current) return; drag.current = { x: event.clientX, yaw: office.current.yaw }; event.currentTarget.setPointerCapture(event.pointerId); };
  const onMove = (event: ReactPointerEvent<HTMLDivElement>): void => { if (!drag.current || !office.current) return; office.current.yaw = Math.max(-1.1, Math.min(1.1, drag.current.yaw - (event.clientX - drag.current.x) * 0.005)); };
  const onUp = (): void => { drag.current = null; };
  const label = useMemo(() => t('sceneLabel', { text: latest ? `${who(latest.from)} → ${who(latest.to)}: ${latest.text}` : t('sceneQuiet') }), [latest?.id, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  if (broken) return <><p className="muted">{t('sceneNoWebgl')}</p><RoleLanes timeline={timeline} runtimes={runtimes} live={live} /></>;
  return (
    <div ref={wrap} className="scene3d" role="img" aria-label={label} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      onDoubleClick={() => { if (office.current) office.current.yaw = 0; }}>
      <canvas ref={canvas} aria-hidden="true" />
      {loading ? <p className="scene-loading">{t('sceneLoading')}</p> : null}
      {scene.robots.map(robot => (
        <div key={robot.role} className={`scene-tag mood-${robot.mood}`} ref={node => { tags.current[robot.role] = node; }} aria-hidden="true">
          <strong>{robot.role}</strong>
          <span className={`rt-text-${runtimes?.[robot.role] ?? 'none'}`}>{runtimeName(robot.role)}{runtimeName(robot.role) ? ' · ' : ''}{t(`sceneMood_${robot.mood}` as Key)}</span>
          {robot.mood === 'idle' && !still ? <i className="zz">z z</i> : null}
        </div>
      ))}
      {latest ? (
        <div key={latest.id} ref={bubble} className={`scene-bubble tone-${latest.tone}`} aria-hidden="true">
          <strong>{who(latest.from)} → {who(latest.to)}</strong>
          <span>{latest.text}</span>
        </div>
      ) : null}
      <div ref={coreTag} className="scene-core" aria-hidden="true">{t('sceneHarnessChecks')}<span>{lamps.map(lamp => t(`gate_${lamp.gate}` as Key)).join(' · ')}</span></div>
    </div>
  );
}

/** The same run as one lane per role on a time axis, with the harness's checks as checkpoints below. */
export function RoleLanes({ timeline, runtimes, live }: { timeline: Timeline; runtimes: Record<string, string> | undefined; live: boolean }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  const { lanes, checkpoints, spanMs } = lanesOf(timeline, now);
  if (!lanes.length) return <p className="muted">{t('waitingStep')}</p>;
  const seconds = Math.max(1, Math.round(spanMs / 1000));
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div className="lanes">
      <div className="lane-axis" aria-hidden="true">{ticks.map(tick => <span key={tick}>{Math.round(seconds * tick)}s</span>)}</div>
      {lanes.map(lane => {
        const runtime = runtimes?.[lane.role];
        return (
          <div key={lane.role} className="lane">
            <div className="lane-name"><span>{lane.role}</span><span className={`lane-runtime rt-text-${runtime ?? 'none'}`}>{runtime === 'claude' ? 'Claude' : runtime === 'codex' ? 'Codex' : ''}</span></div>
            <div className="lane-track">
              {lane.blocks.map((block, index) => (
                <div key={index} className={`lane-block rt-${runtime ?? 'none'}${block.running ? ' running' : ''}${block.ok === false ? ' failed' : ''}`} style={{ left: `${block.start * 100}%`, width: `${Math.max(0.8, (block.end - block.start) * 100)}%` }} title={block.step}>
                  <span>{block.step}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      <div className="lane">
        <div className="lane-name"><span className="muted">{t('sceneHarnessChecks')}</span></div>
        <div className="lane-track checks">
          {checkpoints.map((point, index) => (
            <span key={index} className={`checkpoint ${point.skipped ? 'skip' : point.ok ? 'ok' : 'fail'}`} style={{ left: `${point.at * 100}%` }}>{t(`gate_${point.gate}` as Key)} {point.skipped ? '–' : point.ok ? '✓' : '✗'}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
