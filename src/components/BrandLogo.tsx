'use client';

import React, { useId } from 'react';

/**
 * The brand mark (QA's prism asset of 2026-11-13, which replaced the mark of entry 139) in its small form, for 32 px and the
 * header: the tile fills the canvas and drops the source's glow, rims and shadows, which blur away at this size. A white
 * document sits beside a cyan chevron. The colours are the mark's own, the same in both themes; `src/app/icon.svg` is the same
 * drawing.
 */
const VIEW_BOX = '36 28 440 440';
const TILE_STOPS = [
  ['0%', '#2664EB'],
  ['26%', '#2952D8'],
  ['52%', '#332699'],
  ['80%', '#6D2DCB'],
  ['100%', '#8D31E3'],
] as const;
const FACE_STOPS = [
  ['0%', '#8AF4FF'],
  ['52%', '#76DFFE'],
  ['100%', '#2FB3FA'],
] as const;
const BEVEL_STOPS = [
  ['0%', '#1EB7F8'],
  ['50%', '#55CEFD'],
  ['100%', '#8DF3FE'],
] as const;
const DOCUMENT =
  'M 170.30 127.57 A 12.37 12.37 0 0 1 179.05 123.94 L 236.14 123.94 A 19.11 19.11 0 0 1 255.25 143.06 L 255.25 352.94 A 19.11 19.11 0 0 1 236.14 372.05 L 145.82 372.05 A 19.11 19.11 0 0 1 126.70 352.94 L 126.70 176.29 A 12.37 12.37 0 0 1 130.32 167.54 Z';
const CHEVRON =
  'M 283.36 126.84 A 1.20 1.20 0 0 1 285.41 125.99 L 405.71 246.52 A 2.10 2.10 0 0 1 405.71 249.48 L 285.41 370.00 A 1.20 1.20 0 0 1 283.36 369.15 L 283.36 293.41 A 1.05 1.05 0 0 1 283.67 292.67 L 327.17 249.16 A 1.65 1.65 0 0 0 327.17 246.83 L 283.67 203.33 A 1.05 1.05 0 0 1 283.36 202.59 Z';
const BEVEL = 'M 281.86 122.44 L 337.71 248.00 L 281.86 373.55 L 280.37 373.55 L 280.37 122.44 Z';

type LogoSizePreset = 'sm' | 'md' | 'lg' | 'xl';

interface BrandLogoProps {
  size?: LogoSizePreset | number;
  showText?: boolean;
  className?: string;
  iconClassName?: string;
}

interface BrandIconProps {
  size?: number;
  className?: string;
  decorative?: boolean;
}

function Stops({ stops }: Readonly<{ stops: ReadonlyArray<readonly [string, string]> }>) {
  return (
    <>
      {stops.map(([offset, color]) => (
        <stop key={offset} offset={offset} stopColor={color} />
      ))}
    </>
  );
}

export function BrandIcon({ size = 32, className = '', decorative = false }: Readonly<BrandIconProps>) {
  const id = useId();
  const tile = `${id}-tile`;
  const face = `${id}-face`;
  const bevel = `${id}-bevel`;
  const clip = `${id}-chevron`;
  return (
    <svg
      width={size}
      height={size}
      viewBox={VIEW_BOX}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`shrink-0 ${className}`}
      aria-hidden={decorative ? 'true' : undefined}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : 'EasyConvert'}
    >
      <defs>
        <linearGradient id={tile} x1="52.49" y1="40.74" x2="464.76" y2="456.76" gradientUnits="userSpaceOnUse">
          <Stops stops={TILE_STOPS} />
        </linearGradient>
        <linearGradient id={face} x1="341.08" y1="128.44" x2="326.09" y2="368.31" gradientUnits="userSpaceOnUse">
          <Stops stops={FACE_STOPS} />
        </linearGradient>
        <linearGradient id={bevel} x1="296.86" y1="128.44" x2="296.86" y2="366.81" gradientUnits="userSpaceOnUse">
          <Stops stops={BEVEL_STOPS} />
        </linearGradient>
        <clipPath id={clip}>
          <path d={CHEVRON} />
        </clipPath>
      </defs>
      <rect x="36" y="28" width="440" height="440" rx="106.96" fill={`url(#${tile})`} />
      <path d={DOCUMENT} fill="#FFFFFF" />
      <g clipPath={`url(#${clip})`}>
        <path d={CHEVRON} fill={`url(#${face})`} />
        <path d={BEVEL} fill={`url(#${bevel})`} />
      </g>
    </svg>
  );
}

const SIZE_MAP: Record<LogoSizePreset, { pixelSize: number; textClass: string }> = {
  sm: { pixelSize: 26, textClass: 'text-lg' },
  md: { pixelSize: 32, textClass: 'text-xl md:text-2xl' },
  lg: { pixelSize: 44, textClass: 'text-2xl md:text-3xl' },
  xl: { pixelSize: 56, textClass: 'text-3xl md:text-4xl' },
};

function resolveNumericTextClass(size: number): string {
  if (size >= 40) return 'text-2xl md:text-3xl';
  if (size >= 32) return 'text-xl md:text-2xl';
  return 'text-lg';
}

/** The mark beside the "EasyConvert" wordmark, as a mark and a wordmark sit in the reference headers. */
export default function BrandLogo({ size = 'md', showText = true, className = '', iconClassName = '' }: Readonly<BrandLogoProps>) {
  const resolved = typeof size === 'number' ? { pixelSize: size, textClass: resolveNumericTextClass(size) } : SIZE_MAP[size];

  return (
    <div className={`inline-flex items-center gap-2.5 select-none ${className}`}>
      <BrandIcon size={resolved.pixelSize} className={iconClassName} decorative={showText} />
      {showText && (
        <span className={`font-sans tracking-tight font-extrabold transition-colors flex items-center leading-none ${resolved.textClass} text-ink`}>
          EasyConvert
        </span>
      )}
    </div>
  );
}
