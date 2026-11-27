import { getAvailableTargetFormats, getFormatByExtension } from '@/lib/registry';
import type { ConversionQueueItem } from '@/lib/types';

/** Why a queued file cannot be converted at all, whatever target it gets. The first reason that applies is the one named. */
export type UnconvertibleReason = 'oversize' | 'empty' | 'unsupported';

export function unconvertibleReason(
  item: Pick<ConversionQueueItem, 'size' | 'sourceFormat'>,
  maxFileBytes: number
): UnconvertibleReason | null {
  if (item.size > maxFileBytes) return 'oversize';
  if (item.size <= 0) return 'empty';
  if (!getFormatByExtension(item.sourceFormat) || getAvailableTargetFormats(item.sourceFormat).length === 0) return 'unsupported';
  return null;
}
