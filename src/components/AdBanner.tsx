'use client';

export type AdSlotType =
  | 'top-leaderboard'
  | 'mid-content'
  | 'in-feed'
  | 'post-conversion'
  | 'sidebar';

export interface AdBannerProps {
  slot: AdSlotType;
  className?: string;
}

/**
 * The place of one ad unit. No ad loader is installed (no script of an ad network runs on the pages), so a unit could never
 * fill and would leave an empty frame after a conversion; the banner renders nothing until a loader is added (entry 139).
 */
export default function AdBanner(_props: Readonly<AdBannerProps>) {
  return null;
}
