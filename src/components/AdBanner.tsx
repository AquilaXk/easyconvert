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

  return (
    <aside
      aria-label="Advertisement"
      className={`relative z-10 flex flex-col items-center justify-center transition-all ${config.wrapper} ${className}`}
    >
      {/* Standardized Advertisement Micro-Header */}
      <div className={`flex items-center justify-between w-full mb-1 px-1 ${config.maxWidth}`}>
        <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-400 dark:text-neutral-500 font-semibold select-none">
          Advertisement
        </span>
        <span className="text-[9px] font-mono text-neutral-400 dark:text-neutral-600 select-none">
          Ad Choices
        </span>
      </div>

      {/* CLS-Stabilized Display Ad Container */}
      <div
        className={`w-full rounded-xl border border-dashed border-neutral-300 dark:border-[#283252] bg-neutral-50/70 dark:bg-[#131726]/70 overflow-hidden flex items-center justify-center p-2 relative transition-all ${config.container} ${config.maxWidth}`}
      >
        {adClient && adSlotId ? (
          /* Production Script Placement (Google AdSense / Network Target) */
          <ins
            className="adsbygoogle block w-full text-center"
            data-ad-client={adClient}
            data-ad-slot={adSlotId}
            data-ad-format="auto"
            data-full-width-responsive="true"
          />
        ) : (
          /* Realistic Industry-Standard Ad Space Placement */
          <div className="flex flex-col items-center justify-center gap-1 text-center select-none py-1">
            <span className="text-xs font-mono font-medium text-neutral-500 dark:text-neutral-400 tracking-wide">
              {config.dimensionLabel}
            </span>
            <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
              Reserved Display Unit
            </span>
          </div>
        )}
      </div>
    </aside>
  );
}
