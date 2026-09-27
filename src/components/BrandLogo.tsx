import React from 'react';

const SIGNATURE_ARROWS_PATH =
  'M5385 4691 c-498 -105 -904 -466 -1068 -951 -75 -222 -95 -516 -48 -730 53 -240 148 -439 302 -632 54 -68 54 -68 114 -68 90 0 238 38 302 78 21 13 20 16 -66 102 -173 172 -282 379 -326 615 -26 137 -17 359 19 480 160 534 672 872 1181 781 120 -22 179 -42 303 -103 116 -57 134 -73 82 -73 -148 0 -199 -209 -70 -284 35 -21 293 -44 493 -45 197 -2 219 50 200 466 -8 161 -11 186 -29 210 -47 63 -135 84 -203 49 -41 -22 -63 -57 -76 -122 l-11 -54 -78 55 c-148 103 -323 180 -502 220 -113 26 -408 29 -519 6z M4385 4684 c-350 -61 -669 -267 -871 -560 -84 -122 -39 -260 92 -280 72 -10 119 17 192 113 174 228 414 373 672 403 86 11 98 15 130 45 66 62 203 166 273 207 82 48 80 49 -52 72 -115 20 -325 20 -436 0z M5490 4253 c-83 -14 -231 -65 -258 -88 -2 -2 33 -38 78 -81 109 -105 170 -187 235 -319 193 -393 154 -818 -106 -1155 -320 -413 -841 -534 -1307 -304 -93 47 -93 47 -43 64 28 9 61 26 72 36 52 46 64 139 27 194 -47 68 -57 71 -275 86 -301 20 -363 19 -403 -8 -66 -46 -70 -64 -70 -343 0 -240 1 -253 23 -295 39 -79 133 -110 206 -69 53 29 81 75 81 132 0 26 2 47 5 47 3 0 38 -22 78 -49 296 -200 663 -281 1004 -222 530 90 972 501 1113 1035 121 457 17 916 -290 1285 -50 60 -52 61 -98 60 -26 -1 -58 -4 -72 -6z M6539 2711 c-19 -11 -60 -52 -91 -93 -178 -231 -450 -391 -707 -415 -62 -6 -66 -8 -140 -76 -42 -38 -127 -103 -190 -145 -114 -77 -114 -77 -72 -89 243 -70 588 -29 856 101 294 144 603 458 582 592 -18 109 -145 175 -238 125z';

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
      aria-label="EasyConvert Signature Logo Mark"
    >
      <g id="brand-signature-icon" transform="translate(60, 60) scale(0.245) translate(-511.5, -229)">
        {/* Dual Curved Loop Arrows in #5C6BC0 (brand.700) */}
        <g transform="translate(0, 558) scale(0.1, -0.1)" fill="#5C6BC0">
          <path d={SIGNATURE_ARROWS_PATH} />
        </g>

        {/* Left Loop Document Badge (PDF) */}
        <g id="badge-pdf" aria-label="PDF">
          <title>PDF</title>
          <path
            d="M 318 186 L 354 186 L 380 212 L 380 262 A 12 12 0 0 1 368 274 L 318 274 A 12 12 0 0 1 306 262 L 306 198 A 12 12 0 0 1 318 186 Z"
            fill="#B4BCFB"
            stroke="#5C6BC0"
            strokeWidth="5"
            strokeLinejoin="round"
          />
          <path
            d="M 354 186 L 354 206 A 6 6 0 0 0 360 212 L 380 212 Z"
            fill="#FFFFFF"
            stroke="#5C6BC0"
            strokeWidth="5"
            strokeLinejoin="round"
          />
          <text
            x="343"
            y="252"
            fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
            fontSize="20"
            fontWeight="900"
            fill="#5C6BC0"
            textAnchor="middle"
            letterSpacing="-0.5"
          >
            PDF
          </text>
        </g>

        {/* Right Loop Document Badge (DOC) */}
        <g id="badge-doc" aria-label="DOC">
          <title>DOC</title>
          <path
            d="M 656 186 L 692 186 L 718 212 L 718 262 A 12 12 0 0 1 706 274 L 656 274 A 12 12 0 0 1 644 262 L 644 198 A 12 12 0 0 1 656 186 Z"
            fill="#B4BCFB"
            stroke="#5C6BC0"
            strokeWidth="5"
            strokeLinejoin="round"
          />
          <path
            d="M 692 186 L 692 206 A 6 6 0 0 0 698 212 L 718 212 Z"
            fill="#FFFFFF"
            stroke="#5C6BC0"
            strokeWidth="5"
            strokeLinejoin="round"
          />
          <text
            x="681"
            y="252"
            fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
            fontSize="20"
            fontWeight="900"
            fill="#5C6BC0"
            textAnchor="middle"
            letterSpacing="-0.5"
          >
            DOC
          </text>
        </g>
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
    textClass = size >= 40 ? 'text-2xl md:text-3xl' : size >= 32 ? 'text-xl md:text-2xl' : 'text-lg';
  } else {
    switch (size) {
      case 'sm':
        pixelSize = 26;
        textClass = 'text-lg';
        break;
      case 'md':
        pixelSize = 34;
        textClass = 'text-xl md:text-2xl';
        break;
      case 'lg':
        pixelSize = 44;
        textClass = 'text-2xl md:text-3xl';
        break;
      case 'xl':
        pixelSize = 56;
        textClass = 'text-3xl md:text-4xl';
        break;
    }
  }

  const effectiveTextClass = textClassName || 'text-[#1F2340] dark:text-white';

  return (
    <div className={`inline-flex items-center gap-2.5 select-none ${className}`}>
      <BrandIcon size={pixelSize} className={iconClassName} />
      {showText && (
        <span
          className={`font-sans tracking-tight font-extrabold transition-colors flex items-center leading-none ${textClass} ${effectiveTextClass}`}
        >
          EasyConvert
        </span>
      )}
    </div>
  );
}
