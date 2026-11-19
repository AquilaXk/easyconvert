import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDownloadAllZipHandler, type QueueMutationContext } from '../src/hooks/useClientQueue';
import type { ConversionQueueItem } from '../src/lib/types';

function completed(id: string, resultUrl: string): ConversionQueueItem {
  return {
    id, file: new File([], `${id}.png`), name: `${id}.png`, size: 10, sourceFormat: 'png', targetFormat: 'jpg',
    status: 'completed', progress: 100, options: {}, resultUrl,
  };
}

describe('Download All ZIP when a result has expired', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('builds no ZIP, sets the ZIP error and marks only the expired rows as failed', async () => {
    const items = [completed('live', 'blob:live'), completed('gone', 'blob:gone')];
    const fetchMock = vi.fn(async (url: string) =>
      url === 'blob:gone' ? new Response('{"error":"expired"}', { status: 410 }) : new Response('data')
    );
    const createObjectURL = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    let queue = items;
    const setZipError = vi.fn();
    const ctx = {
      queueRef: { current: items },
      mountedRef: { current: true },
      setZipError,
      updateQueue: (update: (prev: ConversionQueueItem[]) => ConversionQueueItem[]) => {
        queue = update(queue);
      },
    } as unknown as QueueMutationContext;

    await createDownloadAllZipHandler(ctx)();

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(setZipError).toHaveBeenLastCalledWith(true);
    expect(queue.map((i) => [i.id, i.status])).toEqual([['live', 'completed'], ['gone', 'error']]);
    expect(queue[1].resultUrl).toBeUndefined();
  });
});
