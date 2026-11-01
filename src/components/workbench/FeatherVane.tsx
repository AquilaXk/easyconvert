import React from 'react';

const BARB_COUNT = 90;

/** One curved shaft with barbs on both sides; barbs lengthen toward the middle of the vane and thin out at the tip. */
function vanePath(): string {
  let d = 'M60 500 C 160 380 300 200 520 30';
  for (let i = 1; i < BARB_COUNT; i++) {
    const t = i / BARB_COUNT;
    const bulge = Math.sin(t * Math.PI);
    const x = 60 + 460 * t - 40 * bulge;
    const y = 500 - 470 * t + 20 * bulge;
    const len = 30 + 150 * bulge * (1 - 0.35 * t);
    const at = `M${x.toFixed(1)} ${y.toFixed(1)}`;
    d += ` ${at} q${(len * 0.35).toFixed(1)} ${(len * 0.05).toFixed(1)} ${(len * 0.8).toFixed(1)} ${(-len * 0.45).toFixed(1)}`;
    d += ` ${at} q${(-len * 0.1).toFixed(1)} ${(-len * 0.3).toFixed(1)} ${(-len * 0.3).toFixed(1)} ${(-len * 0.75).toFixed(1)}`;
  }
  return d;
}

const VANE_PATH = vanePath();
const SHEEN_STOPS = ['--sheen-1', '--sheen-2', '--sheen-3', '--sheen-4'] as const;

export function FeatherVane({ className = '' }: Readonly<{ className?: string }>) {
  return (
    <svg
      viewBox="0 0 560 520"
      preserveAspectRatio="xMaxYMid meet"
      aria-hidden="true"
      focusable="false"
      className={`pointer-events-none ${className}`}
    >
      <defs>
        <linearGradient id="feather-vane-sheen" x1="0" y1="1" x2="1" y2="0">
          {SHEEN_STOPS.map((stop, index) => (
            <stop key={stop} offset={index / (SHEEN_STOPS.length - 1)} style={{ stopColor: `rgb(var(${stop}))` }} />
          ))}
        </linearGradient>
      </defs>
      <path d={VANE_PATH} fill="none" stroke="url(#feather-vane-sheen)" strokeWidth="0.6" opacity="0.75" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** The drop-zone mark: a small quill whose barbs part around an upward stroke. */
export function PlumeMark({ className = '' }: Readonly<{ className?: string }>) {
  return (
    <svg viewBox="0 0 44 44" fill="none" stroke="currentColor" aria-hidden="true" focusable="false" className={className}>
      <path strokeWidth="1" d="M12 38 C 18 28 24 16 34 6" />
      <path
        strokeWidth="0.8"
        d="M16 32 q8 0 14 -9M19 27 q8 0 13 -9M22 22 q7 -1 11 -9M25 17 q6 -1 9 -8M16 32 q-3 -6 -1 -13M19 27 q-3 -6 0 -12M22 22 q-2 -5 1 -11"
      />
      <path strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" d="M30 40v-9m-3.5 3.5L30 31l3.5 3.5" />
    </svg>
  );
}
