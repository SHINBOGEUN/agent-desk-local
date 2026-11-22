// The run as one lane per role on a time axis, with the harness checks placed where they happened.
// (The 3D agent office that used to share this file is kept in web/archive/scene3d/ for a later redesign.)

import { useEffect, useState } from 'react';
import { useI18n } from './i18n.ts';
import type { Key } from './i18n.ts';
import type { Timeline } from './model.ts';
import { lanesOf } from './scene.ts';

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
            <span key={index} className={`checkpoint ${point.skipped ? 'skip' : point.ok ? 'ok' : 'fail'}`} style={{ left: `${point.at * 100}%`, transform: `translateX(${point.at > 0.85 ? -100 : point.at < 0.1 ? 0 : -50}%)` }}>{t(`gate_${point.gate}` as Key)} {point.skipped ? '–' : point.ok ? '✓' : '✗'}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
