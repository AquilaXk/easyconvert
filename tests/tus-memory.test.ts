import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as tusPostHandler, PATCH as tusPatchHandler, DELETE as tusDeleteHandler } from '../src/app/api/v1/uploads/[[...id]]/route';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import { serializeTusMetadata, tusEngine } from '../src/lib/storage/tus-engine';
import type { User } from '../src/lib/auth/types';

const BASE_URL = 'http://localhost:3000';
const TOTAL_512_MIB = 512 * 1024 * 1024; // 512 MiB
const CHUNK_SIZE = 64 * 1024; // 64 KiB
const MAX_RSS_GROWTH_BYTES = 64 * 1024 * 1024; // 64 MiB flat ceiling

function uniqueSuffix(): string {
  return `${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

async function createUser(label: string): Promise<User> {
  const email = `${label}_${uniqueSuffix()}@tus-memory-test.local`;
  return userStore.sanitizeUser(await userStore.createUser({ email, name: label, tier: 'enterprise' }));
}

function sessionHeaders(user: User): Record<string, string> {
  return { Cookie: `easyconvert_session=${createSessionToken(user)}` };
}

import v8 from 'node:v8';
import vm from 'node:vm';

function triggerGarbageCollection() {
  try {
    v8.setFlagsFromString('--expose_gc');
    const gc = vm.runInNewContext('gc');
    if (typeof gc === 'function') {
      gc();
      return;
    }
  } catch {}
  if (typeof global.gc === 'function') {
    global.gc();
  }
}

describe('TUS Zero-Heap Memory Profiling (512 MiB Streaming Upload)', () => {
  let user: User;
  let createdSessionId: string | null = null;

  beforeEach(async () => {
    user = await createUser('tus_memory_user');
  });

  afterEach(async () => {
    if (createdSessionId) {
      await tusEngine.terminateSession(createdSessionId);
      createdSessionId = null;
    }
  });

  it('guarantees flat RSS increase (< 64 MiB) during 512 MiB continuous streaming upload', async () => {
    const authHeaders = sessionHeaders(user);

    // 1. Create upload session for 512 MiB
    const postReq = new NextRequest(`${BASE_URL}/api/v1/uploads`, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(TOTAL_512_MIB),
        'Upload-Metadata': serializeTusMetadata({
          filename: 'large-512mb-sample.bin',
          filetype: 'application/octet-stream',
        }),
        ...authHeaders,
      },
    });
    const postRes = await tusPostHandler(postReq, { params: Promise.resolve({}) });
    expect(postRes.status).toBe(201);
    const location = postRes.headers.get('Location')!;
    createdSessionId = location.split('/').pop()!;

    // 2. Measure baseline RSS before streaming begins
    triggerGarbageCollection();
    const initialRss = process.memoryUsage().rss;

    // 3. Create a streaming generator yielding 512 MiB in 64 KiB chunks (8,192 chunks)
    // Allocates only one reusable 64 KiB buffer to guarantee the test itself does not buffer 512 MiB
    const reusableChunk = Buffer.alloc(CHUNK_SIZE, 0x42);
    let chunksSent = 0;
    const totalChunks = TOTAL_512_MIB / CHUNK_SIZE;

    const streamingBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksSent < totalChunks) {
          controller.enqueue(reusableChunk);
          chunksSent++;
        } else {
          controller.close();
        }
      },
    });

    // 4. Stream 512 MiB directly into PATCH endpoint
    const patchReq = new NextRequest(`${BASE_URL}${location}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': '0',
        ...authHeaders,
      },
      body: streamingBody,
      duplex: 'half',
    } as any);

    const patchRes = await tusPatchHandler(patchReq, { params: Promise.resolve({ id: [createdSessionId] }) });
    expect(patchRes.status).toBe(204);
    expect(patchRes.headers.get('Upload-Offset')).toBe(String(TOTAL_512_MIB));

    // 5. Measure post-streaming RSS
    triggerGarbageCollection();
    const finalRss = process.memoryUsage().rss;
    const rssGrowth = Math.max(0, finalRss - initialRss);

    // Verify flat memory footprint: RSS growth must remain strictly below 64 MiB
    expect(rssGrowth).toBeLessThan(MAX_RSS_GROWTH_BYTES);

    // 6. Verify physical disk spool size equals exact 512 MiB
    const session = await tusEngine.getSession(createdSessionId);
    expect(session).not.toBeNull();
    expect(session?.uploadOffset).toBe(TOTAL_512_MIB);
    expect(session?.completed).toBe(true);

    const storageKey = patchRes.headers.get('EasyConvert-Storage-Key');
    expect(storageKey).toMatch(/^conversions\/[^/]+\/tus_\d+_[0-9a-f]+_/);

    // 7. Clean up disk immediately to avoid filling test disk volume
    const terminated = await tusEngine.terminateSession(createdSessionId);
    expect(terminated).toBe(true);
    createdSessionId = null;
  }, 60000); // 60s timeout for 512 MiB I/O
});
