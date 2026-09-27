import React from 'react';

interface BrandLogoProps {
  /** Size variant: 'sm' | 'md' | 'lg' | 'xl' or custom number */
  size?: 'sm' | 'md' | 'lg' | 'xl' | number;
  /** Whether to show text alongside the icon */
  showText?: boolean;
  /** Custom class for the wrapper */
  className?: string;
  /** Invert text colors for dark backgrounds or force light */
  textClassName?: string;
  /** Custom icon class */
  iconClassName?: string;
}

export function BrandIcon({ size = 32, className = '' }: { size?: number | string; className?: string }) {
  const pixelSize = typeof size === 'number' ? size : 32;

  return (
    <svg
      width={pixelSize}
      height={pixelSize}
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`shrink-0 transition-transform duration-200 ${className}`}
      aria-label="EasyConvert Logo Mark"
    >
      <defs>
        {/* Primary Signature Indigo/Blue-Violet Gradient */}
        <linearGradient id="ecBrandGradMain" x1="16" y1="16" x2="104" y2="104" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#7480D2" />
          <stop offset="45%" stopColor="#5C6BC0" />
          <stop offset="100%" stopColor="#4A58A9" />
        </linearGradient>

        {/* Ambient Highlight for 3D depth */}
        <linearGradient id="ecBrandHighlight" x1="30" y1="18" x2="70" y2="90" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#B4BCFB" stopOpacity="0.8" />
          <stop offset="50%" stopColor="#7480D2" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#3B4890" stopOpacity="0.6" />
        </linearGradient>

        {/* Soft Drop Shadow Filter */}
        <filter id="ecSoftShadow" x="-10%" y="-10%" width="125%" height="125%" filterUnits="userSpaceOnUse">
          <feDropShadow dx="0" dy="4" stdDeviation="5" floodColor="#3B4890" floodOpacity="0.32" />
        </filter>

        <linearGradient id="ecArrowGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#1F2340" />
          <stop offset="100%" stopColor="#3B4890" />
        </linearGradient>
      </defs>

      {/* Main Interlocking E-C Symbol */}
      <g filter="url(#ecSoftShadow)">
        {/* Left E Body with rounded corners */}
        <path
          d="M 28 20 
             C 21.37 20, 16 25.37, 16 32 
             L 16 88 
             C 16 94.63, 21.37 100, 28 100 
             L 60 100 
             C 65 100, 68 97, 68 92 
             L 68 85 
             C 68 81, 65 78, 60 78 
             L 34 78 
             C 31 78, 30 76, 30 73 
             L 30 65 
             C 30 62, 32 60, 35 60 
             L 58 60 
             C 63 60, 66 57, 66 52 
             L 66 48 
             C 66 43, 63 40, 58 40 
             L 35 40 
             C 32 40, 30 38, 30 35 
             L 30 32 
             C 30 29, 32 27, 35 27 
             L 60 27 
             C 65 27, 68 24, 68 19 
             L 68 22 
             C 68 20.89, 67.11 20, 66 20 
             Z"
          fill="url(#ecBrandGradMain)"
        />

        {/* Interlocking Ribbon connecting E to C */}
        <path
          d="M 52 46 
             C 52 32, 63 20, 80 20 
             C 96.57 20, 108 31.43, 108 48 
             C 108 53, 104 57, 98 57 
             C 93 57, 89 53, 89 48 
             C 89 39.5, 84.5 35, 78 35 
             C 71.5 35, 66 40.5, 66 50 
             C 66 58, 69 64, 76 68 
             L 76 68 
             C 84 72, 89 77, 89 86 
             C 89 91, 85 95, 80 95 
             L 60 95 
             C 54 95, 52 90, 52 84 
             L 52 46 Z"
          fill="url(#ecBrandHighlight)"
          fillOpacity="0.4"
        />

        {/* Right C Arch */}
        <path
          d="M 76 20
             C 95.88 20, 110 34.12, 110 54
             C 110 58.5, 106.5 62, 102 62
             C 97.5 62, 94 58.5, 94 54
             C 94 42.95, 85.05 34, 74 34
             C 62.95 34, 54 42.95, 54 54
             L 54 66
             C 54 77.05, 62.95 86, 74 86
             C 85.05 86, 94 77.05, 94 66
             C 94 61.5, 97.5 58, 102 58
             C 106.5 58, 110 61.5, 110 66
             C 110 85.88, 95.88 100, 76 100
             C 56.12 100, 40 83.88, 40 64
             L 40 56
             C 40 36.12, 56.12 20, 76 20 Z"
          fill="url(#ecBrandGradMain)"
        />

        {/* Smooth Inner Bridge Flow */}
        <path
          d="M 42 42 
             C 42 34, 48 28, 56 28 
             L 72 28 
             C 86 28, 96 38, 96 52 
             C 96 56, 93 59, 89 59 
             C 85 59, 82 56, 82 52 
             C 82 44, 76 39, 70 39 
             L 56 39 
             C 52 39, 49 42, 49 46 
             L 49 74 
             C 49 78, 52 81, 56 81 
             L 70 81 
             C 76 81, 82 76, 82 68 
             C 82 64, 85 61, 89 61 
             C 93 61, 96 64, 96 68 
             C 96 82, 86 92, 72 92 
             L 56 92 
             C 48 92, 42 86, 42 78 Z"
          fill="url(#ecBrandGradMain)"
        />
      </g>

      {/* Top Conversion Arrow: Points Right (→) */}
      <g className="ec-arrow-top">
        {/* Shaft */}
        <rect x="28" y="32" width="20" height="3" rx="1.5" fill="#1F2340" />
        {/* Arrowhead */}
        <path
          d="M 44 28.5 L 51 33.5 L 44 38.5 Z"
          fill="#1F2340"
        />
      </g>

      {/* Bottom Conversion Arrow: Points Left (←) */}
      <g className="ec-arrow-bottom">
        {/* Shaft */}
        <rect x="30" y="85" width="20" height="3" rx="1.5" fill="#1F2340" />
        {/* Arrowhead */}
        <path
          d="M 33 80.5 L 26 86.5 L 33 92.5 Z"
          fill="#1F2340"
        />
      </g>
    </svg>
  );
}

export default function BrandLogo({
  size = 'md',
  showText = true,
  className = '',
  textClassName = '',
  iconClassName = '',
}: BrandLogoProps) {
  let pixelSize = 34;
  let textClass = 'text-xl md:text-2xl';

  if (typeof size === 'number') {
    pixelSize = size;
  } else {
    switch (size) {
      case 'sm':
        pixelSize = 24;
        textClass = 'text-lg';
        break;
      case 'md':
        pixelSize = 32;
        textClass = 'text-xl md:text-2xl';
        break;
      case 'lg':
        pixelSize = 40;
        textClass = 'text-2xl md:text-3xl';
        break;
      case 'xl':
        pixelSize = 56;
        textClass = 'text-3xl md:text-4xl';
        break;
    }
  }

  return (
    <div className={`inline-flex items-center gap-2.5 select-none ${className}`}>
      <BrandIcon size={pixelSize} className={iconClassName} />
      {showText && (
        <span
          className={`font-sans tracking-tight font-extrabold text-brand-950 dark:text-white transition-colors flex items-center leading-none ${textClass} ${textClassName}`}
        >
          <span className="text-brand-800 dark:text-white">Easy</span>
          <span className="text-brand-700 dark:text-brand-400">Convert</span>
        </span>
      )}
    </div>
  );
}
