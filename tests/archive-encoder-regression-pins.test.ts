import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compressBzip2 } from '../src/lib/conversions/bzip2';
import { compressLzma, compressLzma2 } from '../src/lib/conversions/lzma-encoder';
import { create7zArchive, packXz } from '../src/lib/conversions/archive';
import { pinCorpus, sha256Hex } from './helpers/archive-corpus';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath } from './helpers/differential-oracle';

/**
 * REGRESSION PINS, not oracles. Each hash is the SHA-256 of what the encoder wrote for a fixed generated corpus
 * (tests/helpers/archive-corpus.ts) when the pins were recorded in tests/fixtures/archive-encoder-pins.json. They
 * state that a rewrite for speed leaves the bytes unchanged ("byte-identical output" in the speed issues); they do not
 * state that the bytes are good. Correctness is established separately, by the reference tools decoding every output
 * in this file (`xz`, `7z`, `bzip2`). When an encoder is changed on purpose (a better parser, a different ratio), the
 * affected pins are re-recorded in the same commit and that commit says so.
 */
const PINS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'archive-encoder-pins.json'), 'utf8')) as Record<string, string>;
const CORPUS = pinCorpus();
const LZMA_ALONE_HEADER_BYTES = 13;
const LZMA_ALONE_SIZE_OFFSET = 5;

function scratchFile(name: string, data: Uint8Array): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-pins-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return { dir, file };
}

/** The .lzma ("LZMA alone") file xz and 7z read: 5 property bytes, the 8-byte size, then the raw stream. */
function lzmaAlone(raw: { buffer: Buffer; props: Buffer; uncompressedSize: number }): Buffer {
  const header = Buffer.alloc(LZMA_ALONE_HEADER_BYTES);
  raw.props.copy(header, 0, 0, LZMA_ALONE_SIZE_OFFSET);
  header.writeBigUInt64LE(BigInt(raw.uncompressedSize), LZMA_ALONE_SIZE_OFFSET);
  return Buffer.concat([header, raw.buffer]);
}

describe('encoder output regression pins', () => {
  it('pins every corpus entry for every encoder that has a pin', () => {
    const missing: string[] = [];
    for (const file of CORPUS) {
      for (const kind of ['lzma', 'lzma2', 'xz', 'bz2']) if (!(`${file.name}/${kind}` in PINS)) missing.push(`${file.name}/${kind}`);
    }
    expect(missing).toEqual([]);
  });

  describe.each(CORPUS)('$name', ({ name, data }) => {
    it('raw LZMA bytes match the pin', () => {
      expect(sha256Hex(compressLzma(data).buffer)).toBe(PINS[`${name}/lzma`]);
    });
    it('LZMA2 bytes match the pin', () => {
      expect(sha256Hex(compressLzma2(data).buffer)).toBe(PINS[`${name}/lzma2`]);
    });
    it('xz container bytes match the pin', () => {
      expect(sha256Hex(packXz(data))).toBe(PINS[`${name}/xz`]);
    });
    it('bzip2 bytes match the pin', () => {
      expect(sha256Hex(compressBzip2(data))).toBe(PINS[`${name}/bz2`]);
    });
  });

  // An empty input has no 7z pin: there is nothing to compress.
  describe.each(CORPUS.filter((f) => f.data.length > 0))('$name as 7z', ({ name, data }) => {
    it('7z archive bytes match the pin', () => {
      expect(sha256Hex(create7zArchive([{ filename: 'data.bin', buffer: data }]).buffer)).toBe(PINS[`${name}/7z`]);
    });
  });

  it('a solid 7z of the whole corpus matches the pin', () => {
    const solid = CORPUS.filter((f) => f.data.length > 1000).map((f) => ({ filename: `${f.name}.bin`, buffer: f.data }));
    expect(sha256Hex(create7zArchive(solid, { solid: true }).buffer)).toBe(PINS['solid/7z']);
  });
});

describe('reference tools accept the pinned encoders', () => {
  oracleTest('xz -t accepts and `xz -dc` restores every packed .xz', ['xz'], () => {
    const xz = getOracleToolPath('xz')!;
    for (const { name, data } of CORPUS) {
      const { file } = scratchFile(`${name}.xz`, packXz(data));
      execFileSync(xz, ['-t', file]);
      expect(execFileSync(xz, ['-dc', file], { maxBuffer: 1 << 26 }).equals(data), `${name} decodes to the original bytes`).toBe(true);
    }
  });

  oracleTest('`xz --format=lzma -dc` restores every raw LZMA stream', ['xz'], () => {
    const xz = getOracleToolPath('xz')!;
    for (const { name, data } of CORPUS) {
      const { file } = scratchFile(`${name}.lzma`, lzmaAlone(compressLzma(data)));
      expect(execFileSync(xz, ['--format=lzma', '-dc', file], { maxBuffer: 1 << 26 }).equals(data), name).toBe(true);
    }
  });

  oracleTest('`bzip2 -t` accepts and `bzip2 -dc` restores every bzip2 stream', ['bzip2'], () => {
    const bzip2 = getOracleToolPath('bzip2')!;
    for (const { name, data } of CORPUS) {
      const compressed = compressBzip2(data);
      expect(execFileSync(bzip2, ['-dc'], { input: compressed, maxBuffer: 1 << 26 }).equals(data), name).toBe(true);
    }
  });

  oracleTest('`7z t` accepts and `7z x` restores every 7z archive', ['7z'], () => {
    const sevenZip = getOracleToolPath('7z')!;
    for (const { name, data } of CORPUS.filter((f) => f.data.length > 0)) {
      const { file } = scratchFile(`${name}.7z`, create7zArchive([{ filename: 'data.bin', buffer: data }]).buffer);
      execFileSync(sevenZip, ['t', file]);
      const restored = execFileSync(sevenZip, ['x', '-so', file], { maxBuffer: 1 << 26 });
      expect(restored.equals(data), name).toBe(true);
    }
  });
});
