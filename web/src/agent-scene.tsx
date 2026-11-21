// The run's picture: an isometric room where each role sits at a desk and the harness stands in the middle
// with a lamp per check, or the same run as lanes on a time axis. Speech is never agent-to-agent: every
// bubble is something the harness passed between roles (a hand-off, a sent-back reason, the final answer).

import { useEffect, useState } from 'react';
import { useI18n } from './i18n.ts';
import type { Key } from './i18n.ts';
import type { Timeline } from './model.ts';
import { gateLamps, lanesOf, sceneOf } from './scene.ts';
import type { Bubble, Mood } from './scene.ts';

const W = 900;
const H = 480;
const SPOT: Record<string, { x: number; y: number }> = {
  lead: { x: 220, y: 240 },
  verifier: { x: 680, y: 240 },
  builder: { x: 560, y: 362 },
  researcher: { x: 340, y: 362 },
};
const PILLAR = { x: 450, y: 168 };
const RUNTIME_COLOR: Record<string, string> = { codex: '#3CC3B0', claude: '#A993FF' };
const TONE_COLOR: Record<string, string> = { info: '#9DB4FF', ok: '#7FCF8F', problem: '#FF8F84' };
const LAMP_COLOR: Record<string, string> = { ok: '#7FCF8F', fail: '#FF8F84', skip: '#6F7A8E', wait: '#3A4458' };

const anchor = (who: string): { x: number; y: number } => (who === 'harness' ? { x: PILLAR.x, y: PILLAR.y - 30 } : SPOT[who] ? { x: SPOT[who]!.x, y: SPOT[who]!.y - 60 } : { x: 450, y: 40 });

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

function Desk({ x, y }: { x: number; y: number }) {
  return (
    <g aria-hidden="true">
      <polygon points={`${x},${y - 38} ${x + 76},${y} ${x},${y + 38} ${x - 76},${y}`} fill="#2D3649" />
      <polygon points={`${x - 76},${y} ${x},${y + 38} ${x},${y + 60} ${x - 76},${y + 22}`} fill="#232B3A" />
      <polygon points={`${x},${y + 38} ${x + 76},${y} ${x + 76},${y + 22} ${x},${y + 60}`} fill="#1B2230" />
      <polygon points={`${x - 30},${y - 6} ${x + 6},${y - 24} ${x + 6},${y - 4} ${x - 30},${y + 14}`} fill="#11161F" />
      <polygon points={`${x - 27},${y - 5} ${x + 3},${y - 20} ${x + 3},${y - 6} ${x - 27},${y + 9}`} fill="#33415A" />
    </g>
  );
}

/** An original desk robot: capsule body, round head, a visor band in its model's colour. */
function Bot({ x, y, visor, mood }: { x: number; y: number; visor: string; mood: Mood }) {
  const ring = mood === 'working' ? visor : mood === 'failed' ? '#FF8F84' : mood === 'asking' ? '#F0C063' : null;
  return (
    <g className={`bot mood-${mood}`} aria-hidden="true">
      <ellipse cx={x} cy={y + 2} rx="26" ry="9" fill="#10141C" opacity="0.6" />
      <rect x={x - 20} y={y - 52} width="40" height="54" rx="20" fill="#C9D0DC" />
      <path d={`M${x} ${y - 52} a20 20 0 0 1 20 20 v14 a20 20 0 0 1 -20 20 z`} fill="#A7B0C0" />
      <circle cx={x} cy={y - 66} r="19" fill="#DDE2EA" />
      <path d={`M${x} ${y - 85} a19 19 0 0 1 0 38 z`} fill="#BCC4D2" />
      <rect x={x - 14} y={y - 72} width="28" height="10" rx="5" fill={visor} />
      {ring ? <circle className={mood === 'working' ? 'bot-ring working' : 'bot-ring'} cx={x} cy={y - 66} r="27" fill="none" stroke={ring} strokeWidth="2" /> : null}
      {mood === 'done' ? <g><circle cx={x + 20} cy={y - 84} r="8" fill="#1D3A26" stroke="#7FCF8F" /><path d={`M${x + 16.5} ${y - 84} l2.5 2.5 l4.5 -4.5`} fill="none" stroke="#7FCF8F" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></g> : null}
      {mood === 'asking' ? <g><circle cx={x + 22} cy={y - 88} r="10" fill="#45351A" stroke="#F0C063" /><text x={x + 22} y={y - 84} textAnchor="middle" fontSize="13" fontWeight="700" fill="#F0C063">?</text></g> : null}
    </g>
  );
}

/** Splits text into at most `lines` lines of about `width` characters (Korean is about one glyph per character). */
function wrap(text: string, width: number, lines: number): string[] {
  const out: string[] = [];
  let rest = text.replace(/\s+/g, ' ').trim();
  while (rest && out.length < lines) {
    if (rest.length <= width) { out.push(rest); rest = ''; break; }
    let cut = rest.lastIndexOf(' ', width);
    if (cut < width * 0.5) cut = width;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest && out.length) out[out.length - 1] = `${out[out.length - 1]!.slice(0, Math.max(0, width - 1))}…`;
  return out;
}

function SpeechBubble({ bubble, faded, who }: { bubble: Bubble; faded: boolean; who: (role: string) => string }) {
  const from = anchor(bubble.from);
  const lines = wrap(bubble.text, 21, 2);
  const width = 260;
  const height = 30 + lines.length * 18;
  const x = Math.min(W - width - 10, Math.max(10, from.x - width / 2));
  const y = Math.max(8, from.y - height - 60);
  const color = TONE_COLOR[bubble.tone] ?? '#9DB4FF';
  return (
    <g className={`speech${faded ? ' faded' : ''}`}>
      <rect x={x} y={y} width={width} height={height} rx="9" fill="#202838" stroke={color} strokeOpacity="0.6" />
      <text x={x + 12} y={y + 20} fontSize="12" fontWeight="700" fill={color}>{who(bubble.from)} → {who(bubble.to)}</text>
      {lines.map((line, index) => <text key={index} x={x + 12} y={y + 39 + index * 18} fontSize="12.5" fill="#E4E8F0">{line}</text>)}
    </g>
  );
}

export function AgentScene({ timeline, runtimes, asking, live }: { timeline: Timeline; runtimes: Record<string, string> | undefined; asking: boolean; live: boolean }) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const scene = sceneOf(timeline, asking);
  const lamps = gateLamps(timeline);
  const who = (role: string): string => (role === 'harness' ? t('sceneHarness') : role === 'you' ? t('sceneYou') : role);
  const recent = scene.bubbles.slice(-2);
  const latest = recent.at(-1) ?? null;
  const path = latest && latest.to !== 'you' ? (() => {
    const a = anchor(latest.from); const b = anchor(latest.to);
    return `M${a.x} ${a.y + 30} Q ${(a.x + b.x) / 2} ${Math.min(a.y, b.y) - 10} ${b.x} ${b.y + 30}`;
  })() : null;
  const label = (mood: Mood): string => t(`sceneMood_${mood}` as Key);
  return (
    <svg className="agent-scene" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('sceneLabel', { text: latest ? `${who(latest.from)} → ${who(latest.to)}: ${latest.text}` : t('sceneQuiet') })}>
      <polygon points={`450,82 860,272 450,462 40,272`} fill="#1C2330" stroke="#2A3242" />
      <polyline points="245,177 655,367" fill="none" stroke="#242C3B" />
      <polyline points="655,177 245,367" fill="none" stroke="#242C3B" />
      {path ? <path d={path} fill="none" stroke={TONE_COLOR[latest!.tone]} strokeWidth="2" strokeDasharray="6 6" className="handoff" /> : null}
      {path && live && !reduced ? <g><rect x="-8" y="-10" width="16" height="20" rx="2" fill="#E6EAF2"><animateMotion dur="1.8s" repeatCount="indefinite" path={path} /></rect></g> : null}
      <g aria-hidden="true">
        <ellipse cx={PILLAR.x} cy={PILLAR.y + 34} rx="34" ry="13" fill="#141922" />
        <rect x={PILLAR.x - 34} y={PILLAR.y - 34} width="68" height="68" fill="#2A3346" />
        <path d={`M${PILLAR.x} ${PILLAR.y - 34} h34 v68 h-34 z`} fill="#212938" />
        <ellipse cx={PILLAR.x} cy={PILLAR.y - 34} rx="34" ry="13" fill="#38435A" />
        {lamps.map((lamp, index) => <circle key={lamp.gate} cx={PILLAR.x - 18 + index * 18} cy={PILLAR.y - 6} r="6" fill={LAMP_COLOR[lamp.state]} className={lamp.state === 'wait' && live ? 'lamp waiting' : 'lamp'} />)}
      </g>
      <text x={PILLAR.x} y={PILLAR.y + 20} textAnchor="middle" fontSize="11" fill="#B7C0D0">{t('sceneHarnessChecks')}</text>
      {scene.robots.map(robot => {
        const spot = SPOT[robot.role];
        if (!spot) return null;
        const runtime = runtimes?.[robot.role];
        return (
          <g key={robot.role} className={robot.mood === 'idle' ? 'desk-idle' : undefined}>
            <Desk x={spot.x} y={spot.y} />
            <Bot x={spot.x} y={spot.y - 18} visor={runtime ? RUNTIME_COLOR[runtime] ?? '#9DB4FF' : '#6F7A8E'} mood={robot.mood} />
            <text x={spot.x} y={spot.y + 80} textAnchor="middle" fontSize="13" fontWeight="700" fill="#E4E8F0">{robot.role}</text>
            <text x={spot.x} y={spot.y + 97} textAnchor="middle" fontSize="11" fill={runtime ? RUNTIME_COLOR[runtime] ?? '#8B95A7' : '#8B95A7'}>{runtime === 'claude' ? 'Claude' : runtime === 'codex' ? 'Codex' : runtime ?? ''}{runtime ? ' · ' : ''}{label(robot.mood)}</text>
          </g>
        );
      })}
      {recent.map((bubble, index) => <SpeechBubble key={bubble.id} bubble={bubble} faded={index < recent.length - 1} who={who} />)}
    </svg>
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
