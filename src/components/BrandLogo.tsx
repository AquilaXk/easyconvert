'use client';

import React, { useId } from 'react';

/**
 * The brand mark (QA's asset, docs/policy-decisions.md entry 139) in its small form, for 32 px and the header: the tile
 * fills the canvas and drops the source's glow, rim and shadow, which blur away at this size. Three bars form an E beside a
 * chevron. The colours are the mark's own, the same in both themes.
 */
const TILE_STOPS = [
  ['0%', '#1E3A8A'],
  ['48%', '#4F46E5'],
  ['100%', '#7C3AED'],
] as const;
const BAR_TOP =
  'M 30.1 37.0 L 49.0 37.0 C 50.1 37.0 51.1 37.5 51.8 38.4 L 56.6 45.0 C 57.5 46.2 56.6 47.8 55.2 47.8 L 30.1 47.8 C 27.12 47.8 24.7 45.38 24.7 42.4 C 24.7 39.42 27.12 37.0 30.1 37.0 Z';
const BAR_MIDDLE =
  'M 30.1 58.6 L 56.8 58.6 C 57.8 58.6 58.8 59.1 59.4 59.9 L 61.9 63.2 C 62.4 63.7 62.4 64.3 61.9 64.8 L 59.4 68.1 C 58.8 68.9 57.8 69.4 56.8 69.4 L 30.1 69.4 C 27.12 69.4 24.7 66.98 24.7 64.0 C 24.7 61.02 27.12 58.6 30.1 58.6 Z';
const BAR_BOTTOM =
  'M 30.1 80.2 L 55.2 80.2 C 56.6 80.2 57.5 81.8 56.6 83.0 L 51.8 89.6 C 51.1 90.5 50.1 91.0 49.0 91.0 L 30.1 91.0 C 27.12 91.0 24.7 88.58 24.7 85.6 C 24.7 82.62 27.12 80.2 30.1 80.2 Z';
const CHEVRON =
  'M 67.2 37.0 L 79.0 37.0 C 81.3 37.0 83.4 38.1 84.7 40.0 L 100.0 61.2 C 101.3 63.0 101.3 65.0 100.0 66.8 L 84.7 88.0 C 83.4 89.9 81.3 91.0 79.0 91.0 L 67.2 91.0 C 64.6 91.0 63.1 88.0 64.6 85.9 L 80.5 64.0 L 64.6 42.1 C 63.1 40.0 64.6 37.0 67.2 37.0 Z';

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

export function BrandIcon({ size = 32, className = '', decorative = false }: Readonly<BrandIconProps>) {
  const id = useId();
  const tile = `${id}-tile`;
  const beam = `${id}-beam`;
  const chevron = `${id}-chevron`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="8 8 112 112"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`shrink-0 ${className}`}
      aria-hidden={decorative ? 'true' : undefined}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : 'EasyConvert'}
    >
      <defs>
        <linearGradient id={tile} x1="0%" y1="0%" x2="100%" y2="100%">
          {TILE_STOPS.map(([offset, color]) => (
            <stop key={offset} offset={offset} stopColor={color} />
          ))}
        </linearGradient>
        <linearGradient id={beam} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#38BDF8" />
          <stop offset="100%" stopColor="#E0F2FE" />
        </linearGradient>
        <linearGradient id={chevron} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="65%" stopColor="#E0E7FF" />
          <stop offset="100%" stopColor="#C4B5FD" />
        </linearGradient>
      </defs>
      <rect x="8" y="8" width="112" height="112" rx="28" fill={`url(#${tile})`} />
      <path d={BAR_TOP} fill="#FFFFFF" />
      <path d={BAR_MIDDLE} fill={`url(#${beam})`} />
      <path d={BAR_BOTTOM} fill="#BAE6FD" />
      <path d={CHEVRON} fill={`url(#${chevron})`} />
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
