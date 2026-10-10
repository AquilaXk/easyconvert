import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { isBarePng } from '../src/lib/conversions/image-decoded-source';
import { crc32 } from './helpers/apng-builder';
import { interface16, lineArt16 } from './helpers/graphic-parity';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * The picture a graphic AVIF is encoded from. A plain PNG with nothing but its pixels reaches the AVIF encoder as the
 * file it came in, where the converter used to decode it, write it again as a PNG and hand that over. Every other
 * request (a resize, a background, a colour or text block the encoder reads as a tag of the picture) still hands over
 * the converter's own PNG. Observed through the digest of the file a recording wrapper around the real encoder sees.
 */

const SCRIPT_MODE = 0o755;
let workDir: string;
const savedAvifencPath = process.env.AVIFENC_PATH;

beforeAll(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'avif-png-handoff-'));
});
afterEach(() => {
  if (savedAvifencPath === undefined) delete process.env.AVIFENC_PATH;
  else process.env.AVIFENC_PATH = savedAvifencPath;
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** A wrapper around the real encoder that writes the SHA-256 of the picture file it is given, then runs the real encoder. */
function digestWrapper(name: string): { script: string; digestFile: string } {
  const digestFile = path.join(workDir, `${name}.sha256`);
  const real = requireOracleTool('avifenc');
  const body =
    `#!/bin/sh\n[ "$1" = "--version" ] && exec '${real}' "$@"\n` +
    `prev=''; input=''\nfor a in "$@"; do [ "$a" = "-o" ] && input="$prev"; prev="$a"; done\n` +
    `sha256sum "$input" | cut -d' ' -f1 > '${digestFile}'\nexec '${real}' "$@"\n`;
  const script = path.join(workDir, name);
  writeFileSync(script, body);
  chmodSync(script, SCRIPT_MODE);
  return { script, digestFile };
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** The PNG with one chunk of `type` and `data` inserted before its image data. */
function withChunk(png: Buffer, type: string, data: Buffer): Buffer {
  const idat = png.indexOf('IDAT') - 4;
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
  return Buffer.concat([png.subarray(0, idat), header, data, crc, png.subarray(idat)]);
}

/** The digest of the picture the encoder is given for a conversion of `source`. */
async function handedOver(source: Buffer, options: Record<string, unknown> = {}): Promise<{ digest: string; avif: Buffer }> {
  const wrapper = digestWrapper(`wrapper-${Math.random().toString(16).slice(2)}`);
  process.env.AVIFENC_PATH = wrapper.script;
  const out = await convertImage(source, 'avif', { quality: 60, ...options }, 'graphic.png', 'png');
  expect(out.metadata).toMatchObject({ avifEncoder: 'library-cli' });
  return { digest: readFileSync(wrapper.digestFile, 'utf-8').trim(), avif: out.buffer };
}

describe('isBarePng', () => {
  it('accepts a PNG of 8 or 16 bits in grey, colour or either with alpha that holds only its image data', async () => {
    for (const make of [lineArt16, interface16, async () => sharp({ create: { width: 8, height: 8, channels: 4, background: '#ff000080' } }).png().toBuffer()]) {
      expect(isBarePng(await make())).toBe(true);
    }
  });

  it('accepts the density and time chunks, which carry nothing the encoder reads', async () => {
    const png = await interface16();
    expect(isBarePng(withChunk(withChunk(png, 'pHYs', Buffer.from([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1])), 'tIME', Buffer.from([0x07, 0xea, 10, 11, 0, 0, 0])))).toBe(true);
  });

  it.each([
    ['chromaticities', 'cHRM', Buffer.alloc(32)],
    ['gamma', 'gAMA', Buffer.alloc(4)],
    ['a standard colour space', 'sRGB', Buffer.alloc(1)],
    ['a transparent colour', 'tRNS', Buffer.alloc(6)],
    ['text', 'tEXt', Buffer.from('Comment\0x')],
  ])('refuses a PNG with %s', async (_name, type, data) => {
    expect(isBarePng(withChunk(await interface16(), type, data))).toBe(false);
  });

  it('refuses a palette, a bit depth below 8, a truncated file and bytes that are not a PNG', async () => {
    expect(isBarePng(await sharp(await interface16()).png({ palette: true, colours: 8 }).toBuffer())).toBe(false);
    expect(isBarePng(await sharp(await lineArt16()).png({ colours: 2, palette: true }).toBuffer())).toBe(false);
    const png = await interface16();
    expect(isBarePng(png.subarray(0, png.length - 20))).toBe(false);
    expect(isBarePng(png.subarray(0, 30))).toBe(false);
    expect(isBarePng(Buffer.from('not a picture'))).toBe(false);
    expect(isBarePng(Buffer.alloc(0))).toBe(false);
  });
});

describe('the picture a graphic AVIF is encoded from', () => {
  oracleTest(
    'a bare PNG reaches the encoder as the file it came in, 16-bit colour and grey alike',
    ['avifenc', 'avifdec'],
    async () => {
      for (const make of [interface16, lineArt16]) {
        const source = await make();
        const { digest, avif } = await handedOver(source);
        expect(digest).toBe(sha256(source));
        expect(avif.subarray(4, 12).toString('latin1')).toBe('ftypavif');
      }
    },
    60_000
  );

  oracleTest(
    'a bare 8-bit PNG with alpha reaches the encoder as it came in, and the file decodes to the same picture as the converter\'s own hand-over',
    ['avifenc', 'avifdec'],
    async () => {
      const source = await sharp(await interface16()).toColourspace('srgb').ensureAlpha().png().toBuffer();
      expect((await sharp(source).metadata()).depth).toBe('uchar');
      const direct = await handedOver(source);
      expect(direct.digest).toBe(sha256(source));
      // The same picture, made not bare by a text block: the converter writes its own PNG for the encoder.
      const rewritten = await handedOver(withChunk(source, 'tEXt', Buffer.from('Comment\0x')));
      expect(rewritten.digest).not.toBe(sha256(source));
      const decode = (avif: Buffer, name: string): Buffer => {
        const input = path.join(workDir, `${name}.avif`);
        const output = path.join(workDir, `${name}.png`);
        writeFileSync(input, avif);
        execFileSync(requireOracleTool('avifdec'), [input, output]);
        return readFileSync(output);
      };
      const [a, b] = await Promise.all([sharp(decode(direct.avif, 'direct')).raw().toBuffer(), sharp(decode(rewritten.avif, 'rewritten')).raw().toBuffer()]);
      expect(Buffer.compare(a, b)).toBe(0);
    },
    60_000
  );

  oracleTest(
    'a resize, a background and a colour tag in the PNG each keep the converter\'s own hand-over',
    ['avifenc', 'avifdec'],
    async () => {
      const source = await interface16();
      const digestOf = sha256(source);
      expect((await handedOver(source, { width: 128 })).digest).not.toBe(digestOf);
      expect((await handedOver(source, { background: '#336699' })).digest).not.toBe(digestOf);
      expect((await handedOver(withChunk(source, 'cHRM', Buffer.alloc(32)))).digest).not.toBe(sha256(withChunk(source, 'cHRM', Buffer.alloc(32))));
    },
    90_000
  );
});
