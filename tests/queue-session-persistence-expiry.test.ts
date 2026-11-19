import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { persistCompletedServerQueue, restoreCompletedServerQueue } from '../src/lib/queue-session-persistence';
import type { ConversionQueueItem } from '../src/lib/types';

const RETENTION_MS = 55 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function completed(id: string): ConversionQueueItem {
  return {
    id, file: new File([], `${id}.png`), name: `${id}.png`, size: 10, sourceFormat: 'png', targetFormat: 'jpg',
    status: 'completed', progress: 100, options: {}, resultUrl: `/api/storage/file/${id}`,
  };
}

describe('completed server results kept across a reload', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('window', {});
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the completion time of an item when the queue is saved again', () => {
    const t0 = 1_000_000;
    persistCompletedServerQueue([completed('a')], 's', t0);
    persistCompletedServerQueue([completed('a'), completed('b')], 's', t0 + 40 * MINUTE_MS);

    const saved = JSON.parse(store.get('easyconvert:completed-results:s')!) as { id: string; savedAt: number }[];
    expect(saved.map((e) => [e.id, e.savedAt])).toEqual([['a', t0], ['b', t0 + 40 * MINUTE_MS]]);
  });

  it('drops an item past the retention on restore even though the queue was saved again later', () => {
    const t0 = 1_000_000;
    persistCompletedServerQueue([completed('a')], 's', t0);
    persistCompletedServerQueue([completed('a'), completed('b')], 's', t0 + 50 * MINUTE_MS);

    const restored = restoreCompletedServerQueue('s', t0 + RETENTION_MS + MINUTE_MS);
    expect(restored.map((i) => i.id)).toEqual(['b']);
  });
});
