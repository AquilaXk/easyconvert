'use client';

import React from 'react';
import { getAvailableTargetFormats } from '@/lib/registry';
import { useRouter } from '@/i18n/navigation';
import { usePairTiles } from '../hero/usePairTiles';
import HeroFormatTiles from './HeroFormatTiles';

const ANY_FORMAT = 'any';

/**
 * The home page's pair of format tiles. Once a source and a target that converts from it are both chosen, the page of that
 * pair opens; the targets a source offers come from the registry, so every pair it opens is one the site converts.
 */
export default function HomeFormatPicker() {
  const router = useRouter();
  const tiles = usePairTiles(ANY_FORMAT, ANY_FORMAT);

  const openPair = (source: string, target: string) => router.push(`/${source}-to-${target}`);

  const changeSource = (next: string) => {
    const source = next.toLowerCase();
    tiles.changeSource(source);
    const keepsTarget = tiles.target !== ANY_FORMAT && getAvailableTargetFormats(source).some((format) => format.id === tiles.target);
    if (keepsTarget) openPair(source, tiles.target);
  };
  const changeTarget = (next: string) => {
    const target = next.toLowerCase();
    tiles.changeTarget(target);
    if (tiles.source !== ANY_FORMAT && target !== ANY_FORMAT) openPair(tiles.source, target);
  };

  return <HeroFormatTiles sourceFormat={tiles.source} targetFormat={tiles.target} onSourceChange={changeSource} onTargetChange={changeTarget} />;
}
