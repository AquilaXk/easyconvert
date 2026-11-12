import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { NextRequest } from 'next/server';
import sharp from 'sharp';
import { POST as createJob } from '../src/app/api/v1/jobs/route';
import { graphScheduler } from '../src/lib/queue/graph';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { s3Storage } from '../src/lib/storage/s3-storage';

/**
 * The thumbnail and metadata tasks as jobs of the public API: a graph that holds only one of them is accepted without a
 * `targetFormat` (a thumbnail names its own, metadata makes JSON, metadata.write keeps the file's format), and a request the
 * task cannot serve is refused with a 422 problem naming the node before a unit is reserved.
 */

describe('thumbnail and metadata graphs through POST /api/v1/jobs', () => {
  let authHeaders: Record<string, string>;
  let userId: string;
  let initGraph: MockInstance<typeof graphScheduler.initGraph>;

  beforeEach(async () => {
    const user = await userStore.createUser({ email: `tm_${Date.now()}_${Math.random().toString(36).slice(2)}@tm.test`, name: 'tm', tier: 'pro' });
    userId = user.id;
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'tm', { scopes: ['convert:read', 'convert:write'] });
    authHeaders = { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' };
    initGraph = vi.spyOn(graphScheduler, 'initGraph');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function submit(filename: string, bytes: Buffer, mime: string, nodes: Record<string, unknown>) {
    const storageKey = `uploads/${userId}/${filename}`;
    s3Storage.saveObject(storageKey, bytes, mime, filename);
    const res = await createJob(
      new NextRequest('https://easyconvert.app/api/v1/jobs', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ storageKey, filename, graph: { nodes: { src: { op: 'import.upload', storageKey }, ...nodes } } }),
      })
    );
    return { res, json: await res.json() };
  }

  const png = (): Promise<Buffer> => sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer();

  it.each([
    ['thumbnail', { t: { op: 'thumbnail', input: 'src', targetFormat: 'webp', options: { thumbnail: { width: 120, height: 80, fit: 'cover', page: 1 } } }, out: { op: 'export.internal', input: 't' } }],
    ['metadata', { m: { op: 'metadata', input: 'src' }, out: { op: 'export.internal', input: 'm' } }],
    ['metadata.write', { w: { op: 'metadata.write', input: 'src', options: { metadata: { set: { Artist: 'Ann', 'XMP:Title': 'T' } } } }, out: { op: 'export.internal', input: 'w' } }],
  ])('accepts a %s graph without a top-level targetFormat and runs it as a graph', async (_name, nodes) => {
    const { res, json } = await submit('pic.png', await png(), 'image/png', nodes);
    expect(res.status, JSON.stringify(json)).toBeLessThan(300);
    expect(initGraph).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a width under 16', { width: 15 }],
    ['a width over 7680', { width: 7681 }],
    ['a height over 7680', { height: 9000 }],
    ['a height that is not whole', { height: 64.5 }],
    ['a frame time with a sign', { at: ['-5'] }],
    ['a frame time that is an option', { at: ['--version'] }],
    ['a frame time with a command in it', { at: ['1;rm'] }],
    ['an unknown fit', { fit: 'stretch' }],
    ['a page of 0', { page: 0 }],
  ])('refuses %s at submission with a 422 that names the field, and reserves nothing', async (_what, thumbnail) => {
    const quotaBefore = JSON.stringify(await redisKeyStore.getQuotaUsage(userId));
    const { res, json } = await submit('pic.png', await png(), 'image/png', { t: { op: 'thumbnail', input: 'src', targetFormat: 'png', options: { thumbnail } }, out: { op: 'export.internal', input: 't' } });
    expect(res.status, JSON.stringify(json)).toBe(422);
    expect(JSON.stringify(json.invalidParams)).toContain('thumbnail');
    expect(initGraph).not.toHaveBeenCalled();
    expect(JSON.stringify(await redisKeyStore.getQuotaUsage(userId))).toBe(quotaBefore);
  });

  it('refuses a thumbnail whose format is not JPEG, PNG or WebP, naming the node', async () => {
    const { res, json } = await submit('pic.png', await png(), 'image/png', { t: { op: 'thumbnail', input: 'src', targetFormat: 'gif' }, out: { op: 'export.internal', input: 't' } });
    expect(res.status).toBe(422);
    expect(json.invalidParams[0].name).toContain('nodes.t');
    expect(initGraph).not.toHaveBeenCalled();
  });

  it('refuses metadata.write on a format it cannot write, and without fields, before a unit is reserved', async () => {
    const quotaBefore = JSON.stringify(await redisKeyStore.getQuotaUsage(userId));
    const docx = await submit('letter.docx', Buffer.from('PK\u0003\u0004'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', {
      w: { op: 'metadata.write', input: 'src', options: { metadata: { set: { Title: 'T' } } } },
      out: { op: 'export.internal', input: 'w' },
    });
    expect(docx.res.status).toBe(422);
    expect(docx.json.invalidParams).toEqual([{ name: 'nodes.w.input', reason: expect.stringMatching(/writes into jpg, jpeg, png, pdf files, but input "src" produces "docx"/) }]);

    const empty = await submit('pic.png', await png(), 'image/png', { w: { op: 'metadata.write', input: 'src' }, out: { op: 'export.internal', input: 'w' } });
    expect(empty.res.status).toBe(422);
    expect(empty.json.invalidParams[0].name).toBe('nodes.w.options.metadata.set');
    expect(initGraph).not.toHaveBeenCalled();
    expect(JSON.stringify(await redisKeyStore.getQuotaUsage(userId))).toBe(quotaBefore);
  });

  it('refuses a metadata field value of the wrong type at the schema', async () => {
    const { res } = await submit('pic.png', await png(), 'image/png', {
      w: { op: 'metadata.write', input: 'src', options: { metadata: { set: { Artist: { nested: true } } } } },
      out: { op: 'export.internal', input: 'w' },
    });
    expect(res.status).toBe(422);
  });
});
