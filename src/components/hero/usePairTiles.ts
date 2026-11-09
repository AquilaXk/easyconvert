'use client';

import { useState } from 'react';
import { getAvailableTargetFormats } from '@/lib/registry';
import { isSameFormat } from '@/lib/format-aliases';

const ANY_FORMAT = 'any';

interface TileState {
  /** The page's pair the tiles started from; another pair starts them afresh. */
  page: string;
  source: string;
  target: string;
  /** Whether the person changed a tile, so the hero names the tiles' pair instead of the page's title. */
  changed: boolean;
}

export interface PairTiles extends Omit<TileState, 'page'> {
  /** The target files take: the one the target tile shows, or none while it shows any format. */
  chosenTarget: string | undefined;
  changeSource: (next: string) => void;
  changeTarget: (next: string) => void;
}

function startingTiles(sourceFormat: string, targetFormat: string): TileState {
  const source = sourceFormat.toLowerCase();
  const target = targetFormat.toLowerCase();
  return { page: `${source}>${target}`, source, target, changed: false };
}

/**
 * The pair the format tiles of a converter page name. The page holds it rather than the hero, so the choice outlives the
 * swap of the hero for the queue: files added over the queue take it, and it is still there when the queue empties. A new
 * source drops a target it cannot convert to, and a source that is the format of the target drops it too: DOCX to PDF
 * with the source changed to PDF reads any format, not PDF to PDF.
 */
export function usePairTiles(sourceFormat: string, targetFormat: string): PairTiles {
  const [stored, setTiles] = useState(() => startingTiles(sourceFormat, targetFormat));
  const starting = startingTiles(sourceFormat, targetFormat);
  const tiles = stored.page === starting.page ? stored : starting;
  if (tiles !== stored) setTiles(starting);

  const changeSource = (next: string) =>
    setTiles((current) => {
      const source = next.toLowerCase();
      const keepsTarget = getAvailableTargetFormats(source).some((format) => format.id === current.target);
      const becomesTarget = !isSameFormat(source, current.source) && isSameFormat(source, current.target);
      const dropsTarget = source !== ANY_FORMAT && current.target !== ANY_FORMAT && (!keepsTarget || becomesTarget);
      return { ...current, source, target: dropsTarget ? ANY_FORMAT : current.target, changed: true };
    });
  const changeTarget = (next: string) => setTiles((current) => ({ ...current, target: next.toLowerCase(), changed: true }));

  return {
    source: tiles.source,
    target: tiles.target,
    changed: tiles.changed,
    chosenTarget: tiles.target === ANY_FORMAT ? undefined : tiles.target,
    changeSource,
    changeTarget,
  };
}
