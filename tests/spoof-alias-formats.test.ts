import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { POST as v1JobsPost } from '../src/app/api/v1/jobs/route';
import { POST as queueJobsPost } from '../src/app/api/queue/jobs/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { isFormatCompatibleWithMagicBytes } from '../src/lib/registry';
import { assertNotSpoofedFile, spoofCheckRefusal } from '../src/lib/security/file-guard';
import { FileExtensionSpoofError } from '../src/lib/types';

/**
 * A format id that is a file of another format under a name of its own is held to the signature of that format: PDF/A is a PDF,
 * the generic presentation an Office Open XML presentation, an animated WebP a WebP, ALAC an MP4 audio file, a 7-Zip tarball a
 * 7-Zip archive, a Keynote bundle a Keynote package. Every refusal of the spoof check, on every route, carries the code `spoofed_file`.
 */

const FIXTURES = path.join(__dirname, 'fixtures');
const PDF = fs.readFileSync(path.join(FIXTURES, 'sample.pdf'));
const PPTX = fs.readFileSync(path.join(FIXTURES, 'zip-packages', 'pptx-names-only.pptx'));
const PE_HEADER = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00]);
const PADDING = Buffer.alloc(64);

const header = (...parts: Array<Buffer | string>): Buffer => Buffer.concat([...parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'latin1') : part)), PADDING]);
/** An animated WebP opens with the same RIFF/WEBP header as a still one; the extended header says it animates. */
const ANIMATED_WEBP = header('RIFF', Buffer.from([0x40, 0, 0, 0]), 'WEBPVP8X', Buffer.from([0x0a, 0, 0, 0, 0x12, 0, 0, 0]));
/** ISO/IEC 14496-12: a `ftyp` box with the major brand `M4A `, which an ALAC file carries. */
const ALAC_IN_M4A = header(Buffer.from([0, 0, 0, 0x20]), 'ftypM4A ', Buffer.from([0, 0, 0, 0]), 'M4A mp42isom');
const SEVEN_ZIP = header(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]));
const ZIP = header(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

describe('the spoof check holds an alias id to the format it stands for', () => {
  it.each([
    ['pdfa', PDF],
    ['presentation', PPTX],
    ['webpvideo', ANIMATED_WEBP],
    ['alac', ALAC_IN_M4A],
    ['tar.7z', SEVEN_ZIP],
    ['keynotes', ZIP],
  ])('accepts a real %s file under its id and under its extension', (id, bytes) => {
    expect(isFormatCompatibleWithMagicBytes(bytes, id)).toBe(true);
    expect(() => assertNotSpoofedFile(bytes, id, `file.${id}`)).not.toThrow();
  });

  it.each([
    ['pdfa', PPTX],
    ['presentation', PDF],
    ['webpvideo', PDF],
    ['alac', PDF],
    ['tar.7z', PDF],
    ['keynotes', PDF],
  ])('still refuses a file of another kind named %s', (id, bytes) => {
    expect(() => assertNotSpoofedFile(bytes, id, `file.${id}`)).toThrow(FileExtensionSpoofError);
  });

  it('refuses a JPEG named .avif and a gzip named .tz, which are no alias of anything', () => {
    const jpeg = header(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    expect(() => assertNotSpoofedFile(jpeg, 'avif', 'photo.avif')).toThrow(FileExtensionSpoofError);
    expect(() => assertNotSpoofedFile(header(Buffer.from([0x1f, 0x8b, 8, 0])), 'tz', 'tree.tz')).toThrow(FileExtensionSpoofError);
  });
});

describe('every spoof refusal carries a code', () => {
  it('names the code of a spoofed extension and of an encrypted package', () => {
    expect(spoofCheckRefusal(new FileExtensionSpoofError('x'))).toMatchObject({ status: 400, code: 'spoofed_file' });
    expect(spoofCheckRefusal(new Error('x'))).toBeUndefined();
  });

  let key: string;
  beforeEach(async () => {
    const user = await userStore.createUser({
      name: 'Spoof Tester',
      email: `spoof_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
      tier: 'paid',
    });
    key = (await redisKeyStore.generateApiKey(user.id, 'Spoof Key', { scopes: ['convert:write', 'convert:read'] })).secretKey;
  });

  const multipart = (url: string, fields: Record<string, string>, bytes: Buffer, name: string): NextRequest => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)]), name);
    for (const [field, value] of Object.entries(fields)) form.append(field, value);
    return new NextRequest(url, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  };

  it('POST /api/v1/convert answers a spoofed file with code spoofed_file', async () => {
    const res = await v1ConvertPost(multipart('http://localhost/api/v1/convert', { targetFormat: 'png' }, PE_HEADER, 'fake.pdf'));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'spoofed_file', title: 'File Spoofing Detected' });
  });

  it('POST /api/v1/convert reads a PDF sent as sourceFormat=pdfa as a PDF', async () => {
    const res = await v1ConvertPost(multipart('http://localhost/api/v1/convert', { targetFormat: 'txt', sourceFormat: 'pdfa' }, PDF, 'doc.pdf'));
    const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
    expect(body.code).not.toBe('spoofed_file');
    expect(body.error ?? '').not.toContain('File spoofing rejected');
  });

  it('POST /api/v1/jobs answers a spoofed inline file with code spoofed_file', async () => {
    const res = await v1JobsPost(
      new NextRequest('http://localhost/api/v1/jobs', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'fake.pdf', targetFormat: 'png', inputBufferBase64: PE_HEADER.toString('base64') }),
      })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'spoofed_file' });
  });

  it('POST /api/queue/jobs answers a spoofed file with code spoofed_file', async () => {
    const res = await queueJobsPost(multipart('http://localhost/api/queue/jobs', { targetFormat: 'png' }, PE_HEADER, 'fake.pdf'));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, code: 'spoofed_file' });
  });
});
