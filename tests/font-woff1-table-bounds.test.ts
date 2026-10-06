import zlib from 'node:zlib';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { POST as convertRoute } from '../src/app/api/convert/route';
import { POST as batchRoute } from '../src/app/api/convert/batch/route';
import { POST as v1ConvertRoute } from '../src/app/api/v1/convert/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { decodeWoff } from '../src/lib/conversions/font';
import { convertFile } from '../src/lib/conversions/index';
import { ConversionFailedError, CorruptStreamError, DecompressionLimitError } from '../src/lib/types';

/**
 * WOFF 1.0 (W3C Recommendation, section 5): each table directory entry carries compLength and
 * origLength, a table is stored verbatim when the two are equal and zlib compressed otherwise, and
 * the inflated size must equal origLength. The containers below are assembled byte by byte from
 * that layout, so they do not depend on the encoder in the module under test.
 */

const MIB = 1024 * 1024;
const WOFF_HEADER_BYTES = 44;
const WOFF_DIRECTORY_ENTRY_BYTES = 20;
const TRUE_TYPE_FLAVOR = 0x00010000;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_BAD_REQUEST = 400;
const UINT32_MAX = 0xffffffff;
const BOMB_MIB = 128;
const OVER_BUDGET_TABLE_MIB = 60; // below the per-table cap; five of them pass the document budget
const OVER_BUDGET_TABLES = 5;
const DECLARED_FOUR_BYTE_ALIGN = 4;
const BOMB_RSS_LIMIT_MIB = 200;

interface WoffTable {
  tag: string;
  /** Bytes written to the file for this table. */
  payload: Buffer;
  /** Directory origLength; defaults to the payload length for stored tables. */
  origLength: number;
  /** Directory compLength; defaults to the payload length. */
  compLength?: number;
}

function buildWoff(tables: WoffTable[]): Buffer {
  const directory = Buffer.alloc(tables.length * WOFF_DIRECTORY_ENTRY_BYTES);
  const chunks: Buffer[] = [];
  let offset = WOFF_HEADER_BYTES + directory.length;
  tables.forEach((table, i) => {
    const at = i * WOFF_DIRECTORY_ENTRY_BYTES;
    directory.write(table.tag, at, 4, 'ascii');
    directory.writeUInt32BE(offset, at + 4);
    directory.writeUInt32BE(table.compLength ?? table.payload.length, at + 8);
    directory.writeUInt32BE(table.origLength, at + 12);
    directory.writeUInt32BE(0, at + 16);
    const pad = (DECLARED_FOUR_BYTE_ALIGN - (table.payload.length % DECLARED_FOUR_BYTE_ALIGN)) % DECLARED_FOUR_BYTE_ALIGN;
    chunks.push(table.payload, Buffer.alloc(pad));
    offset += table.payload.length + pad;
  });
  const header = Buffer.alloc(WOFF_HEADER_BYTES);
  header.write('wOFF', 0, 4, 'ascii');
  header.writeUInt32BE(TRUE_TYPE_FLAVOR, 4);
  header.writeUInt32BE(offset, 8);
  header.writeUInt16BE(tables.length, 12);
  header.writeUInt32BE(offset, 16);
  header.writeUInt16BE(1, 20);
  return Buffer.concat([header, directory, ...chunks]);
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

const sample = Buffer.from('0123456789abcdef'.repeat(8), 'ascii'); // 128 bytes, compressible

describe('WOFF 1.0 table inflation is bounded by the declared origLength', () => {
  it('decodes honest compressed and stored tables to their exact bytes', () => {
    const stored = Buffer.from('stored-table-bytes', 'ascii');
    const compressed = zlib.deflateSync(sample);
    expect(compressed.length).toBeLessThan(sample.length);
    const font = decodeWoff(
      buildWoff([
        { tag: 'cmap', payload: compressed, origLength: sample.length },
        { tag: 'name', payload: stored, origLength: stored.length },
      ]),
      'Test'
    );
    expect(font.tables['cmap'].data.equals(sample)).toBe(true);
    expect(font.tables['name'].data.equals(stored)).toBe(true);
  });

  it('refuses a table that inflates to fewer bytes than origLength declares', () => {
    const woff = buildWoff([{ tag: 'cmap', payload: zlib.deflateSync(sample), origLength: sample.length + 8 }]);
    const err = thrown(() => decodeWoff(woff, 'Test'));
    expect(err).toBeInstanceOf(CorruptStreamError);
    expect((err as CorruptStreamError).status).toBe(HTTP_BAD_REQUEST);
    expect((err as Error).message).toMatch(/cmap/);
  });

  it('refuses a table that inflates past origLength without decoding the excess', () => {
    const bomb = zlib.deflateSync(Buffer.alloc(BOMB_MIB * MIB), { level: 9 });
    const declared = 16;
    const rssBefore = process.resourceUsage().maxRSS;
    const err = thrown(() =>
      decodeWoff(buildWoff([{ tag: 'glyf', payload: bomb, origLength: declared }]), 'Test')
    );
    expect(err).toBeInstanceOf(CorruptStreamError);
    expect((err as Error).message).toMatch(/glyf/);
    expect((process.resourceUsage().maxRSS - rssBefore) / 1024).toBeLessThan(BOMB_RSS_LIMIT_MIB);
  });

  it('refuses a table whose origLength exceeds the per-stream cap before inflating anything', () => {
    const woff = buildWoff([{ tag: 'glyf', payload: zlib.deflateSync(sample), origLength: UINT32_MAX }]);
    const err = thrown(() => decodeWoff(woff, 'Test'));
    expect(err).toBeInstanceOf(DecompressionLimitError);
    expect((err as DecompressionLimitError).status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    expect(err).toBeInstanceOf(ConversionFailedError);
  });

  it('refuses tables whose declared sizes together exceed the document budget', () => {
    const tiny = zlib.deflateSync(sample);
    const woff = buildWoff(
      Array.from({ length: OVER_BUDGET_TABLES }, (_, i) => ({
        tag: `tb${i}`.padEnd(4, ' '),
        payload: tiny,
        origLength: OVER_BUDGET_TABLE_MIB * MIB,
      }))
    );
    const err = thrown(() => decodeWoff(woff, 'Test'));
    expect(err).toBeInstanceOf(DecompressionLimitError);
    expect((err as Error).message).toMatch(/document/i);
  });

  it('refuses a directory entry whose compLength exceeds origLength', () => {
    const woff = buildWoff([
      { tag: 'cmap', payload: Buffer.from('abcdefgh', 'ascii'), origLength: 4, compLength: 8 },
    ]);
    const err = thrown(() => decodeWoff(woff, 'Test'));
    expect(err).toBeInstanceOf(CorruptStreamError);
    expect((err as Error).message).toMatch(/compLength 8 larger than its origLength 4/);
  });

  it('refuses a stored table that the file cuts short', () => {
    const woff = buildWoff([{ tag: 'name', payload: Buffer.from('abcdefgh', 'ascii'), origLength: 8 }]);
    const err = thrown(() => decodeWoff(woff.subarray(0, woff.length - 4), 'Test'));
    expect(err).toBeInstanceOf(CorruptStreamError);
    expect((err as Error).message).toMatch(/'name' extends past the end of the file/);
  });

  it('reports the typed error through the font conversion entry point', async () => {
    const woff = buildWoff([{ tag: 'cmap', payload: zlib.deflateSync(sample), origLength: sample.length + 1 }]);
    let err: unknown;
    try {
      await convertFile(woff, 'woff', 'ttf', {}, 'bad.woff');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CorruptStreamError);
    expect((err as Error).message).toMatch(/'cmap' decodes to 128 bytes but declares 129/);
  });
});

describe('decompression limit errors answer 413 at the convert routes', () => {
  const oversized = buildWoff([{ tag: 'glyf', payload: zlib.deflateSync(sample), origLength: UINT32_MAX }]);

  function form(field: string): FormData {
    const data = new FormData();
    data.append(field, new Blob([new Uint8Array(oversized)]), 'huge.woff');
    data.append('targetFormat', 'ttf');
    data.append('targetFormats', JSON.stringify({ default: 'ttf' }));
    return data;
  }

  it('POST /api/convert answers 413', async () => {
    const res = await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', body: form('file') }));
    expect(res.status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    expect((await res.json()).error).toMatch(/glyf/);
  });

  it('POST /api/convert/batch answers 413', async () => {
    const res = await batchRoute(
      new NextRequest('http://localhost/api/convert/batch', { method: 'POST', body: form('files') })
    );
    expect(res.status).toBe(HTTP_PAYLOAD_TOO_LARGE);
  });

  it('POST /api/v1/convert answers 413', async () => {
    const user = await userStore.createUser({
      name: 'Limit Tester',
      email: `limit_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
      tier: 'pro',
    });
    const key = await redisKeyStore.generateApiKey(user.id, 'Limit Key', { scopes: ['convert:write', 'convert:read'] });
    const res = await v1ConvertRoute(
      new NextRequest('http://localhost/api/v1/convert', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key.secretKey}` },
        body: form('file'),
      })
    );
    expect(res.status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    expect((await res.json()).detail).toMatch(/glyf/);
  });
});
