'use client';

import React from 'react';

export type AdSlotType =
  | 'top-leaderboard'
  | 'mid-content'
  | 'in-feed'
  | 'post-conversion'
  | 'sidebar';

interface AdBannerProps {
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
  // Dimension and styling classes per slot type
  const getSlotConfig = () => {
    switch (slot) {
      case 'top-leaderboard':
        return {
          wrapper: 'max-w-[728px] w-full mx-auto my-4 px-4',
          container: 'min-h-[60px] sm:min-h-[90px]',
          label: 'Advertisement',
          sponsorText: 'Sponsored Placement',
          sponsorSubtext: 'High-speed edge cloud network for instant conversions',
        };
      case 'mid-content':
        return {
          wrapper: 'max-w-[728px] lg:max-w-[970px] w-full mx-auto my-8 px-4',
          container: 'min-h-[90px] sm:min-h-[100px]',
          label: 'Advertisement',
          sponsorText: 'Fast & Secure Storage Sponsor',
          sponsorSubtext: 'Encrypted, zero-knowledge browser-edge file processing',
        };
      case 'in-feed':
        return {
          wrapper: 'max-w-4xl w-full mx-auto my-10 px-4',
          container: 'min-h-[100px] sm:min-h-[120px]',
          label: 'Sponsored',
          sponsorText: 'Enterprise Cloud Infrastructure',
          sponsorSubtext: 'Support 100% free open web conversion technology',
        };
      case 'post-conversion':
        return {
          wrapper: 'w-full max-w-4xl mx-auto my-6 px-4',
          container: 'min-h-[80px] sm:min-h-[90px]',
          label: 'Advertisement',
          sponsorText: 'Ready for Download',
          sponsorSubtext: 'Support free conversion by viewing our trusted partners',
        };
      case 'sidebar':
      default:
        return {
          wrapper: 'max-w-[300px] w-full mx-auto my-4',
          container: 'min-h-[250px]',
          label: 'Advertisement',
          sponsorText: 'Display Sponsor',
          sponsorSubtext: '100% Free Edge Conversions',
        };
    }
  };

  const config = getSlotConfig();

  return (
    <aside
      aria-label="Advertisement"
      className={`relative z-10 flex flex-col items-center justify-center transition-all ${config.wrapper} ${className}`}
    >
      {/* Subtle Advertisement Micro-Label */}
      <div className="flex items-center justify-between w-full mb-1 px-1">
        <span className="text-[10px] font-mono tracking-widest uppercase text-neutral-400 dark:text-neutral-500 font-semibold select-none">
          {config.label}
        </span>
        <span className="text-[9px] text-neutral-400 dark:text-neutral-600 select-none">
          Ad Choices
        </span>
      </div>

      {/* Main Banner Unit Container */}
      <div
        className={`w-full rounded-2xl border border-neutral-border dark:border-[#283252] bg-white dark:bg-[#161B2E] shadow-sm overflow-hidden flex items-center justify-center p-3 relative group transition-all duration-200 ${config.container}`}
      >
        {adClient && adSlotId ? (
          /* Google AdSense / Network Script Target */
          <ins
            className="adsbygoogle block w-full text-center"
            data-ad-client={adClient}
            data-ad-slot={adSlotId}
            data-ad-format="auto"
            data-full-width-responsive="true"
          />
        ) : (
          /* Clean Non-Intrusive Modern Display Placement */
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 w-full px-2 sm:px-4 text-center sm:text-left">
            <div className="flex items-center gap-3">
              <div className="size-9 rounded-lg bg-[#5C6BC0]/15 dark:bg-[#5C6BC0]/25 text-[#5C6BC0] dark:text-[#949FE8] flex items-center justify-center shrink-0 border border-[#5C6BC0]/20">
                <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                </svg>
              </div>
              <div className="space-y-0.5">
                <div className="text-xs sm:text-sm font-semibold text-neutral-800 dark:text-neutral-200">
                  {config.sponsorText}
                </div>
                <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  {config.sponsorSubtext}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[11px] font-medium px-2.5 py-1 rounded-md bg-[#5C6BC0]/10 text-[#5C6BC0] dark:text-[#949FE8] border border-[#5C6BC0]/20">
                100% Free Service
              </span>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
