import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../src/lib/security/process-sandbox', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/security/process-sandbox')>();
  return { ...original, executeSandboxedBinary: vi.fn(original.executeSandboxedBinary) };
});

import { POST as inspectPost } from '../src/app/api/v1/archives/inspect/route';
import { create7zArchive, get7zBinaryPath, inspectArchive } from '../src/lib/conversions';
import { CONCURRENCY_LIMIT_PROBLEM_TYPE, acquireSyncSlot, syncSlotsInUse } from '../src/lib/queue/concurrency-limit';
import { SINGLE_REQUEST_FILE_MAX_BYTES } from '../src/lib/plan-limits';
import { executeSandboxedBinary } from '../src/lib/security/process-sandbox';
import { createSessionToken } from '../src/lib/auth/session';
import { userStore } from '../src/lib/auth/user-store';
import { storageProvider } from '../src/lib/storage';
import { skipUnless } from './helpers/strict-skip';

/**
 * POST /api/v1/archives/inspect runs on the web process. It used to load a stored object of up to 512 MiB before looking at its size, write
 * the archive out and wait for the 7-Zip listing with a synchronous call (up to 30 s with the event loop stopped), with no slot and no
 * deadline. It now asks the store for the size first, lists through the asynchronous sandboxed runner, and holds a slot and a deadline
 * like /api/v1/convert.
 */

const ROUTE_URL = 'http://localhost:3000/api/v1/archives/inspect';
const MIB = 1024 * 1024;
const sandboxed = vi.mocked(executeSandboxedBinary);

async function account(tier: 'free' | 'paid') {
  const email = `inspect_${tier}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@inspect-bounded.test`;
  const user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'Inspector', tier, emailVerified: true }));
  return { user, headers: { 'Content-Type': 'application/json', Cookie: `easyconvert_session=${createSessionToken(user)}` } };
}

function inspectStored(headers: Record<string, string>, storageKey: string): Promise<Response> {
  return inspectPost(new NextRequest(ROUTE_URL, { method: 'POST', headers, body: JSON.stringify({ storageKey }) }));
}

afterEach(() => {
  vi.restoreAllMocks();
  sandboxed.mockClear();
});

describe('a stored archive that is too large to inspect', () => {
  it('is refused with 413 from its size, and is never read', async () => {
    const { user, headers } = await account('paid');
    const key = `conversions/${user.id}/big.7z`;
    vi.spyOn(storageProvider, 'stat').mockResolvedValue({ size: SINGLE_REQUEST_FILE_MAX_BYTES + 1 } as Awaited<ReturnType<typeof storageProvider.stat>>);
    const read = vi.spyOn(storageProvider, 'getObject');

    const res = await inspectStored(headers, key);

    expect(res.status).toBe(413);
    expect((await res.json()).detail).toContain(`${SINGLE_REQUEST_FILE_MAX_BYTES / MIB} MiB`);
    expect(read).not.toHaveBeenCalled();
  });

  it('answers 404 for an object the store does not hold, without reading it', async () => {
    const { user, headers } = await account('paid');
    vi.spyOn(storageProvider, 'stat').mockResolvedValue(null);
    const read = vi.spyOn(storageProvider, 'getObject');

    const res = await inspectStored(headers, `conversions/${user.id}/missing.7z`);

    expect(res.status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('the slot of an inspection', () => {
  beforeEach(() => {
    vi.spyOn(storageProvider, 'stat').mockResolvedValue({ size: 10 } as Awaited<ReturnType<typeof storageProvider.stat>>);
    vi.spyOn(storageProvider, 'getObject').mockResolvedValue(undefined);
  });

  it('is refused with 429 for a caller whose conversions already fill its slots', async () => {
    const { user, headers } = await account('free');
    const held = [];
    for (;;) {
      const slot = await acquireSyncSlot(user.id, 'free');
      if (!slot.granted) break;
      held.push(slot);
    }
    try {
      const res = await inspectStored(headers, `conversions/${user.id}/a.7z`);
      expect(res.status).toBe(429);
      expect((await res.json()).type).toBe(CONCURRENCY_LIMIT_PROBLEM_TYPE);
    } finally {
      for (const slot of held) slot.release();
    }
  });

  it('is held while the inspection runs and given back when it ends', async () => {
    const { user, headers } = await account('free');
    const before = syncSlotsInUse();

    const res = await inspectStored(headers, `conversions/${user.id}/a.7z`);

    expect(res.status).toBe(404);
    expect(syncSlotsInUse()).toBe(before);
  });
});

describe.skipIf(skipUnless('7-Zip', get7zBinaryPath() !== null))('the 7-Zip listing of an inspection', () => {
  const sevenZip = () => create7zArchive([{ filename: 'a.txt', buffer: Buffer.from('hello') }]).buffer;

  it('runs through the asynchronous sandboxed runner', async () => {
    const inspection = await inspectArchive(sevenZip());

    expect(inspection.entries.map((entry) => entry.name)).toEqual(['a.txt']);
    const listing = sandboxed.mock.calls.find(([, args]) => args[0] === 'l');
    expect(listing).toBeDefined();
  });

  it('stops when the request is aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('the client is gone'));

    await expect(inspectArchive(sevenZip(), { signal: controller.signal })).rejects.toThrow('the client is gone');
  });
});
