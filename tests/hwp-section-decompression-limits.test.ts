import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildHwpRecord, HWP_TAGS, parseHwpDocument } from '../src/lib/conversions/hwp';
import { convertFile } from '../src/lib/conversions/index';
import { ConversionFailedError, CorruptStreamError, DecompressionLimitError } from '../src/lib/types';
import { buildCompoundFile } from './helpers/cfb-craft';

/**
 * BodyText sections of an HWP 5.0 file are raw-deflate streams whose inflated size the format does
 * not declare, so each one gets the per-stream cap and all of them share the document budget.
 * Containers come from tests/helpers/cfb-craft.ts, a [MS-CFB] writer independent of the parser.
 */

const MIB = 1024 * 1024;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_BAD_REQUEST = 400;
const HWP_FLAG_COMPRESSED = 0x01;
const FILE_HEADER_BYTES = 256;
const FILE_HEADER_VERSION_OFFSET = 32;
const FILE_HEADER_FLAGS_OFFSET = 36;
const HWP_VERSION_5_0_3_0 = 0x05000300;
const BOMB_MIB = 128; // above the 64 MiB per-stream cap
const OVER_BUDGET_SECTION_MIB = 60; // below the per-stream cap; five pass the 256 MiB budget
const OVER_BUDGET_SECTIONS = 5;

function fileHeader(compressed: boolean): Buffer {
  const header = Buffer.alloc(FILE_HEADER_BYTES);
  header.write('HWP Document File', 0, 'utf8');
  header.writeUInt32LE(HWP_VERSION_5_0_3_0, FILE_HEADER_VERSION_OFFSET);
  header.writeUInt32LE(compressed ? HWP_FLAG_COMPRESSED : 0, FILE_HEADER_FLAGS_OFFSET);
  return header;
}

function hwpWith(sections: Buffer[], compressed = true): Buffer {
  return buildCompoundFile([
    { name: 'FileHeader', data: fileHeader(compressed) },
    ...sections.map((data, i) => ({ name: `Section${i}`, data })),
  ]);
}

function paragraphSection(text: string): Buffer {
  const header = buildHwpRecord(HWP_TAGS.PARA_HEADER, 0, Buffer.alloc(16));
  const body = buildHwpRecord(HWP_TAGS.PARA_TEXT, 0, Buffer.from(`${text}\r\n`, 'utf16le'));
  return Buffer.concat([header, body]);
}

function rawDeflateZeros(mib: number): Buffer {
  return zlib.deflateRawSync(Buffer.alloc(mib * MIB), { level: 9 });
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('HWP section decompression is bounded', () => {
  it('refuses a section that inflates past the per-stream cap', () => {
    const err = thrown(() => parseHwpDocument(hwpWith([rawDeflateZeros(BOMB_MIB)])));
    expect(err).toBeInstanceOf(DecompressionLimitError);
    expect((err as DecompressionLimitError).status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    expect(err).toBeInstanceOf(ConversionFailedError);
  });

  it('refuses the bomb through convertFile for a text target', async () => {
    let err: unknown;
    try {
      await convertFile(hwpWith([rawDeflateZeros(BOMB_MIB)]), 'hwp', 'txt', {}, 'bomb.hwp');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DecompressionLimitError);
    expect((err as Error).message).toMatch(/HWP Section0 decodes to more than the limit of 67108864 bytes/);
  });

  it('refuses sections that together exceed the decoded-byte budget', () => {
    const section = rawDeflateZeros(OVER_BUDGET_SECTION_MIB);
    const err = thrown(() => parseHwpDocument(hwpWith(Array.from({ length: OVER_BUDGET_SECTIONS }, () => section))));
    expect(err).toBeInstanceOf(DecompressionLimitError);
    expect((err as Error).message).toMatch(/document/i);
  });

  it('maps a corrupt compressed section to a typed 400 instead of reading it as plain records', () => {
    const garbage = Buffer.from('not a deflate stream, just some bytes that cannot inflate', 'latin1');
    const err = thrown(() => parseHwpDocument(hwpWith([garbage])));
    expect(err).toBeInstanceOf(CorruptStreamError);
    expect((err as CorruptStreamError).status).toBe(HTTP_BAD_REQUEST);
  });

  it('still decodes an honest compressed section', () => {
    const doc = parseHwpDocument(hwpWith([zlib.deflateRawSync(paragraphSection('정상 문서 본문'))]));
    expect(doc.paragraphs.map((p) => p.text)).toEqual(['정상 문서 본문']);
  });

  it('reads an uncompressed section as plain records', () => {
    const doc = parseHwpDocument(hwpWith([paragraphSection('plain section text')], false));
    expect(doc.paragraphs.map((p) => p.text)).toEqual(['plain section text']);
  });
});
