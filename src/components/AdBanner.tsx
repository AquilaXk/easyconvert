'use client';

import React from 'react';

export type AdSlotType =
  | 'top-leaderboard'
  | 'mid-content'
  | 'in-feed'
  | 'post-conversion'
  | 'sidebar';

export interface AdBannerProps {
  slot: AdSlotType;
  className?: string;
  adClient?: string;
  adSlotId?: string;
}

export default function AdBanner({
  slot,
  className = '',
  adClient,
  adSlotId,
}: AdBannerProps) {
  // Standard IAB display advertising dimensions and CLS prevention configuration
  const getSlotConfig = () => {
    switch (slot) {
      case 'top-leaderboard':
        return {
          wrapper: 'w-full max-w-[728px] mx-auto my-3 px-4',
          container: 'min-h-[50px] sm:min-h-[90px] h-[50px] sm:h-[90px]',
          dimensionLabel: '728 × 90 Leaderboard',
          maxWidth: 'max-w-[728px]',
        };
      case 'mid-content':
        return {
          wrapper: 'w-full max-w-[728px] lg:max-w-[970px] mx-auto my-8 px-4',
          container: 'min-h-[90px] h-[90px]',
          dimensionLabel: '728 × 90 / 970 × 90 Responsive Banner',
          maxWidth: 'max-w-[728px] lg:max-w-[970px]',
        };
      case 'in-feed':
        return {
          wrapper: 'w-full max-w-[728px] mx-auto my-8 px-4',
          container: 'min-h-[90px] h-[90px]',
          dimensionLabel: '728 × 90 In-Feed Placement',
          maxWidth: 'max-w-[728px]',
        };
      case 'post-conversion':
        return {
          wrapper: 'w-full max-w-[728px] mx-auto my-6 px-4',
          container: 'min-h-[90px] h-[90px]',
          dimensionLabel: '728 × 90 Display Placement',
          maxWidth: 'max-w-[728px]',
        };
      case 'sidebar':
      default:
        return {
          wrapper: 'w-[300px] mx-auto my-4',
          container: 'min-h-[250px] h-[250px]',
          dimensionLabel: '300 × 250 Medium Rectangle',
          maxWidth: 'max-w-[300px]',
        };
    }
  };

  const config = getSlotConfig();
  const effectiveClient = adClient || process.env.NEXT_PUBLIC_ADSENSE_CLIENT;
  const effectiveSlot = adSlotId || process.env.NEXT_PUBLIC_ADSENSE_SLOT;

  return (
    <aside
      aria-label="Advertisement"
      className={`relative z-10 flex flex-col items-center justify-center transition-all ${config.wrapper} ${className}`}
    >
      {/* Standardized Minimal Advertisement Header */}
      <div className={`flex items-center justify-center w-full mb-1 px-1 ${config.maxWidth}`}>
        <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-400 dark:text-neutral-500 font-medium select-none">
          Advertisement
        </span>
      </div>

      {/* CLS-Stabilized Display Ad Container */}
      <div
        className={`w-full rounded-lg border border-neutral-200/90 dark:border-neutral-800 bg-neutral-100/60 dark:bg-neutral-900/40 overflow-hidden flex items-center justify-center p-2 relative transition-all ${config.container} ${config.maxWidth}`}
      >
        {effectiveClient && effectiveSlot ? (
          /* Production Script Placement (Google AdSense / Network Target) */
          <ins
            className="adsbygoogle block w-full text-center"
            data-ad-client={effectiveClient}
            data-ad-slot={effectiveSlot}
            data-ad-format="auto"
            data-full-width-responsive="true"
          />
        ) : (
          /* Realistic Industry-Standard Publisher Ad Unit */
          <div className="flex flex-col items-center justify-center gap-0.5 text-center select-none py-1 text-neutral-400 dark:text-neutral-500">
            <span className="text-xs font-mono font-medium tracking-wide">
              {config.dimensionLabel}
            </span>
          </div>
        )}
      </div>
    </aside>
  );
}
