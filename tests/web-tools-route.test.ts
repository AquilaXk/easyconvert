import type Redis from 'ioredis';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as mergeRoute } from '../src/app/api/tools/merge/route';
import { POST as archiveCreateRoute } from '../src/app/api/tools/archive-create/route';
import { POST as archiveExtractRoute } from '../src/app/api/tools/archive-extract/route';
import { POST as splitRoute } from '../src/app/api/tools/split/route';
import { POST as rotateRoute } from '../src/app/api/tools/rotate/route';
import { POST as convertRoute } from '../src/app/api/convert/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { anonymousUserId } from '../src/lib/auth/anonymous-identity';
import { acquireSyncSlot, type ConversionSlot } from '../src/lib/queue/concurrency-limit';
import { ANONYMOUS_DAILY_CONVERSIONS } from '../src/lib/plan-limits';
import { MAX_EXTRACTED_BYTES, MAX_EXTRACTED_ENTRIES, MAX_TOOL_FILES, MAX_TOOL_OPTIONS_CHARS, MAX_TOOL_OUTPUT_BYTES } from '../src/lib/tools/tool-names';
import { assertToolInput, fileOutput, parseToolOptions, WebToolRefusal } from '../src/lib/tools/web-tools';
import { rotatePdfPages } from '../src/lib/conversions';

/**
 * The tool routes of the web application: one run is one conversion (a merge of five files costs one, a failed run costs
 * none), the limits of the job graph hold, and an anonymous caller meets the allowance and the rate limit of /api/convert.
 */

const ROUTES: Record<string, (request: NextRequest) => Promise<Response>> = {
  merge: mergeRoute,
  'archive-create': archiveCreateRoute,
  'archive-extract': archiveExtractRoute,
  split: splitRoute,
  rotate: rotateRoute,
};
const MIB = 1024 * 1024;
const FREE_CONCURRENCY = 5;
let nextClient = 1;

function visitor() {
  const ip = `198.51.100.${nextClient++}`;
  return {
    userId: anonymousUserId(ip),
    headers: { 'x-forwarded-for': ip },
    remaining: async () => (await redisKeyStore.getQuotaUsage(anonymousUserId(ip))).remaining,
  };
}
type Visitor = ReturnType<typeof visitor>;

async function pdfWith(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200 + i, 300]);
  return Buffer.from(await doc.save());
}

interface Upload { name: string; content: Buffer | string }

function run(client: Visitor, tool: string, uploads: Upload[], options?: object) {
  const form = new FormData();
  for (const upload of uploads) form.append('files', new File([upload.content], upload.name));
  if (options) form.append('options', JSON.stringify(options));
  const request = new NextRequest(`http://localhost/api/tools/${tool}`, { method: 'POST', headers: client.headers, body: form });
  return ROUTES[tool](request);
}

/** A run whose `options` field is sent as written, to hold the route to what it reads of it. */
function runRaw(client: Visitor, tool: string, uploads: Upload[], options: string) {
  const form = new FormData();
  for (const upload of uploads) form.append('files', new File([upload.content], upload.name));
  form.append('options', options);
  const request = new NextRequest(`http://localhost/api/tools/${tool}`, { method: 'POST', headers: client.headers, body: form });
  return ROUTES[tool](request);
}

async function zipNames(res: Response): Promise<string[]> {
  return Object.keys((await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()))).files).sort();
}

let redisClients: { keys: Redis | null; users: Redis | null };

beforeEach(() => {
  redisClients = { keys: redisKeyStore.getRedisClient(), users: redisUserStore.getRedisClient() };
  redisKeyStore.setRedisClient(null);
  redisUserStore.setRedisClient(null);
  vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
  vi.stubEnv('ANONYMOUS_DAILY_LIMIT', String(ANONYMOUS_DAILY_CONVERSIONS));
  redisKeyStore.resetStore();
});

afterEach(() => {
  vi.unstubAllEnvs();
  redisKeyStore.setRedisClient(redisClients.keys);
  redisUserStore.setRedisClient(redisClients.users);
});

describe('merge', () => {
  it('joins the PDFs in the order sent into one file and charges one conversion', async () => {
    const client = visitor();
    const before = await client.remaining();
    const res = await run(client, 'merge', [
      { name: 'a.pdf', content: await pdfWith(2) },
      { name: 'b.pdf', content: await pdfWith(1) },
      { name: 'c.pdf', content: await pdfWith(3) },
    ]);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const merged = await PDFDocument.load(Buffer.from(await res.arrayBuffer()));
    expect(merged.getPages().map((page) => page.getWidth())).toEqual([200, 201, 200, 200, 201, 202]);
    expect(await client.remaining()).toBe(before - 1);
  });

  it.each([
    ['one file', [{ name: 'a.pdf', content: 'x' }], 'too_few_files'],
    ['a file that is not a PDF', [{ name: 'a.pdf', content: 'not a pdf' }, { name: 'b.pdf', content: 'not a pdf' }], 'spoofed_file'],
    ['a file of another format', [{ name: 'a.txt', content: 'hello' }, { name: 'b.txt', content: 'hello' }], 'unsupported_input'],
    ['an empty file', [{ name: 'a.pdf', content: '' }, { name: 'b.pdf', content: '' }], 'empty_file'],
  ])('refuses %s and gives the conversion back', async (_label, uploads, code) => {
    const client = visitor();
    const before = await client.remaining();
    const res = await run(client, 'merge', uploads);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe(code);
    expect(await client.remaining()).toBe(before);
  });
});

describe('create archive', () => {
  const uploads: Upload[] = [
    { name: 'one.txt', content: 'first' },
    { name: 'two.txt', content: 'second' },
    { name: 'two.txt', content: 'same name' },
  ];

  it('packs the files into one ZIP, keeps files of one name apart and charges one conversion', async () => {
    const client = visitor();
    const before = await client.remaining();
    const res = await run(client, 'archive-create', uploads);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(await zipNames(res)).toHaveLength(3);
    expect(await client.remaining()).toBe(before - 1);
  });

  it.each([
    ['7z', [0x37, 0x7a, 0xbc, 0xaf]],
    ['tar.gz', [0x1f, 0x8b]],
  ])('writes a %s archive when asked', async (format, magic) => {
    const res = await run(visitor(), 'archive-create', uploads, { format });
    expect(res.status).toBe(200);
    expect([...Buffer.from(await res.arrayBuffer()).subarray(0, magic.length)]).toEqual(magic);
  });

  it('refuses a format it cannot write (RAR) and gives the conversion back', async () => {
    const client = visitor();
    const before = await client.remaining();
    const res = await run(client, 'archive-create', uploads, { format: 'rar' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_options');
    expect(await client.remaining()).toBe(before);
  });

  it(`refuses more than ${MAX_TOOL_FILES} files`, async () => {
    const client = visitor();
    const before = await client.remaining();
    const res = await run(client, 'archive-create', Array.from({ length: MAX_TOOL_FILES + 1 }, (_, i) => ({ name: `f${i}.txt`, content: 'x' })));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('too_many_files');
    expect(await client.remaining()).toBe(before);
  });
});

describe('extract archive', () => {
  async function zipOf(entries: Record<string, string | Buffer>): Promise<Buffer> {
    const zip = new JSZip();
    for (const [name, content] of Object.entries(entries)) zip.file(name, content);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  it('lists each file with its bytes and charges one conversion', async () => {
    const client = visitor();
    const before = await client.remaining();
    const res = await run(client, 'archive-extract', [{ name: 'bundle.zip', content: await zipOf({ 'a.txt': 'alpha', 'dir/b.txt': 'beta' }) }]);
    expect(res.status).toBe(200);
    const { entries } = await res.json();
    expect(entries.map((entry: { name: string; size: number }) => [entry.name, entry.size])).toEqual([['a.txt', 5], ['b.txt', 4]]);
    expect(Buffer.from(entries[1].data, 'base64').toString()).toBe('beta');
    expect(await client.remaining()).toBe(before - 1);
  });

  it('keeps two entries of one name apart', async () => {
    const res = await run(visitor(), 'archive-extract', [{ name: 'bundle.zip', content: await zipOf({ 'x/a.txt': '1', 'y/a.txt': '2' }) }]);
    const names = (await res.json()).entries.map((entry: { name: string }) => entry.name);
    expect(new Set(names).size).toBe(2);
  });

  it('never lists a name that leaves the folder: a traversal entry is refused or named by its leaf', async () => {
    const client = visitor();
    const before = await client.remaining();
    const res = await run(client, 'archive-extract', [{ name: 'evil.zip', content: await zipOf({ '../../etc/evil.txt': 'x', 'ok.txt': 'y' }) }]);
    if (res.status === 200) {
      const names = (await res.json()).entries.map((entry: { name: string }) => entry.name);
      for (const name of names) expect(name).not.toMatch(/[\\/]|\.\./);
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await client.remaining()).toBe(before);
    }
  });

  it('refuses an archive that unpacks to far more than it weighs and gives the conversion back', async () => {
    const client = visitor();
    const before = await client.remaining();
    const bomb = await zipOf({ 'zeros.bin': Buffer.alloc(200 * MIB) });
    expect(bomb.length).toBeLessThan(2 * MIB);
    const res = await run(client, 'archive-extract', [{ name: 'bomb.zip', content: bomb }]);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await client.remaining()).toBe(before);
  }, 60_000);

  it(`refuses an archive of more than ${MAX_EXTRACTED_ENTRIES} files before unpacking it, and gives the conversion back`, async () => {
    const client = visitor();
    const before = await client.remaining();
    const entries = Object.fromEntries(Array.from({ length: MAX_EXTRACTED_ENTRIES + 1 }, (_, i) => [`f${i}.txt`, 'x']));
    const res = await run(client, 'archive-extract', [{ name: 'many.zip', content: await zipOf(entries) }]);
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('input_over_limit');
    expect(await client.remaining()).toBe(before);
  });

  it('refuses an archive that declares more than the listing carries before unpacking it', async () => {
    const client = visitor();
    const before = await client.remaining();
    const res = await run(client, 'archive-extract', [{ name: 'big.zip', content: await zipOf({ 'zeros.bin': Buffer.alloc(MAX_EXTRACTED_BYTES + 1) }) }]);
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('input_over_limit');
    expect(await client.remaining()).toBe(before);
  });

  it('refuses a file that is not an archive', async () => {
    const res = await run(visitor(), 'archive-extract', [{ name: 'a.txt', content: 'x' }]);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('unsupported_input');
  });
});

describe('split', () => {
  it('writes one PDF for each range written and charges one conversion', async () => {
    const client = visitor();
    const before = await client.remaining();
    const res = await run(client, 'split', [{ name: 'book.pdf', content: await pdfWith(5) }], { split: { ranges: '1-3,5' } });
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const pageCounts = await Promise.all(Object.values(zip.files).sort((a, b) => a.name.localeCompare(b.name)).map(async (file) => (await PDFDocument.load(await file.async('nodebuffer'))).getPageCount()));
    expect(pageCounts).toEqual([3, 1]);
    expect(await client.remaining()).toBe(before - 1);
  });

  it('writes a file for every page when no range is given', async () => {
    const res = await run(visitor(), 'split', [{ name: 'book.pdf', content: await pdfWith(4) }], {});
    expect(await zipNames(res)).toHaveLength(4);
  });

  it('refuses a page the document does not have and gives the conversion back', async () => {
    const client = visitor();
    const before = await client.remaining();
    const res = await run(client, 'split', [{ name: 'book.pdf', content: await pdfWith(2) }], { split: { ranges: '1-9' } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await client.remaining()).toBe(before);
  });

  it.each(['0', '3-1', 'a-b', '1,,2'])('refuses the page range %j', async (ranges) => {
    const res = await run(visitor(), 'split', [{ name: 'book.pdf', content: await pdfWith(5) }], { split: { ranges } });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('takes one file only', async () => {
    const res = await run(visitor(), 'split', [{ name: 'a.pdf', content: await pdfWith(1) }, { name: 'b.pdf', content: await pdfWith(1) }]);
    expect((await res.json()).code).toBe('too_many_files');
  });
});

describe('rotate', () => {
  it('turns the chosen pages clockwise and leaves the others, charging one conversion', async () => {
    const client = visitor();
    const before = await client.remaining();
    const res = await run(client, 'rotate', [{ name: 'book.pdf', content: await pdfWith(3) }], { rotate: { rotation: 90, pages: '2-3' } });
    expect(res.status).toBe(200);
    const rotated = await PDFDocument.load(Buffer.from(await res.arrayBuffer()));
    expect(rotated.getPages().map((page) => page.getRotation().angle)).toEqual([0, 90, 90]);
    expect(await client.remaining()).toBe(before - 1);
  });

  it('turns every page when none is named', async () => {
    const res = await run(visitor(), 'rotate', [{ name: 'book.pdf', content: await pdfWith(2) }], { rotate: { rotation: 180 } });
    const rotated = await PDFDocument.load(Buffer.from(await res.arrayBuffer()));
    expect(rotated.getPages().map((page) => page.getRotation().angle)).toEqual([180, 180]);
  });

  it.each([45, 0, 360])('refuses a rotation of %i and gives the conversion back', async (rotation) => {
    const client = visitor();
    const before = await client.remaining();
    const res = await run(client, 'rotate', [{ name: 'book.pdf', content: await pdfWith(1) }], { rotate: { rotation } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await client.remaining()).toBe(before);
  });
});

describe('the options of a run', () => {
  const ROTATE_OPTIONS_HANG_GUARD_MS = 10_000;

  it('refuses a field longer than the limit before anything reads it, however many rotations it lists', async () => {
    const client = visitor();
    const before = await client.remaining();
    const groups = Array.from({ length: 20_000 }, () => ({ rotation: 90, pages: '1' }));
    const options = JSON.stringify({ rotate: { rotations: groups } });
    expect(options.length).toBeGreaterThan(MAX_TOOL_OPTIONS_CHARS);
    const started = performance.now();
    const res = await runRaw(client, 'rotate', [{ name: 'book.pdf', content: await pdfWith(2) }], options);
    expect(performance.now() - started).toBeLessThan(ROTATE_OPTIONS_HANG_GUARD_MS);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_options');
    expect(await client.remaining()).toBe(before);
  });

  it('refuses a list of rotations of any length, as the web tool takes one rotation and its pages', async () => {
    const res = await runRaw(visitor(), 'rotate', [{ name: 'book.pdf', content: await pdfWith(2) }], JSON.stringify({ rotate: { rotations: [{ rotation: 90 }] } }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_options');
  });

  it('copies only the keys of the tool: an engine control or a key of another tool never reaches an engine', () => {
    expect(parseToolOptions('rotate', JSON.stringify({ rotate: { rotation: 90, pages: '1', password: 'x', timeoutMs: 1 }, split: { ranges: '1' }, format: '7z', signal: 1 }))).toEqual({ rotate: { rotation: 90, pages: '1' } });
    expect(parseToolOptions('split', JSON.stringify({ split: { ranges: '1-2', password: 'x' }, rotate: { rotation: 90 } }))).toEqual({ split: { ranges: '1-2', everyNPages: undefined } });
    expect(parseToolOptions('archive-create', JSON.stringify({ format: '7z', password: 'x', collisionPolicy: 'overwrite' }))).toEqual({ format: '7z' });
    expect(parseToolOptions('merge', JSON.stringify({ passwords: ['x'], confirmEditRights: true }))).toEqual({});
  });

  it.each([
    ['rotate', { rotate: { rotation: '90' } }],
    ['rotate', { rotate: { rotation: 90, pages: 5 } }],
    ['split', { split: { everyNPages: 1.5 } }],
    ['split', { split: 'all' }],
    ['archive-create', { format: ['zip'] }],
  ])('refuses the wrong kind of value in the options of %s: %j', (tool, options) => {
    expect(() => parseToolOptions(tool as 'rotate', JSON.stringify(options))).toThrowError(WebToolRefusal);
  });

  it('turns a page 20,001 times in the engine without the work growing with the square of the groups', async () => {
    const groups = Array.from({ length: 20_001 }, () => ({ rotation: 90 as const, pages: '1' }));
    const started = performance.now();
    const rotated = await PDFDocument.load(await rotatePdfPages(await pdfWith(2), { rotations: groups }));
    expect(performance.now() - started).toBeLessThan(ROTATE_OPTIONS_HANG_GUARD_MS);
    expect(rotated.getPages().map((page) => page.getRotation().angle)).toEqual([90, 0]);
  });
});

describe('the answer of a run', () => {
  it('is refused as too large past the size one answer carries', () => {
    expect(() => fileOutput('big.zip', 'application/zip', Buffer.alloc(MAX_TOOL_OUTPUT_BYTES + 1))).toThrowError(WebToolRefusal);
    expect(fileOutput('ok.zip', 'application/zip', Buffer.alloc(10))).toMatchObject({ kind: 'file', filename: 'ok.zip' });
  });
});

describe('the size of a run', () => {
  const pdf = (bytes: number) => ({ name: 'a.pdf', buffer: Buffer.alloc(bytes) });

  it('is refused when the files together are larger than one request takes', () => {
    expect(() => assertToolInput('merge', [pdf(33 * MIB), pdf(33 * MIB)])).toThrowError(WebToolRefusal);
    try {
      assertToolInput('merge', [pdf(33 * MIB), pdf(33 * MIB)]);
    } catch (error) {
      expect(error).toMatchObject({ status: 413, code: 'input_over_limit' });
    }
  });
});

describe('who may run a tool, and how often', () => {
  it('stops an anonymous caller at the daily allowance with the refusal /api/convert gives', async () => {
    vi.stubEnv('ANONYMOUS_DAILY_LIMIT', '2');
    const client = visitor();
    const uploads = [{ name: 'a.pdf', content: await pdfWith(1) }, { name: 'b.pdf', content: await pdfWith(1) }];
    expect((await run(client, 'merge', uploads)).status).toBe(200);
    expect((await run(client, 'merge', uploads)).status).toBe(200);
    const refused = await run(client, 'merge', uploads);
    const form = new FormData();
    form.append('file', new File(['a,b\n1,2\n'], 'a.csv'));
    form.append('targetFormat', 'json');
    const viaConvert = await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', headers: client.headers, body: form }));
    expect(refused.status).toBe(429);
    expect(viaConvert.status).toBe(429);
    expect((await refused.json()).type).toBe((await viaConvert.json()).type);
  });

  it('treats visitors no proxy tells apart as /api/convert does: the shared identity has no daily allowance to spend', async () => {
    vi.stubEnv('TRUSTED_PROXIES', 'none');
    const form = new FormData();
    form.append('file', new File(['a,b\n1,2\n'], 'a.csv'));
    form.append('targetFormat', 'json');
    const viaConvert = await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', body: form }));
    const res = await run({ headers: {} } as Visitor, 'merge', [{ name: 'a.pdf', content: await pdfWith(1) }, { name: 'b.pdf', content: await pdfWith(1) }]);
    expect(res.status).toBe(viaConvert.status);
  });

  it('holds the concurrency limit of /api/convert: no sixth run at once for one caller', async () => {
    const client = visitor();
    const held: ConversionSlot[] = [];
    for (let i = 0; i < FREE_CONCURRENCY; i++) held.push(await acquireSyncSlot(client.userId, 'anonymous'));
    const before = await client.remaining();
    const res = await run(client, 'merge', [{ name: 'a.pdf', content: await pdfWith(1) }, { name: 'b.pdf', content: await pdfWith(1) }]);
    held.forEach((slot) => slot.granted && slot.release());
    expect(res.status).toBe(429);
    expect(await client.remaining()).toBe(before);
  });

  it('answers 415 for a body that is not a form', async () => {
    const client = visitor();
    const plain = await mergeRoute(new NextRequest('http://localhost/api/tools/merge', { method: 'POST', headers: { ...client.headers, 'content-type': 'application/json' }, body: '{}' }));
    expect(plain.status).toBe(415);
  });
});
