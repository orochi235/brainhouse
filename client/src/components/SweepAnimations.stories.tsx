/**
 * Contact sheet: every linear (horizontal-travel) animation brainhouse
 * defines on a panel title bar. Each entry shows the band gradient
 * driven by a specific @keyframes name, so design review of motion
 * happens in one place. Add a new entry when you add a new
 * [data-sweep-preset] preset or a new linear-travel keyframes.
 *
 * For purely radial / scale / opacity animations (status-icon-pulse,
 * panel-spawn, etc.), see the components themselves — they only
 * legibly preview *in situ*.
 */

import { useState } from 'react';

interface SweepDef {
  /** Display label. */
  name: string;
  /** @keyframes identifier from app.css. */
  keyframes: string;
  /** animation-direction value (normal | reverse | alternate). */
  direction: 'normal' | 'reverse' | 'alternate';
  /** animation-timing-function value. */
  easing: string;
  /** animation-duration value (CSS time). */
  duration: string;
  /** Plain-language summary of what the band does. */
  description: string;
}

const SWEEPS: SweepDef[] = [
  {
    name: 'pendulum (panel-title-sweep-edges)',
    keyframes: 'panel-title-sweep-edges',
    direction: 'alternate',
    easing: 'ease-in-out',
    duration: '1.6s',
    description:
      'Default for parent panels. Band peak travels ±70% (almost-offscreen at each end), alternates direction. Opacity dips at midpoint, peaks at the edges. Slows at the ends; accelerates through the middle.',
  },
  {
    name: 'pulse (panel-title-sweep-pulse)',
    keyframes: 'panel-title-sweep-pulse',
    direction: 'normal',
    easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
    duration: '1.4s',
    description:
      'Used for subagent panels (and selectable as a parent preset via [data-sweep-preset="pulse"]). Band shoots left→right, then warps back and shoots again. Opacity fades in at 0–10% and out at 90–100% so the warp is invisible. 1.4s with a parabolic-feel deceleration — fast launch, drawn-out tail.',
  },
];

function SweepRow({ def }: { def: SweepDef }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '12rem 1fr 18rem',
        gap: '1rem',
        alignItems: 'center',
        padding: '0.75rem',
        border: '1px solid var(--panel-border)',
        borderRadius: 6,
        background: 'var(--code-bg)',
      }}
    >
      <code style={{ fontSize: '0.8rem', color: 'var(--fg)' }}>{def.name}</code>
      <div
        // Reuses the live styling from .panel-header::after by recreating
        // the same DOM shape: a relatively-positioned container whose
        // ::after is the animated band. We have to inline the gradient
        // here because the production rule keys off `.panel.waiting` etc.
        style={{
          position: 'relative',
          height: '2.5rem',
          background: 'color-mix(in srgb, var(--panel-bg, #1e1e2e) 100%, transparent)',
          border: '1px solid color-mix(in srgb, var(--fg) 10%, transparent)',
          borderRadius: 4,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: `linear-gradient(
              105deg,
              transparent 35%,
              color-mix(in srgb, var(--accent, #a78bfa) 50%, transparent) 47%,
              var(--accent, #a78bfa) 50%,
              color-mix(in srgb, var(--accent, #a78bfa) 50%, transparent) 53%,
              transparent 65%
            )`,
            animation: `${def.keyframes} ${def.duration} ${def.easing} infinite ${def.direction}`,
            willChange: 'transform',
            mixBlendMode: 'screen',
          }}
        />
        <span
          style={{
            position: 'relative',
            zIndex: 1,
            padding: '0.5rem 0.75rem',
            display: 'inline-block',
            fontSize: '0.8rem',
            color: 'var(--fg)',
          }}
        >
          panel title goes here
        </span>
      </div>
      <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--muted)', lineHeight: 1.4 }}>
        {def.description}
      </p>
    </div>
  );
}

export function Linear_Sweep_Animations() {
  const [paused, setPaused] = useState(false);
  return (
    <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5em', fontSize: '0.85rem' }}>
        <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} />
        Pause all (for screenshotting)
      </label>
      <div
        style={{ animationPlayState: paused ? 'paused' : 'running', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
      >
        {SWEEPS.map((s) => (
          <SweepRow key={s.keyframes} def={s} />
        ))}
      </div>
    </div>
  );
}
