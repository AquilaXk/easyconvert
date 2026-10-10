import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { decodeLzma, decodeLzma2, lzma2DictionaryByte, lzma2DictionarySize } from '../src/lib/conversions/lzma-decoder';
import { unpackXzStream } from '../src/lib/conversions/xz-format';
import { unpackXz } from '../src/lib/conversions/archive';
import { CorruptStreamError, DecompressionLimitError, ConversionFailedError } from '../src/lib/types';
import { jsonRecords, proseText, runBytes, SeededRandom, sourceText } from './helpers/archive-corpus';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * The pure LZMA / LZMA2 / .xz decoder against streams written by the reference encoders: every stream below is produced
 * by `xz` (and read back by this decoder), so the expected bytes and the stream layout (chunk control bytes, state
 * carried across chunks, dictionary resets, stream checks, blocks, concatenated streams) come from outside this code.
 */
const MAX_OUTPUT = 256 * 1024 * 1024;
const LZMA_ALONE_HEADER_BYTES = 13;

function xz(args: string[], input: Uint8Array): Buffer {
  return execFileSync(getOracleToolPath('xz')!, args, { input, maxBuffer: 1 << 28 });
}

interface Sample {
  name: string;
  data: Buffer;
}

function samples(): Sample[] {
  return [
    { name: 'empty', data: Buffer.alloc(0) },
    { name: 'one byte', data: Buffer.from('q') },
    { name: 'prose', data: proseText(300_000, 1) },
    { name: 'source', data: sourceText(400_000, 2) },
    { name: 'json', data: jsonRecords(250_000, 3) },
    { name: 'noise', data: new SeededRandom(4).bytes(120_000) },
    { name: 'runs', data: runBytes(500_000, 5) },
    { name: 'mixed 3 MB', data: Buffer.concat([proseText(1_200_000, 6), new SeededRandom(7).bytes(300_000), sourceText(1_500_000, 8)]) },
  ];
}

describe('LZMA2 and .xz decoding of reference streams', () => {
  const corpus = samples();

  oracleTest('decodes xz -0, -6 and -9e streams of every sample byte for byte', ['xz'], () => {
    for (const { name, data } of corpus) {
      for (const preset of ['-0', '-6', '-9e']) {
        const stream = xz([preset, '-c'], data);
        const decoded = unpackXz(stream);
        expect(decoded.equals(data), `${name} ${preset}`).toBe(true);
      }
    }
  }, 300_000);

  oracleTest('decodes the default CRC-64 check, SHA-256 and no check, and rejects a corrupted check', ['xz'], () => {
    const data = proseText(200_000, 11);
    for (const check of ['crc32', 'crc64', 'sha256', 'none']) {
      const stream = xz(['-6', `--check=${check}`, '-c'], data);
      expect(unpackXz(stream).equals(data), check).toBe(true);
    }
    const stream = Buffer.from(xz(['-6', '--check=crc64', '-c'], data));
    // The check sits right before the index; flip a bit of it.
    const backward = stream.readUInt32LE(stream.length - 8);
    const indexStart = stream.length - 12 - (backward + 1) * 4;
    stream[indexStart - 1] ^= 0x01;
    expect(() => unpackXz(stream)).toThrow(/payload CRC64 mismatch/);
  });

  oracleTest('decodes multi-block streams and concatenated streams', ['xz'], () => {
    const a = proseText(500_000, 21);
    const b = sourceText(300_000, 22);
    const blocks = xz(['-6', '--block-size=100KiB', '-T1', '-c'], a);
    expect(unpackXz(blocks).equals(a)).toBe(true);
    const concatenated = Buffer.concat([xz(['-6', '-c'], a), xz(['-1', '-c'], b)]);
    expect(unpackXz(concatenated).equals(Buffer.concat([a, b]))).toBe(true);
    const padded = Buffer.concat([xz(['-6', '-c'], a), Buffer.alloc(8), xz(['-1', '-c'], b), Buffer.alloc(4)]);
    expect(unpackXz(padded).equals(Buffer.concat([a, b]))).toBe(true);
  });

  oracleTest('decodes custom lc / lp / pb and small dictionaries', ['xz'], () => {
    const data = Buffer.concat([proseText(200_000, 31), sourceText(200_000, 32)]);
    for (const filter of ['preset=6,lc=0,lp=2,pb=0', 'preset=3,lc=4,lp=0,pb=4', 'dict=4KiB,lc=1,lp=3,pb=1', 'preset=9,dict=1MiB,mf=hc4,mode=fast']) {
      const stream = xz([`--lzma2=${filter}`, '-c'], data);
      expect(unpackXz(stream).equals(data), filter).toBe(true);
    }
  });

  oracleTest('decodes raw LZMA2 and raw LZMA streams given their properties', ['xz'], () => {
    const data = proseText(250_000, 41);
    const raw2 = xz(['--format=raw', '--lzma2=preset=6', '-c'], data);
    expect(Buffer.from(decodeLzma2(raw2, MAX_OUTPUT, data.length)).equals(data)).toBe(true);
    // preset 6 is lc=3 lp=0 pb=2: properties byte 0x5d, then the dictionary size.
    const rawLzma = xz(['--format=raw', '--lzma1=preset=6', '-c'], data);
    const props = Buffer.alloc(5);
    props[0] = 0x5d;
    props.writeUInt32LE(8 * 1024 * 1024, 1);
    expect(Buffer.from(decodeLzma(rawLzma, props, data.length, MAX_OUTPUT)).equals(data)).toBe(true);
    const alone = xz(['--format=lzma', '-6', '-c'], data);
    // xz writes an unknown size (all ones) and an end marker; the caller supplies the size from its container.
    expect(alone.readBigUInt64LE(5)).toBe(0xffffffffffffffffn);
    expect(Buffer.from(decodeLzma(alone.subarray(LZMA_ALONE_HEADER_BYTES), alone.subarray(0, 5), data.length, MAX_OUTPUT)).equals(data)).toBe(true);
  });

  it('maps dictionary property bytes to sizes and back', () => {
    expect(lzma2DictionarySize(0)).toBe(4096);
    expect(lzma2DictionarySize(1)).toBe(6144);
    expect(lzma2DictionarySize(18)).toBe(2 * 1024 * 1024);
    expect(lzma2DictionarySize(22)).toBe(8 * 1024 * 1024);
    expect(lzma2DictionarySize(40)).toBe(0xffffffff);
    expect(lzma2DictionaryByte(4096)).toBe(0);
    expect(lzma2DictionaryByte(5000)).toBe(1);
    expect(lzma2DictionaryByte(8 * 1024 * 1024)).toBe(22);
    expect(() => lzma2DictionarySize(41)).toThrow(CorruptStreamError);
  });
});

describe('hostile LZMA2 and .xz input', () => {
  const data = Buffer.concat([proseText(60_000, 51), sourceText(60_000, 52)]);

  oracleTest('every truncation of a stream is a typed error, never a wrong result', ['xz'], () => {
    const stream = xz(['-6', '-c'], data);
    for (let cut = 0; cut < stream.length - 1; cut += 37) {
      let outcome: unknown;
      try {
        outcome = unpackXzStream(stream.subarray(0, cut), MAX_OUTPUT);
      } catch (error) {
        outcome = error;
      }
      expect(outcome, `cut at ${cut}`).toBeInstanceOf(ConversionFailedError);
      expect((outcome as Error).name, `cut at ${cut}`).toBe('CorruptStreamError');
      expect((outcome as Error).message, `cut at ${cut}`).toMatch(/^(Invalid XZ archive|Corrupt LZMA data): /);
    }
  });

  oracleTest('bit flips either fail with a typed error or leave the decoded bytes intact', ['xz'], () => {
    const stream = xz(['-6', '-c'], data);
    const rng = new SeededRandom(61);
    for (let trial = 0; trial < 400; trial++) {
      const damaged = Buffer.from(stream);
      damaged[rng.below(damaged.length)] ^= 1 << rng.below(8);
      let outcome: unknown;
      try {
        outcome = unpackXzStream(damaged, MAX_OUTPUT);
      } catch (error) {
        outcome = error;
      }
      if (outcome instanceof Error) expect(outcome, `trial ${trial}`).toBeInstanceOf(ConversionFailedError);
      else expect((outcome as Buffer).equals(data), `trial ${trial}: a flipped bit changed the output without an error`).toBe(true);
    }
  }, 120_000);

  oracleTest('refuses to inflate past the output limit (a 64 MB run of zeros against a 1 MB limit)', ['xz'], () => {
    const bomb = xz(['-1', '-c'], Buffer.alloc(64 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(200_000);
    expect(() => unpackXzStream(bomb, 1024 * 1024)).toThrow(DecompressionLimitError);
    expect(() => decodeLzma2(xz(['--format=raw', '--lzma2=preset=1', '-c'], Buffer.alloc(8 * 1024 * 1024)), 1024 * 1024)).toThrow(DecompressionLimitError);
  });

  it('rejects a raw LZMA2 stream that starts without a dictionary reset', () => {
    // Control 0x02 (uncompressed, no reset) as the first chunk.
    expect(() => decodeLzma2(Uint8Array.of(0x02, 0x00, 0x00, 0x41, 0x00), MAX_OUTPUT)).toThrow(/must reset the dictionary/);
    // Control 0x80 (LZMA, nothing reset) as the first chunk.
    expect(() => decodeLzma2(Uint8Array.of(0x80, 0x00, 0x00, 0x00, 0x00, 0x00), MAX_OUTPUT)).toThrow(/must reset the dictionary/);
    expect(() => decodeLzma2(Uint8Array.of(0x03), MAX_OUTPUT)).toThrow(/invalid LZMA2 control byte/);
  });

  it('decodes a hand-assembled LZMA2 stream of uncompressed chunks', () => {
    const stream = Uint8Array.of(0x01, 0x00, 0x02, 0x61, 0x62, 0x63, 0x02, 0x00, 0x01, 0x64, 0x65, 0x00);
    expect(Buffer.from(decodeLzma2(stream, MAX_OUTPUT, 5)).toString('latin1')).toBe('abcde');
  });

  it('rejects a properties byte out of range and lc + lp above 4 in LZMA2', () => {
    expect(() => decodeLzma(Uint8Array.of(0, 0, 0, 0, 0, 0), Uint8Array.of(225, 0, 0, 1, 0), 1, MAX_OUTPUT)).toThrow(/invalid properties byte/);
    // 0x5d = lc3 lp0 pb2 is fine; lc4 lp1 (0x6d? = 4 + 9*(1 + 5*2) = 103 -> 0x67) breaks the LZMA2 limit.
    const lc4lp1pb2 = 4 + 9 * (1 + 5 * 2);
    expect(() => decodeLzma2(Uint8Array.of(0xe0, 0x00, 0x00, 0x00, 0x05, lc4lp1pb2, 0, 0, 0, 0, 0, 0), MAX_OUTPUT)).toThrow(/lc \+ lp <= 4/);
  });
});
