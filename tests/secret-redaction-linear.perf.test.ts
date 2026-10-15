import { describe, it, expect } from 'vitest';
import dns from 'node:dns';
import { NextRequest } from 'next/server';
import { vi } from 'vitest';
import { POST as createJob } from '../src/app/api/v1/jobs/route';
import { GET as getJob } from '../src/app/api/v1/jobs/[id]/route';
import { graphScheduler } from '../src/lib/queue/graph';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { redactText } from '../src/lib/security/redact';
import { expectLinearOnInputs, expectNoSlowerThanReference, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

/**
 * Timing-ratio checks moved out of secret-redaction-linear.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in secret-redaction-linear.test.ts.
 */

const MIB = 1024 * 1024;
/** Sixteen times the input: linear work (with allocator and GC growth) measured 17-24x, quadratic work 256x. */
const GROWTH_FACTOR = 16;
const SMALL = MIB / GROWTH_FACTOR;
/** Twice the growth factor, as the shared linear bound allows, and far below the 256x of a rescanning scanner. */
const MAX_GROWTH_RATIO = GROWTH_FACTOR * 2;

function repeatTo(unit: string, size: number): string {
  return unit.repeat(Math.ceil(size / unit.length));
}

const SHAPES: Record<string, string> = {
  'unclosed brace groups': 'password={\n',
  'unclosed bracket groups': 'password=[\n',
  'unclosed headers groups': 'headers: {\n',
  'unclosed groups on one line': 'password={ ',
  'nested openers': 'token=[{[{\n',
  'whitespace after a key': 'password:' + ' '.repeat(255) + '\n',
  'values on the next line': 'password:\n',
  'unterminated quotes': 'password="\n',
  'escaped quotes': 'password=\\"\n',
  'keys without values': 'password \n',
};

describe('redaction scales linearly', () => {
  // 16x the input may cost at most 32x the time, interleaved and best of N (tests/helpers/timing.ts); a scanner
  // that re-reads the rest of the text once per occurrence costs 256x. No wall-clock budget is involved.
  for (const [name, unit] of Object.entries(SHAPES)) {
    it(`${name}: ${GROWTH_FACTOR}x the input costs under ${MAX_GROWTH_RATIO}x`, async () => {
      await expectLinearOnInputs(name, (text: string) => redactText(text), {
        small: repeatTo(unit, SMALL),
        large: repeatTo(unit, MIB),
        factor: GROWTH_FACTOR,
      });
    }, SCALING_TEST_TIMEOUT_MS);
  }

  it('one line of repeated pairs', async () => {
    const { largeResult } = await expectLinearOnInputs('repeated pairs', (text: string) => redactText(text), {
      small: repeatTo('password=a token:b ', SMALL),
      large: repeatTo('password=a token:b ', MIB),
      factor: GROWTH_FACTOR,
    });
    // An unquoted value runs to the end of the line, and the whole input is one line.
    expect(largeResult).toBe('password=***');
  }, SCALING_TEST_TIMEOUT_MS);
});

describe('a large free-text option does not stall the API', () => {
  const NOTE_BYTES = 220 * 1024;

  it('answers POST and GET for a convert option full of unclosed groups as fast as for a plain option of the same size', async () => {
    vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => [{ address: '93.184.215.14', family: 4 }]) as never);
    const email = `linear_${Date.now()}_${Math.random().toString(36).slice(2)}@linear.test`;
    const user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'linear', tier: 'pro' }));
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'linear', { scopes: ['convert:read', 'convert:write'] });
    const headers = { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' };
    const storageKey = `uploads/${user.id}/linear.csv`;
    s3Storage.saveObject(storageKey, Buffer.from('a,b\n1,2\n'), 'text/csv', 'linear.csv');

    /** One POST and GET round trip with the given option text; the job is cancelled afterwards. */
    const roundTrip = async (note: string): Promise<{ post: number; get: number }> => {
      const post = await createJob(
        new NextRequest('https://easyconvert.app/api/v1/jobs', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            storageKey,
            filename: 'linear.csv',
            graph: {
              nodes: {
                up: { op: 'import.upload', storageKey },
                conv: { op: 'convert', input: 'up', targetFormat: 'json', options: { note } },
                out: { op: 'export.internal', input: 'conv' },
              },
            },
          }),
        })
      );
      const created = await post.json();
      const got = await getJob(new NextRequest(`https://easyconvert.app/api/v1/jobs/${created.jobId}`, { headers }), {
        params: { id: created.jobId },
      });
      await got.text();
      await graphScheduler.cancelGraph(created.jobId, 'test cleanup');
      return { post: post.status, get: got.status };
    };

    // The same request with a plain note of the same length is the in-process reference (tests/helpers/timing.ts):
    // the adversarial note may not make the request slower than a small multiple of it.
    try {
      const { largeResult } = await expectNoSlowerThanReference(
        'POST and GET with unclosed groups',
        () => roundTrip('a'.repeat(NOTE_BYTES)),
        () => roundTrip(repeatTo('password={\n', NOTE_BYTES))
      );
      expect(largeResult).toEqual({ post: 202, get: 200 });
    } finally {
      vi.restoreAllMocks();
    }
  }, SCALING_TEST_TIMEOUT_MS);
});
