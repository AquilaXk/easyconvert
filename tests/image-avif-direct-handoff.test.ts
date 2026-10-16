import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { startAvifWithCli } from '../src/lib/conversions/avif-cli';
import { DirectAvif, DirectAvifSlot, directSourceOf, startDirectAvifOn } from '../src/lib/conversions/image-avif-direct';
import { xmpChunk } from './helpers/png-chunks';
import { ConversionFailedError } from '../src/lib/types';
import { type Chunk, serializeChunks } from './helpers/apng-builder';
import { requireOracleTool } from './helpers/differential-oracle';
import { interface16, lineArt16 } from './helpers/graphic-parity';
import { oracleTest } from './helpers/oracle-test';
import { withChunksAfterHeader } from './helpers/png-chunks';

/**
 * A plain 16-bit or grey PNG goes to the AVIF encoder as the file it arrived in, while the picture is still being decoded
 * here for its content class. Oracles: the encoder binary itself, run on the source file with the arguments the product
 * passed (the command a person would type), and the PNG format (chunk layout built here byte by byte).
 */

const SCRIPT_MODE = 0o755;
const NOISE_MULTIPLIER = 2654435761;
const SIDE = 96;

let workDir: string;
const savedAvifencPath = process.env.AVIFENC_PATH;

beforeAll(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'avif-direct-handoff-'));
});
afterEach(() => {
  if (savedAvifencPath === undefined) delete process.env.AVIFENC_PATH;
  else process.env.AVIFENC_PATH = savedAvifencPath;
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function chunk(type: string, data: Buffer): Chunk {
  return { type, data };
}

/** Chunks as bytes (length, type, data and CRC from the hand-written serializer of the test helpers). */
function bytesOf(...chunks: Chunk[]): Buffer {
  return serializeChunks(chunks, Buffer.alloc(0));
}

function ihdrOf(png: Buffer): Buffer {
  return Buffer.from(png.subarray(16, 29));
}

/** Whether the encoder may read the file as it is. */
const readsAsPixelsOnly = (png: Buffer): boolean => directSourceOf(png) !== null;

describe('which PNG files the encoder may read as they are', () => {
  const sixteenBitGrey = lineArt16();
  const sixteenBitColour = interface16();
  const gamma = chunk('gAMA', Buffer.from([0, 0, 0xb1, 0x8f]));

  it.each([
    ['a 16-bit grey picture as the image library writes it (header, density, data, end)', async () => sixteenBitGrey, true],
    ['a 16-bit colour picture', async () => sixteenBitColour, true],
    ['with an sRGB rendering intent, a time stamp and a significant-bits chunk, which the encoder does not turn into output', async () => withChunksAfterHeader(await sixteenBitColour, [chunk('sRGB', Buffer.from([0])), chunk('tIME', Buffer.alloc(7)), chunk('sBIT', Buffer.from([16, 16, 16]))]), true],
    ['with a gamma chunk, a chromaticity chunk and a colour profile, which the encoder is told to ignore', async () => withChunksAfterHeader(await sixteenBitColour, [gamma, chunk('cHRM', Buffer.alloc(32)), chunk('iCCP', Buffer.from('p\0\0x'))]), true],
    ['with an XMP packet in an international text chunk, which the regular route writes again', async () => withChunksAfterHeader(await sixteenBitColour, [xmpChunk()]), true],
    ['with another international text chunk', async () => withChunksAfterHeader(await sixteenBitColour, [chunk('iTXt', Buffer.from('Comment\0\0\0\0\0hello'))]), false],
    ['with an international text chunk too short to hold the XMP keyword', async () => withChunksAfterHeader(await sixteenBitColour, [chunk('iTXt', Buffer.from('XML:com'))]), false],
    ['with an EXIF block', async () => withChunksAfterHeader(await sixteenBitColour, [chunk('eXIf', Buffer.from('MM\0*\0\0\0\b\0\0'))]), false],
    ['with text, which can carry a raw metadata profile', async () => withChunksAfterHeader(await sixteenBitColour, [chunk('tEXt', Buffer.from('Raw profile type exif\0abc'))]), false],
    ['with a transparency key', async () => withChunksAfterHeader(await sixteenBitColour, [chunk('tRNS', Buffer.alloc(6))]), false],
    ['with a colour description (cICP)', async () => withChunksAfterHeader(await sixteenBitColour, [chunk('cICP', Buffer.from([1, 13, 0, 1]))]), false],
    ['an animation control chunk', async () => withChunksAfterHeader(await sixteenBitColour, [chunk('acTL', Buffer.alloc(8))]), false],
    ['a palette picture', async () => sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } }).png({ palette: true }).toBuffer(), false],
    ['a 4-bit grey picture', async () => sharp(Buffer.alloc(64, 0x55), { raw: { width: 8, height: 8, channels: 1 } }).png({ palette: true, colours: 16 }).toBuffer(), false],
    ['a file without the end chunk', async () => (await sixteenBitColour).subarray(0, -12), false],
    ['a file cut inside a chunk', async () => (await sixteenBitColour).subarray(0, 60), false],
    ['bytes that are not a PNG', async () => Buffer.from('GIF89a-not-a-png-at-all-0123456789'), false],
    ['a JPEG', async () => sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } }).jpeg().toBuffer(), false],
  ])('%s', async (_name, build, expected) => {
    expect(readsAsPixelsOnly(await build())).toBe(expected);
  });

  it('says whether the file holds colour description chunks, which the encoder is told to ignore', async () => {
    const plain = await sixteenBitColour;
    expect(directSourceOf(plain)).toEqual({ ignoresColourChunks: false });
    for (const colour of [gamma, chunk('cHRM', Buffer.alloc(32)), chunk('iCCP', Buffer.from('p\0\0x'))]) {
      expect(directSourceOf(withChunksAfterHeader(plain, [colour])), colour.type).toEqual({ ignoresColourChunks: true });
    }
    expect(directSourceOf(withChunksAfterHeader(plain, [xmpChunk()]))).toEqual({ ignoresColourChunks: false });
    expect(directSourceOf(withChunksAfterHeader(plain, [chunk('sRGB', Buffer.from([0]))]))).toEqual({ ignoresColourChunks: false });
  });

  it('refuses a file whose signature is damaged in any byte, or cut short, whatever follows it', async () => {
    const png = await sixteenBitColour;
    expect(readsAsPixelsOnly(png)).toBe(true);
    for (let at = 0; at < 8; at += 1) {
      const damaged = Buffer.from(png);
      damaged[at] ^= 0x01;
      expect(readsAsPixelsOnly(damaged), `signature byte ${at}`).toBe(false);
    }
    expect(readsAsPixelsOnly(png.subarray(0, 7))).toBe(false);
    expect(readsAsPixelsOnly(png.subarray(0, 8))).toBe(false);
    expect(readsAsPixelsOnly(Buffer.alloc(0))).toBe(false);
  });

  it('refuses a header chunk that is not first, or of the wrong length', async () => {
    const png = await sixteenBitColour;
    const header = png.subarray(8, 8 + 12 + 13);
    const rest = png.subarray(8 + 12 + 13);
    expect(readsAsPixelsOnly(Buffer.concat([png.subarray(0, 8), bytesOf(chunk('pHYs', Buffer.alloc(9))), header, rest]))).toBe(false);
    expect(readsAsPixelsOnly(Buffer.concat([png.subarray(0, 8), bytesOf(chunk('IHDR', Buffer.alloc(12))), rest]))).toBe(false);
    // Well formed as a chunk, with a plausible depth and colour type, but not the 13 bytes of a header.
    const longer = Buffer.concat([header.subarray(8, 8 + 13), Buffer.from([0])]);
    expect(readsAsPixelsOnly(Buffer.concat([png.subarray(0, 8), bytesOf(chunk('IHDR', longer)), rest]))).toBe(false);
    expect(readsAsPixelsOnly(png.subarray(0, 8 + 8 + 5))).toBe(false);
  });

  it('reads the bit depth and colour type from the header chunk: 8 and 16 bits, grey, colour, and either with alpha', async () => {
    const png = await sixteenBitColour;
    const header = ihdrOf(png);
    const replaceHeader = (depth: number, colourType: number): Buffer => {
      const changed = Buffer.from(header);
      changed[8] = depth;
      changed[9] = colourType;
      return Buffer.concat([png.subarray(0, 8), bytesOf(chunk('IHDR', changed)), png.subarray(8 + 12 + 13)]);
    };
    for (const [depth, type] of [[8, 0], [8, 2], [8, 4], [8, 6], [16, 0], [16, 2], [16, 4], [16, 6]]) expect(readsAsPixelsOnly(replaceHeader(depth, type)), `${depth}-bit type ${type}`).toBe(true);
    for (const [depth, type] of [[1, 0], [2, 0], [4, 0], [8, 3], [16, 3], [16, 1]]) expect(readsAsPixelsOnly(replaceHeader(depth, type)), `${depth}-bit type ${type}`).toBe(false);
  });
});

/** The real encoder behind a wrapper that keeps the file it was given and the arguments it was run with. */
function copyingWrapper(name: string, guard = ''): { script: string; args: string; input: string } {
  const args = path.join(workDir, `${name}.args`);
  const input = path.join(workDir, `${name}.in.png`);
  const script = path.join(workDir, name);
  const real = requireOracleTool('avifenc');
  writeFileSync(script, `#!/bin/sh\n[ "$1" = "--version" ] && exec '${real}' "$@"\nfor last; do :; done\ndir=$(dirname "$last")\n${guard}\ncp "$dir/in.png" '${input}'\nprintf '%s\\n' "$@" > '${args}'\necho run >> '${args}.runs'\nexec '${real}' "$@"\n`);
  chmodSync(script, SCRIPT_MODE);
  return { script, args, input };
}

/** How many times the wrapper ran the encoder (not counting the version probe). */
function runsOf(wrapper: { args: string }): number {
  return existsSync(`${wrapper.args}.runs`) ? readFileSync(`${wrapper.args}.runs`, 'utf-8').trim().split('\n').length : 0;
}

/** What a person would get by typing the product's command line with the source file as the input. */
function encoderOnSource(argsFile: string, source: Buffer, name: string): Buffer {
  const args = readFileSync(argsFile, 'utf-8').trim().split('\n');
  const sourceFile = path.join(workDir, `${name}.source.png`);
  const outputFile = path.join(workDir, `${name}.source.avif`);
  writeFileSync(sourceFile, source);
  const flagsOnly = args.slice(0, args.indexOf('-o') - 1);
  execFileSync(requireOracleTool('avifenc'), [...flagsOnly, sourceFile, '-o', outputFile], { stdio: 'ignore' });
  return readFileSync(outputFile);
}

function noisy16(): Promise<Buffer> {
  const samples = new Uint16Array(SIDE * SIDE * 3);
  for (let i = 0; i < samples.length; i += 1) samples[i] = (Math.imul(i + 1, NOISE_MULTIPLIER) >>> 8) & 0xffff;
  return sharp(samples, { raw: { width: SIDE, height: SIDE, channels: 3 } }).toColourspace('rgb16').png().toBuffer();
}

describe('the encoder reads the source file', () => {
  oracleTest(
    'a 16-bit grey picture reaches the encoder byte for byte, and the AVIF is what the encoder writes for that file',
    ['avifenc', 'avifdec'],
    async () => {
      const wrapper = copyingWrapper('grey16');
      process.env.AVIFENC_PATH = wrapper.script;
      const source = await lineArt16();
      const out = await convertImage(source, 'avif', { quality: 70 }, 'grey.png', 'png');
      expect(out.metadata).toMatchObject({ avifEncoder: 'library-cli' });
      expect(readFileSync(wrapper.input).equals(source)).toBe(true);
      expect(runsOf(wrapper), 'the run started before the class was known is the one that wrote the file').toBe(1);
      expect(out.buffer.equals(encoderOnSource(wrapper.args, source, 'grey16'))).toBe(true);
    },
    60_000
  );

  oracleTest(
    'a 16-bit colour graphic reaches the encoder byte for byte, with the arguments of the policy',
    ['avifenc', 'avifdec'],
    async () => {
      const wrapper = copyingWrapper('colour16');
      process.env.AVIFENC_PATH = wrapper.script;
      const source = await interface16();
      const out = await convertImage(source, 'avif', { quality: 55 }, 'ui.png', 'png');
      expect(readFileSync(wrapper.input).equals(source)).toBe(true);
      const args = readFileSync(wrapper.args, 'utf-8').trim().split('\n');
      expect(args.slice(0, 6)).toEqual(['-d', '12', '-y', '420', '-q', '55']);
      expect(args).not.toContain('-a');
      expect(out.buffer.equals(encoderOnSource(wrapper.args, source, 'colour16'))).toBe(true);
    },
    60_000
  );

  oracleTest(
    'a picture with real transparency keeps its alpha plane through the source file',
    ['avifenc', 'avifdec'],
    async () => {
      const wrapper = copyingWrapper('translucent');
      process.env.AVIFENC_PATH = wrapper.script;
      const { data, info } = await sharp(await interface16()).ensureAlpha().raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
      const samples = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
      samples[3] = 30_000;
      const source = await sharp(samples, { raw: { width: info.width, height: info.height, channels: 4 } }).toColourspace('rgb16').png().toBuffer();
      const out = await convertImage(source, 'avif', { quality: 60 }, 't.png', 'png');
      expect(readFileSync(wrapper.input).equals(source)).toBe(true);
      expect(execFileSync(requireOracleTool('avifdec'), ['--info', writeOut('translucent.avif', out.buffer)], { encoding: 'utf-8' })).toMatch(/Alpha\s*:\s*(Present|.*premultiplied)/i);
      expect(out.buffer.equals(encoderOnSource(wrapper.args, source, 'translucent'))).toBe(true);
    },
    60_000
  );

  oracleTest(
    'a continuous-tone 16-bit picture is encoded with the photograph tuning, from the same source file',
    ['avifenc', 'avifdec'],
    async () => {
      const wrapper = copyingWrapper('photo16');
      process.env.AVIFENC_PATH = wrapper.script;
      const source = await noisy16();
      const out = await convertImage(source, 'avif', { quality: 60 }, 'noise.png', 'png');
      expect(out.metadata).toMatchObject({ avifEncoder: 'library-cli' });
      expect(readFileSync(wrapper.input).equals(source)).toBe(true);
      const args = readFileSync(wrapper.args, 'utf-8').trim().split('\n');
      expect(args[args.indexOf('-a') + 1]).toBe('c:tune=ssim');
      expect(runsOf(wrapper), 'at most the run that was replaced and the run of the photograph').toBeLessThanOrEqual(2);
      expect(out.buffer.equals(encoderOnSource(wrapper.args, source, 'photo16'))).toBe(true);
    },
    60_000
  );

  oracleTest(
    'a picture with colour description chunks and an XMP packet reaches the encoder as it is, told to ignore the colour chunks, and gives the bytes of the regular route',
    ['avifenc', 'avifdec'],
    async () => {
      const weirdChromaticities = chunk('cHRM', Buffer.from([0, 0, 0x82, 0x35, 0, 0, 0x82, 0x35, 0, 0, 0xea, 0x60, 0, 0, 0x75, 0x30, 0, 0, 0x75, 0x30, 0, 0, 0xea, 0x60, 0, 0, 0x3a, 0x98, 0, 0, 0x17, 0x70]));
      const marked = withChunksAfterHeader(await interface16(), [chunk('gAMA', Buffer.from([0, 0x01, 0x86, 0xa0])), weirdChromaticities, xmpChunk()]);
      const direct = copyingWrapper('colour-chunks');
      process.env.AVIFENC_PATH = direct.script;
      const fromSource = await convertImage(marked, 'avif', { quality: 60 }, 'c.png', 'png');
      expect(readFileSync(direct.input).equals(marked)).toBe(true);
      const args = readFileSync(direct.args, 'utf-8').trim().split('\n');
      expect(args).toContain('--ignore-icc');
      expect(fromSource.buffer.equals(encoderOnSource(direct.args, marked, 'colour-chunks'))).toBe(true);
      // A text chunk keeps the picture on the regular route (decoded, written as a PNG without the chunks), which ignores it.
      const regular = copyingWrapper('colour-chunks-regular');
      process.env.AVIFENC_PATH = regular.script;
      const viaPixels = await convertImage(withChunksAfterHeader(marked, [chunk('tEXt', Buffer.from('Comment\0hello'))]), 'avif', { quality: 60 }, 'c.png', 'png');
      expect(readFileSync(regular.args, 'utf-8')).not.toContain('--ignore-icc');
      expect(fromSource.buffer.equals(viaPixels.buffer)).toBe(true);
      expect(fromSource.buffer.includes(Buffer.from('xmpmeta'))).toBe(true);
    },
    60_000
  );

  oracleTest(
    'a picture without colour description chunks is not told to ignore anything',
    ['avifenc', 'avifdec'],
    async () => {
      const wrapper = copyingWrapper('no-colour-chunks');
      process.env.AVIFENC_PATH = wrapper.script;
      await convertImage(await interface16(), 'avif', {}, 'ui.png', 'png');
      expect(readFileSync(wrapper.args, 'utf-8')).not.toContain('--ignore-icc');
    },
    60_000
  );

  oracleTest(
    'a resize or a background goes through the decoded pixels, never the source file',
    ['avifenc', 'avifdec'],
    async () => {
      const source = await interface16();
      for (const [name, options] of [['resize', { width: 120 }], ['background', { background: '#ff0000' }]] as const) {
        const wrapper = copyingWrapper(`changed-${name}`);
        process.env.AVIFENC_PATH = wrapper.script;
        await convertImage(source, 'avif', options, 'ui.png', 'png');
        expect(readFileSync(wrapper.input).equals(source), name).toBe(false);
      }
    },
    60_000
  );

  oracleTest(
    'an encoder that fails on the source file is run again on the decoded pixels, which give the same AVIF as before',
    ['avifenc', 'avifdec'],
    async () => {
      const source = await interface16();
      const refused = copyingWrapper('refuses-source', `[ "$(wc -c < "$dir/in.png")" -eq ${source.length} ] && exit 3`);
      process.env.AVIFENC_PATH = refused.script;
      const out = await convertImage(source, 'avif', { quality: 60 }, 'ui.png', 'png');
      expect(readFileSync(refused.input).equals(source)).toBe(false);
      const plain = copyingWrapper('accepts-source');
      process.env.AVIFENC_PATH = plain.script;
      const direct = await convertImage(source, 'avif', { quality: 60 }, 'ui.png', 'png');
      expect(out.buffer.equals(direct.buffer)).toBe(true);
    },
    60_000
  );

  oracleTest(
    'an encoder that fails on every file is a typed conversion error, and no working directory is left behind',
    ['avifenc', 'avifdec'],
    async () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'avif-direct-tmp-'));
      const savedTmp = process.env.TMPDIR;
      process.env.TMPDIR = tmp;
      try {
        const failing = copyingWrapper('always-fails', 'exit 3');
        process.env.AVIFENC_PATH = failing.script;
        const failure = await convertImage(await interface16(), 'avif', {}, 'ui.png', 'png').then(
          () => null,
          (err: unknown) => err
        );
        expect(failure).toBeInstanceOf(ConversionFailedError);
        expect((failure as Error).message).toMatch(/the AVIF encoder failed on the picture/);
        expect(readdirSync(tmp)).toEqual([]);
      } finally {
        if (savedTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = savedTmp;
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    60_000
  );

  oracleTest(
    'an encoder that writes nothing for the source file is an error of the conversion, not a reason to encode the decoded pixels',
    ['avifenc', 'avifdec'],
    async () => {
      const source = await interface16();
      const silent = copyingWrapper('silent-on-source', `[ "$(wc -c < "$dir/in.png")" -eq ${source.length} ] && exit 0`);
      process.env.AVIFENC_PATH = silent.script;
      const failure = await convertImage(source, 'avif', {}, 'ui.png', 'png').then(
        () => null,
        (err: unknown) => err
      );
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect((failure as Error).message).toMatch(/produced no output/);
      expect(runsOf(silent), 'no run on the decoded pixels').toBe(0);
    },
    60_000
  );

  oracleTest(
    'a source the decoder refuses is an error of the decoder, and the encoder started on it is stopped and its directory removed',
    ['avifenc', 'avifdec'],
    async () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'avif-direct-bad-'));
      const savedTmp = process.env.TMPDIR;
      process.env.TMPDIR = tmp;
      try {
        const pidFile = path.join(workDir, 'sleeper.pid');
        const sleeper = path.join(workDir, 'sleeper');
        writeFileSync(sleeper, `#!/bin/sh\n[ "$1" = "--version" ] && { echo 'Version: 1.4.2 (fake)'; exit 0; }\necho $$ > '${pidFile}'\nexec sleep 60\n`);
        chmodSync(sleeper, SCRIPT_MODE);
        process.env.AVIFENC_PATH = sleeper;
        const good = await interface16();
        // The header and the first rows are fine; the data stream is damaged, which only a full decode finds out.
        const damaged = Buffer.from(good);
        const idat = damaged.indexOf('IDAT', 0, 'latin1');
        for (let at = idat + 20; at < idat + 60; at += 1) damaged[at] ^= 0xff;
        const failure = await convertImage(damaged, 'avif', {}, 'bad.png', 'png').then(
          () => null,
          (err: unknown) => err
        );
        expect(failure).toBeInstanceOf(Error);
        if (existsSync(pidFile)) {
          const pid = Number(readFileSync(pidFile, 'utf-8'));
          const deadline = Date.now() + 5000;
          let alive = true;
          while (alive && Date.now() < deadline) {
            try {
              process.kill(pid, 0);
              await new Promise((resolve) => setTimeout(resolve, 50));
            } catch {
              alive = false;
            }
          }
          expect(alive).toBe(false);
        }
        expect(readdirSync(tmp)).toEqual([]);
      } finally {
        if (savedTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = savedTmp;
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    60_000
  );
});

function writeOut(name: string, bytes: Buffer): string {
  mkdirSync(workDir, { recursive: true });
  const file = path.join(workDir, name);
  writeFileSync(file, bytes);
  expect(statSync(file).size).toBe(bytes.length);
  return file;
}

describe('the run in a slot', () => {
  const OPTIONS = { quality: 60 };

  function sleepingTool(name: string): { script: string; pidFile: string } {
    const pidFile = path.join(workDir, `${name}.pid`);
    const script = path.join(workDir, name);
    writeFileSync(script, `#!/bin/sh\n[ "$1" = "--version" ] && { echo 'Version: 1.4.2 (fake)'; exit 0; }\necho $$ > '${pidFile}'\nexec sleep 60\n`);
    chmodSync(script, SCRIPT_MODE);
    return { script, pidFile };
  }

  async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  function isRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it('keeps the run when the content class fails, so that abandoning the slot stops it', async () => {
    const tool = sleepingTool('slot-sleeper');
    process.env.AVIFENC_PATH = tool.script;
    const source = await lineArt16();
    const direct = await DirectAvif.start(source, await sharp(source).metadata(), OPTIONS);
    expect(direct).not.toBeNull();
    const slot = new DirectAvifSlot();
    slot.set(direct);
    await waitFor(() => existsSync(tool.pidFile));
    const pid = Number(readFileSync(tool.pidFile, 'utf-8'));
    await expect(slot.finish(Promise.reject(new Error('the class could not be found')))).rejects.toThrow('the class could not be found');
    expect(isRunning(pid)).toBe(true);
    await slot.abandon();
    await waitFor(() => !isRunning(pid));
  }, 30_000);

  oracleTest(
    'keeps the run that was started when the class has the same policy, and replaces it by a run of the class when it has another',
    ['avifenc', 'avifdec'],
    async () => {
      const source = await lineArt16();
      const meta = await sharp(source).metadata();
      const start = async (name: string): Promise<{ direct: DirectAvif; wrapper: ReturnType<typeof copyingWrapper> }> => {
        const wrapper = copyingWrapper(name);
        process.env.AVIFENC_PATH = wrapper.script;
        const direct = await DirectAvif.start(source, meta, OPTIONS);
        expect(direct).not.toBeNull();
        await waitFor(() => runsOf(wrapper) === 1);
        return { direct: direct as DirectAvif, wrapper };
      };
      const same = await start('same-policy');
      const file = await same.direct.finish('graphic');
      expect(file?.subarray(4, 12).toString('latin1')).toBe('ftypavif');
      expect(runsOf(same.wrapper)).toBe(1);
      const other = await start('other-policy');
      const photo = await other.direct.finish('photo');
      expect(photo?.subarray(4, 12).toString('latin1')).toBe('ftypavif');
      expect(readFileSync(other.wrapper.args, 'utf-8')).toContain('c:tune=ssim');
      expect(runsOf(other.wrapper)).toBe(2);
    },
    60_000
  );

  it('has nothing to finish or abandon when no run was started', async () => {
    const slot = new DirectAvifSlot();
    expect(await slot.finish('graphic')).toBeNull();
    await expect(slot.abandon()).resolves.toBeUndefined();
  });

  it('does not start a run for a colour picture of 8 bits, whose encoder depends on its content', async () => {
    const tool = sleepingTool('never-started');
    process.env.AVIFENC_PATH = tool.script;
    const colour8 = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#336699' } }).png().toBuffer();
    expect(await DirectAvif.start(colour8, await sharp(colour8).metadata(), OPTIONS)).toBeNull();
    expect(existsSync(tool.pidFile)).toBe(false);
  });

  it('starts a run for a picture at the pixel budget of the command-line encoder and for none above it', async () => {
    const tool = sleepingTool('budget-sleeper');
    process.env.AVIFENC_PATH = tool.script;
    const source = await lineArt16();
    const meta = await sharp(source).metadata();
    expect(await DirectAvif.start(source, { ...meta, width: 7000, height: 7000 }, OPTIONS), '49 megapixels').toBeNull();
    expect(existsSync(tool.pidFile)).toBe(false);
    const within = await DirectAvif.start(source, { ...meta, width: 6900, height: 6900 }, OPTIONS);
    expect(within, '47.6 megapixels').not.toBeNull();
    await within?.abandon();
    expect(await DirectAvif.start(source, { ...meta, width: undefined }, OPTIONS), 'no width').toBeNull();
    expect(await DirectAvif.start(source, { ...meta, height: undefined }, OPTIONS), 'no height').toBeNull();
  }, 30_000);

  it('does not start a run when the encoder is not installed', async () => {
    process.env.AVIFENC_PATH = path.join(workDir, 'no-such-avifenc');
    const source = await lineArt16();
    expect(await DirectAvif.start(source, await sharp(source).metadata(), OPTIONS)).toBeNull();
  });

  it('offers the hook for an AVIF of the file own pixels only', async () => {
    const slot = new DirectAvifSlot();
    const source = await lineArt16();
    expect(startDirectAvifOn(slot, 'avif', false, source, OPTIONS)).toBeTypeOf('function');
    expect(startDirectAvifOn(slot, 'avif', true, source, OPTIONS)).toBeUndefined();
    expect(startDirectAvifOn(slot, 'jpg', false, source, OPTIONS)).toBeUndefined();
    expect(startDirectAvifOn(slot, 'webp', false, source, OPTIONS)).toBeUndefined();
  });
});

describe('startAvifWithCli', () => {
  it('stops the tool and removes the working directory when it is cancelled, and the result is the abort', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'avif-cancel-'));
    const savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      const pidFile = path.join(workDir, 'cancel.pid');
      const tool = path.join(workDir, 'cancel-sleeper');
      writeFileSync(tool, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 60\n`);
      chmodSync(tool, SCRIPT_MODE);
      const run = startAvifWithCli(tool, { png: await lineArt16(), width: 256, height: 256, quality: 60, effort: 3, bitdepth: 12, layout: '4:0:0' });
      const result = run.result.then(
        () => null,
        (err: unknown) => err
      );
      const deadline = Date.now() + 10_000;
      while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      const pid = Number(readFileSync(pidFile, 'utf-8'));
      await run.cancel();
      expect(await result).toBeInstanceOf(Error);
      expect(readdirSync(tmp)).toEqual([]);
      const gone = Date.now() + 5000;
      let alive = true;
      while (alive && Date.now() < gone) {
        try {
          process.kill(pid, 0);
          await new Promise((resolve) => setTimeout(resolve, 50));
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmp;
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it('gives the file of a run that is not cancelled, and cancelling it afterwards changes nothing', async () => {
    const real = requireOracleTool('avifenc');
    const source = await lineArt16();
    const run = startAvifWithCli(real, { png: source, width: 256, height: 256, quality: 60, effort: 3, bitdepth: 12, layout: '4:0:0' });
    const file = await run.result;
    await run.cancel();
    expect(file.subarray(4, 12).toString('latin1')).toBe('ftypavif');
  }, 60_000);
});
