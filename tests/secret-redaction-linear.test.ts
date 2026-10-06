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

/**
 * Redaction runs on every log row, response and webhook, on text an attacker partly controls, so
 * its cost must grow in step with the input. Shapes below made earlier scanners re-read the rest
 * of the text once per occurrence.
 */
const MIB = 1024 * 1024;
const SMALL = MIB / 4;
const SHAPE_BUDGET_MS = 1_500;
const MAX_GROWTH_FOR_4X_INPUT = 8;
const MIN_MEASURABLE_MS = 5;

function elapsedMs(fn: () => void): number {
  const started = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

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
  for (const [name, unit] of Object.entries(SHAPES)) {
    it(`${name}: 1 MiB is scanned within the budget and 4x the input costs under ${MAX_GROWTH_FOR_4X_INPUT}x`, () => {
      const small = repeatTo(unit, SMALL);
      const large = repeatTo(unit, MIB);
      redactText(repeatTo(unit, SMALL / 8)); // warm up
      const smallMs = Math.max(elapsedMs(() => redactText(small)), MIN_MEASURABLE_MS);
      const largeMs = elapsedMs(() => redactText(large));
      expect(largeMs).toBeLessThan(SHAPE_BUDGET_MS);
      expect(largeMs / smallMs).toBeLessThan(MAX_GROWTH_FOR_4X_INPUT);
    });
  }

  it('one line of 1 MiB of repeated pairs', () => {
    const line = repeatTo('password=a token:b ', MIB);
    expect(elapsedMs(() => redactText(line))).toBeLessThan(SHAPE_BUDGET_MS);
  });
});

describe('a large free-text option does not stall the API', () => {
  const NOTE_BYTES = 220 * 1024;
  const REQUEST_BUDGET_MS = 3_000;

  it('answers POST and GET quickly for a convert option full of unclosed groups', async () => {
    vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => [{ address: '93.184.215.14', family: 4 }]) as never);
    const email = `linear_${Date.now()}_${Math.random().toString(36).slice(2)}@linear.test`;
    const user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'linear', tier: 'pro' }));
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'linear', { scopes: ['convert:read', 'convert:write'] });
    const headers = { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' };
    const storageKey = `uploads/${user.id}/linear.csv`;
    s3Storage.saveObject(storageKey, Buffer.from('a,b\n1,2\n'), 'text/csv', 'linear.csv');
    const note = repeatTo('password={\n', NOTE_BYTES);

    const started = Date.now();
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
    const total = Date.now() - started;
    await graphScheduler.cancelGraph(created.jobId, 'test cleanup');
    vi.restoreAllMocks();

    expect(post.status).toBe(202);
    expect(got.status).toBe(200);
    expect(total).toBeLessThan(REQUEST_BUDGET_MS);
  });
});
