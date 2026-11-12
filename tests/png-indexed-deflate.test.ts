import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { getLibdeflateGzipPath } from '../src/lib/conversions/archive-libdeflate';
import { deflateIndexedRows, looksLikeNoise } from '../src/lib/conversions/png-indexed-deflate';
import { skipUnless } from './helpers/strict-skip';

/**
 * The deflater of the rows of an indexed PNG. The oracle is `zlib.inflateSync` (the library's own reader checks the header, the blocks and the
 * Adler-32) and the size of `zlib.deflateSync` at level 9, which is what a graphic must not exceed and a photograph must beat.
 */

const libdeflate = getLibdeflateGzipPath();
const skippedWithoutLibdeflate = skipUnless('libdeflate-gzip', libdeflate !== null);

/** A small deterministic generator (xorshift32), so that every picture is the same on every run. */
function noise(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/** Rows of palette indices behind a filter byte of 0: a graphic is blocks of a few indices with a speck here and there, a photograph is a gradient with dithered noise. */
function rows(kind: 'graphic' | 'photo', width: number, height: number): Buffer {
  const next = noise(7);
  const out = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      out[y * (width + 1) + 1 + x] = kind === 'graphic' ? (next() < 0.03 ? Math.floor(next() * 10) : ((x >> 5) + (y >> 4)) % 5) : (((x + y) >> 2) + Math.floor(next() * 6)) & 255;
    }
  }
  return out;
}

const standIns: string[] = [];
afterAll(() => {
  for (const dir of standIns) fs.rmSync(dir, { recursive: true, force: true });
});

function standInProgram(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libdeflate-stand-in-'));
  standIns.push(dir);
  const program = path.join(dir, 'libdeflate-gzip');
  fs.writeFileSync(program, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return program;
}

describe('which kind of rows it is', () => {
  it('takes the rows of a graphic for flat and the rows of a dithered photograph for noise', () => {
    expect(looksLikeNoise(rows('graphic', 400, 300))).toBe(false);
    expect(looksLikeNoise(rows('photo', 400, 300))).toBe(true);
  });

  it('judges a picture past three samples by a sample from its start, its middle and its end', () => {
    const photo = rows('photo', 1000, 600);
    const flatMiddle = Buffer.from(photo);
    flatMiddle.fill(0, 100_000, 500_000);
    expect(looksLikeNoise(photo)).toBe(true);
    expect(looksLikeNoise(flatMiddle)).toBe(true);
    expect(looksLikeNoise(Buffer.alloc(photo.length))).toBe(false);
  });
});

describe('the zlib stream of the rows', () => {
  it.each([
    ['a graphic', 'graphic' as const, 700, 400],
    ['a graphic of several blocks', 'graphic' as const, 1500, 900],
    ['a photograph', 'photo' as const, 700, 400],
    ['a photograph of several blocks', 'photo' as const, 1500, 900],
  ])('inflates to the rows of %s, with the checksum zlib verifies', async (_name, kind, width, height) => {
    const data = rows(kind, width, height);
    const stream = await deflateIndexedRows(data, looksLikeNoise(data));
    expect(zlib.inflateSync(stream).equals(data)).toBe(true);
  });

  it('is within 1 percent of zlib level 9 on one thread for a graphic and 3 percent smaller for a photograph', async () => {
    const graphic = rows('graphic', 1500, 900);
    expect((await deflateIndexedRows(graphic, looksLikeNoise(graphic))).length).toBeLessThanOrEqual(zlib.deflateSync(graphic, { level: 9 }).length * 1.01);
    const photo = rows('photo', 1500, 900);
    const level9 = zlib.deflateSync(photo, { level: 9 }).length;
    const written = (await deflateIndexedRows(photo, looksLikeNoise(photo))).length;
    if (libdeflate === null) expect(written).toBeLessThanOrEqual(level9 * 1.01);
    else expect(written).toBeLessThan(level9 * 0.97);
  });

  it('is the same bytes on every run', async () => {
    const photo = rows('photo', 900, 500);
    expect((await deflateIndexedRows(photo, looksLikeNoise(photo))).equals(await deflateIndexedRows(photo, looksLikeNoise(photo)))).toBe(true);
    const graphic = rows('graphic', 1500, 900);
    expect((await deflateIndexedRows(graphic, looksLikeNoise(graphic))).equals(await deflateIndexedRows(graphic, looksLikeNoise(graphic)))).toBe(true);
  });
});

describe('without a working libdeflate', () => {
  const photo = rows('photo', 900, 500);
  const level6 = zlib.deflateSync(photo, { level: 6 }).length;

  it.each([
    ['not installed', '/nonexistent/libdeflate-gzip'],
    ['failing', standInProgram('exit 3')],
    ['answering what is no gzip member', standInProgram('cat > /dev/null; printf nonsense')],
    ['answering a member of other rows', standInProgram("cat > /dev/null; printf 'x' | gzip -c")],
  ])('writes a photograph by zlib when the program is %s, as small as level 6 in blocks', async (_name, program) => {
    vi.stubEnv('LIBDEFLATE_GZIP_PATH', program);
    try {
      const stream = await deflateIndexedRows(photo, looksLikeNoise(photo));
      expect(zlib.inflateSync(stream).equals(photo)).toBe(true);
      expect(stream.length).toBeLessThanOrEqual(level6 * 1.01);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('stops for an aborted conversion instead of writing the fallback', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(deflateIndexedRows(photo, true, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe.skipIf(skippedWithoutLibdeflate)('with libdeflate', () => {
  it('writes the zlib stream of a photograph whose deflate stream libdeflate wrote, level 10: the same size as its command at that level', async () => {
    const photo = rows('photo', 1200, 800);
    const stream = await deflateIndexedRows(photo, looksLikeNoise(photo));
    const member = spawnSync(libdeflate as string, ['-10', '-c'], { input: photo, maxBuffer: 1 << 28 }).stdout;
    // A zlib stream is a 2-byte header, the deflate stream and a 4-byte checksum; a gzip member is a 10-byte header, the same stream and 8 bytes.
    expect(stream.length - 6).toBe(member.length - 18);
    expect(zlib.inflateSync(stream).equals(photo)).toBe(true);
  });
});
