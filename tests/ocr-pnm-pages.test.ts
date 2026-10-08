import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { performOcr } from '../src/lib/conversions/ocr';
import { preprocessOcrImage } from '../src/lib/conversions/ocr-preprocess';
import { encodePbm, encodePgm, encodePpm, isBitonal } from '../src/lib/conversions/pnm';
import { OcrPreprocessError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { requireMagick, runConvert, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';
import { decodePnm } from './helpers/pnm-decode';
import { expectNoSlowerThanReference } from './helpers/timing';
import { characterErrorRatePercent } from './helpers/ocr-cer';
import { fixtureImage, groundTruth, requireTessdata, requireTesseract } from './helpers/ocr-fixtures';

/**
 * Pages reach the recognizers as uncompressed Netpbm images. The format writer is checked against
 * hand-worked bytes and against ImageMagick's decoder; the recognizers are checked by reading the
 * same pixels as PNG and as PNM; and the text of the golden pages is pinned to what the previous
 * PNG hand-over produced (recorded on origin/main before the change).
 */

const TEST_TIMEOUT_MS = 180_000;
/** The PNM hand-over measured about 0.22x the PNG one; re-compressing to PNG would bring it back to 1x. */
const MAX_PNM_HANDOVER_RATIO = 0.6;
const NOISY_PAGE_WIDTH_PX = 2550;
const NOISY_PAGE_HEIGHT_PX = 2000;
const SLOW_RUNNER = process.env.EASYCONVERT_SLOW_RUNNER === '1';

describe('Netpbm writer', () => {
  it('writes P5 as the header and one byte per pixel', () => {
    const gray = Uint8Array.from([0, 64, 128, 255, 1, 2]);
    expect([...encodePgm(gray, 3, 2)]).toEqual([...Buffer.from('P5\n3 2\n255\n', 'ascii'), 0, 64, 128, 255, 1, 2]);
  });

  it('writes P6 as the header and three bytes per pixel', () => {
    const rgb = Uint8Array.from([255, 0, 0, 0, 255, 255]);
    expect([...encodePpm(rgb, 2, 1)]).toEqual([...Buffer.from('P6\n2 1\n255\n', 'ascii'), 255, 0, 0, 0, 255, 255]);
  });

  it('writes P4 with 1 for ink, the most significant bit first, and every row padded to a whole byte', () => {
    // Ten pixels per row: ink at x = 0, 2 and 9 in the first row, none in the second.
    const gray = new Uint8Array(20).fill(255);
    for (const x of [0, 2, 9]) gray[x] = 0;
    expect([...encodePbm(gray, 10, 2)]).toEqual([...Buffer.from('P4\n10 2\n', 'ascii'), 0b10100000, 0b01000000, 0, 0]);
  });

  it('treats gray levels up to 127 as ink and from 128 as paper in a bitonal page', () => {
    const gray = Uint8Array.from([127, 128, 0, 255, 126, 129, 1, 254]);
    expect([...encodePbm(gray, 8, 1)].slice(-1)).toEqual([0b10101010]);
  });

  it('tells a page of pure ink and paper from one with gray levels', () => {
    expect(isBitonal(Uint8Array.from([0, 255, 255, 0]))).toBe(true);
    expect(isBitonal(Uint8Array.from([0, 255, 254]))).toBe(false);
  });

  it('refuses a sample count that does not match the size and sizes it cannot write', () => {
    const failures = [
      () => encodePgm(new Uint8Array(5), 3, 2),
      () => encodePpm(new Uint8Array(5), 2, 1),
      () => encodePbm(new Uint8Array(5), 3, 2),
      () => encodePgm(new Uint8Array(0), 0, 0),
      () => encodePgm(new Uint8Array(1), -1, -1),
      () => encodePgm(new Uint8Array(1), 1.5, 1),
      () => encodePgm(new Uint8Array(1), 2_000_000, 1),
    ];
    for (const run of failures) {
      expect(run).toThrow(OcrPreprocessError);
    }
  });
});

describe.skipIf(SKIP_WITHOUT_MAGICK)('against ImageMagick', () => {
  function raw(pnm: Buffer, colorspace: 'gray' | 'rgb'): Buffer {
    requireMagick();
    return runConvert(['pnm:-', '-depth', '8', `${colorspace}:-`], pnm);
  }

  it('reads our P5 and P6 pages back to the same samples, and the test reader agrees', () => {
    const gray = Uint8Array.from({ length: 7 * 5 }, (_, i) => (i * 37) % 256);
    const rgb = Uint8Array.from({ length: 7 * 5 * 3 }, (_, i) => (i * 53) % 256);
    expect(raw(encodePgm(gray, 7, 5), 'gray').equals(Buffer.from(gray))).toBe(true);
    expect(raw(encodePpm(rgb, 7, 5), 'rgb').equals(Buffer.from(rgb))).toBe(true);
    expect(Buffer.from(decodePnm(encodePgm(gray, 7, 5)).samples).equals(Buffer.from(gray))).toBe(true);
    expect(Buffer.from(decodePnm(encodePpm(rgb, 7, 5)).samples).equals(Buffer.from(rgb))).toBe(true);
  });

  it('reads our P4 page as ink where the gray page was dark, for widths that are and are not a multiple of 8', () => {
    for (const width of [8, 13, 64, 67]) {
      const gray = Uint8Array.from({ length: width * 3 }, (_, i) => (((i * 7) % 5 < 2 ? 0 : 255)));
      const imageMagick = raw(encodePbm(gray, width, 3), 'gray');
      expect(imageMagick.equals(Buffer.from(gray)), `width ${width}`).toBe(true);
      expect(Buffer.from(decodePnm(encodePbm(gray, width, 3)).samples).equals(Buffer.from(gray))).toBe(true);
    }
  });
});

describe('the recognizers read the same pixels as PNG and as PNM', () => {
  /** A prepared page, its pixels as the format-independent truth, and the same pixels as PNG. */
  async function pagesFor(page: string, variant: string, steps?: Parameters<typeof preprocessOcrImage>[1]) {
    const prepared = await preprocessOcrImage(fixtureImage(page, variant), steps);
    const decoded = decodePnm(prepared.image);
    const png = await sharp(Buffer.from(decoded.samples), {
      raw: { width: decoded.width, height: decoded.height, channels: decoded.channels },
    })
      .png()
      .toBuffer();
    return { pnm: prepared.image, png, format: decoded.format };
  }

  function cliText(file: string, lang: string): string {
    return execFileSync(
      requireTesseract(),
      [file, 'stdout', '-l', lang, '--tessdata-dir', requireTessdata(lang), '--psm', '3', '--oem', '1', '-c', 'tessedit_create_tsv=1'],
      { encoding: 'utf-8', env: { ...process.env, OMP_THREAD_LIMIT: '1' }, stdio: ['ignore', 'pipe', 'ignore'] }
    );
  }

  const variants: Array<[string, string, string, Parameters<typeof preprocessOcrImage>[1] | undefined, string]> = [
    ['en_a', 'dpi72', 'eng', undefined, 'P4'],
    ['en_a', 'shade', 'eng', { rescale: false, deskew: false, binarize: false }, 'P5'],
    ['ko_a', 'clean300', 'kor', undefined, 'P4'],
  ];

  for (const [page, variant, lang, steps, format] of variants) {
    oracleTest(
      `the native engine's TSV is identical for ${page}__${variant} as ${format} and as PNG`,
      ['tesseract'],
      async () => {
        const { pnm, png, format: actual } = await pagesFor(page, variant, steps);
        expect(actual).toBe(format);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-pnm-'));
        try {
          fs.writeFileSync(path.join(dir, 'page.pnm'), pnm);
          fs.writeFileSync(path.join(dir, 'page.png'), png);
          expect(cliText(path.join(dir, 'page.pnm'), lang)).toBe(cliText(path.join(dir, 'page.png'), lang));
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'the WebAssembly engine returns the same text and word scores for a colour page as P6 and as PNG',
    ['tesseract'],
    async () => {
      const langPath = requireTessdata('eng');
      const rgb = await sharp(fixtureImage('en_a', 'shade')).toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
      const pnm = encodePpm(rgb.data, rgb.info.width, rgb.info.height);
      const png = await sharp(rgb.data, { raw: { width: rgb.info.width, height: rgb.info.height, channels: 3 } }).png().toBuffer();
      const worker = await createWorker('eng', 1, { langPath, gzip: false, errorHandler: () => undefined });
      try {
        const fromPnm = await worker.recognize(pnm, {}, { blocks: true });
        const fromPng = await worker.recognize(png, {}, { blocks: true });
        expect(fromPnm.data.text).toBe(fromPng.data.text);
        const words = (result: typeof fromPnm) =>
          result.data.blocks?.flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words.map((w) => [w.text, w.confidence, w.bbox.x0]))));
        expect(words(fromPnm)).toEqual(words(fromPng));
      } finally {
        await worker.terminate();
      }
    },
    TEST_TIMEOUT_MS
  );
});

describe('recognized text of the golden pages', () => {
  // sha256 prefixes of `performOcr(...).text`, recorded on origin/main (3f11e57) where the page was
  // handed to the engines as a PNG. The text must not change when the page travels as a PNM. The en_a dpi72
  // entry was re-recorded when binarization became a measured choice: that page reads well without it
  // (confidence 0.95), so it is no longer binarized and reads as the bare engine reads it (one character
  // differs from the binarized reading, 0.77% against 0.52% CER).
  const PNG_HANDOVER_TEXT_HASHES: Array<[string, string, string, string]> = [
    ['en_a', 'clean300', 'eng', '1dc50af9af33fbfd'],
    ['en_a', 'dpi72', 'eng', '5ee4b18e7c83fd77'],
    ['en_a', 'skew3', 'eng', '1dc50af9af33fbfd'],
    ['en_b', 'clean300', 'eng', '952a7f2b0cd9ff09'],
    ['ko_a', 'clean300', 'kor', '00d65dac2ecaba38'],
    ['ko_a', 'skew3', 'kor', '20e1df428c3c1860'],
  ];

  for (const [page, variant, lang, hash] of PNG_HANDOVER_TEXT_HASHES) {
    oracleTest(
      `${page}__${variant} reads exactly as it did through PNG`,
      ['tesseract'],
      async () => {
        requireTessdata(lang);
        const result = await performOcr(fixtureImage(page, variant), lang);
        expect(crypto.createHash('sha256').update(result.text).digest('hex').slice(0, hash.length)).toBe(hash);
      },
      TEST_TIMEOUT_MS
    );
  }
});

describe('pages that are not 8-bit gray', () => {
  const MAX_CER_PERCENT = 1;

  oracleTest(
    'a colour page is read as P6 and reads like the gray page it was made from',
    ['tesseract'],
    async () => {
      requireTessdata('eng');
      const colour = await sharp(fixtureImage('en_a', 'clean300')).toColourspace('srgb').png().toBuffer();
      const result = await performOcr(colour, 'eng');
      expect(characterErrorRatePercent(groundTruth('en_a'), result.text)).toBeLessThanOrEqual(MAX_CER_PERCENT);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a 16-bit gray page is read as 8-bit gray',
    ['tesseract'],
    async () => {
      requireTessdata('eng');
      const sixteenBit = await sharp(fixtureImage('en_a', 'clean300')).toColourspace('grey16').png().toBuffer();
      expect((await sharp(sixteenBit).metadata()).depth).toBe('ushort');
      const result = await performOcr(sixteenBit, 'eng');
      expect(characterErrorRatePercent(groundTruth('en_a'), result.text)).toBeLessThanOrEqual(MAX_CER_PERCENT);
    },
    TEST_TIMEOUT_MS
  );
});

describe('hand-over cost', () => {
  async function noisyColourPage(): Promise<Buffer> {
    const pixels = Buffer.alloc(NOISY_PAGE_WIDTH_PX * NOISY_PAGE_HEIGHT_PX * 3);
    let state = 1;
    for (let i = 0; i < pixels.length; i++) {
      state = (state * 1664525 + 1013904223) >>> 0;
      pixels[i] = state >>> 24;
    }
    return sharp(pixels, { raw: { width: NOISY_PAGE_WIDTH_PX, height: NOISY_PAGE_HEIGHT_PX, channels: 3 } })
      .png({ compressionLevel: 1 })
      .toBuffer();
  }

  // skip-ok: explicit opt-out on a slow runner (EASYCONVERT_SLOW_RUNNER=1), never set in CI.
  it.skipIf(SLOW_RUNNER)(
    `a noisy 2550x2000 colour page costs at most ${MAX_PNM_HANDOVER_RATIO}x as much to hand over as PNM as it did as PNG`,
    async () => {
      const source = await noisyColourPage();
      // Reference: the step that does not run any more (decode, then compress to PNG for the engine to decode
      // again). Candidate: the PNM hand-over with preprocessing disabled, so only the hand-over differs. Both are
      // timed interleaved in this process, so a loaded runner slows them alike.
      await expectNoSlowerThanReference(
        'PNM hand-over',
        () => sharp(source).rotate().png().toBuffer(),
        () => preprocessOcrImage(source, { rescale: false, deskew: false, binarize: false }),
        { maxRatio: MAX_PNM_HANDOVER_RATIO }
      );
    },
    TEST_TIMEOUT_MS
  );
});
