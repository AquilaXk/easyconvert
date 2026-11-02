'use client';

import React from 'react';
import { useTranslations } from 'next-intl';

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

/** The size of each slot (IAB display units); the box keeps its height once an ad is configured, so the ad loads without a shift. */
const SLOT_LAYOUT: Readonly<Record<AdSlotType, { wrapper: string; container: string }>> = {
  'top-leaderboard': { wrapper: 'max-w-[728px] my-3 px-4', container: 'h-[50px] sm:h-[90px]' },
  'mid-content': { wrapper: 'max-w-[728px] lg:max-w-[970px] my-8 px-4', container: 'h-[90px]' },
  'in-feed': { wrapper: 'max-w-[728px] my-8 px-4', container: 'h-[90px]' },
  'post-conversion': { wrapper: 'max-w-[728px] my-6 px-4', container: 'h-[90px]' },
  sidebar: { wrapper: 'max-w-[300px] my-4', container: 'h-[250px]' },
};

/**
 * One ad unit, shown only when an ad network client and slot are configured. Without them it renders nothing, not a
 * placeholder box: a person who sees an empty "advertisement" frame after converting a file sees a broken page.
 */
export default function AdBanner({
  slot,
  className = '',
  adClient,
  adSlotId,
}: Readonly<AdBannerProps>) {
  const t = useTranslations('ads');
  const effectiveClient = adClient || process.env.NEXT_PUBLIC_ADSENSE_CLIENT;
  const effectiveSlot = adSlotId || process.env.NEXT_PUBLIC_ADSENSE_SLOT;
  if (!effectiveClient || !effectiveSlot) return null;
  const layout = SLOT_LAYOUT[slot];

  return (
    <aside aria-label={t('label')} className={`w-full mx-auto flex flex-col items-center ${layout.wrapper} ${className}`}>
      <span className="mb-1 text-[10px] font-mono tracking-widest uppercase text-ink-3 font-medium select-none">
        {t('label')}
      </span>
      <div className={`w-full overflow-hidden ${layout.container}`}>
        <ins
          className="adsbygoogle block w-full text-center"
          data-ad-client={effectiveClient}
          data-ad-slot={effectiveSlot}
          data-ad-format="auto"
          data-full-width-responsive="true"
        />
      </div>
    </aside>
  );
}
