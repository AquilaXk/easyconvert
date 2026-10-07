import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { performOcr, shutdownOcrWorkerPool } from '../src/lib/conversions/ocr';
import { mapBoxToSource, type OcrGeometry } from '../src/lib/conversions/ocr-geometry';
import {
  decideOrientation,
  languageForScript,
  OSD_MIN_CONFIDENCE,
  parseOsdOutput,
  readOrientation,
  type OsdReading,
} from '../src/lib/conversions/ocr-osd';
import type { OcrBBox } from '../src/lib/conversions/ocr-pdf-combiner';
import { OcrEngineUnavailableError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { characterErrorRatePercent } from './helpers/ocr-cer';
import {
  fixtureImage,
  groundTruth,
  requireTessdata,
  requireTesseract,
} from './helpers/ocr-fixtures';

/**
 * Pages scanned sideways or upside down are turned upright before they are read, and the word boxes
 * come back in the orientation the page was scanned in. Expected text is the text drawn onto the
 * golden pages; expected turns are the turns the test itself applied to them; the reference engine
 * is the native tool's own `--psm 0`.
 */

const TEST_TIMEOUT_MS = 300_000;
const MAX_CER_GAP_POINTS = 1;
const MIN_MEAN_IOU = 0.8;
const TURNS = [90, 180, 270] as const;
type Turn = (typeof TURNS)[number];
const SLOW_RUNNER = process.env.EASYCONVERT_SLOW_RUNNER === '1';
const TIMING_RUNS = 5;
const MAX_OVERHEAD_RATIO = 1.15;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseOsdOutput', () => {
  // Printed by `tesseract page.png stdout --psm 0` for a page scanned 90 degrees clockwise.
  const REPORT = [
    'Page number: 0',
    'Orientation in degrees: 90',
    'Rotate: 270',
    'Orientation confidence: 22.92',
    'Script: Latin',
    'Script confidence: 11.94',
    '',
  ].join('\n');

  it('reads the turn that makes the page upright, the script and both confidences', () => {
    expect(parseOsdOutput(REPORT)).toEqual({
      rotateDegrees: 270,
      orientationConfidence: 22.92,
      script: 'Latin',
      scriptConfidence: 11.94,
    });
  });

  it('refuses a report that is incomplete, out of range or contradicts itself', () => {
    const failures = [
      REPORT.replace('Rotate: 270\n', ''),
      REPORT.replace('Script: Latin\n', ''),
      REPORT.replace('Rotate: 270', 'Rotate: 45'),
      REPORT.replace('Orientation in degrees: 90', 'Orientation in degrees: 180'),
      REPORT.replace('Orientation confidence: 22.92', 'Orientation confidence: -1'),
      REPORT.replace('Script confidence: 11.94', 'Script confidence: lots'),
      'Too few characters. Skipping this page',
      '',
    ];
    for (const report of failures) {
      expect(() => parseOsdOutput(report), report).toThrow(OcrEngineUnavailableError);
    }
  });
});

describe('deciding what to do with a reading', () => {
  const reading = (rotateDegrees: OsdReading['rotateDegrees'], orientationConfidence: number, script = 'Latin', scriptConfidence = 5): OsdReading => ({
    rotateDegrees,
    orientationConfidence,
    script,
    scriptConfidence,
  });

  it('turns a page the engine is sure about and records the reading', () => {
    expect(decideOrientation(reading(270, OSD_MIN_CONFIDENCE))).toEqual({
      orientation: {
        status: 'applied',
        rotationApplied: 270,
        confidence: OSD_MIN_CONFIDENCE,
        suggestedRotation: 270,
        script: 'Latin',
        scriptConfidence: 5,
      },
      quarterTurn: 270,
    });
  });

  it('leaves a page alone when the engine wants a turn but is not sure enough', () => {
    const { orientation, quarterTurn } = decideOrientation(reading(90, OSD_MIN_CONFIDENCE - 0.01));
    expect(quarterTurn).toBe(0);
    expect(orientation).toMatchObject({ status: 'low-confidence', rotationApplied: 0, suggestedRotation: 90 });
  });

  it('records an upright page and a page with too little text', () => {
    expect(decideOrientation(reading(0, 30)).orientation).toMatchObject({ status: 'upright', rotationApplied: 0 });
    expect(decideOrientation(null)).toEqual({ orientation: { status: 'too-little-text', rotationApplied: 0 }, quarterTurn: 0 });
  });

  it('picks a language from the script only for a trusted reading of a script that has one', () => {
    const korean = decideOrientation(reading(0, 6, 'Korean', 1)).orientation;
    expect(languageForScript(korean)).toBe('kor');
    expect(languageForScript(decideOrientation(reading(0, 6, 'Japanese', 0.2)).orientation)).toBe('jpn');
    expect(languageForScript(decideOrientation(reading(0, 6, 'HanS', 0.2)).orientation)).toBe('chi_sim');
    expect(languageForScript(decideOrientation(reading(0, 6, 'Latin', 9)).orientation)).toBeNull();
    expect(languageForScript(decideOrientation(reading(0, 6, 'Korean', 0.05)).orientation)).toBeNull();
    expect(languageForScript(decideOrientation(reading(90, 1, 'Korean', 1)).orientation)).toBeNull();
    expect(languageForScript(decideOrientation(null).orientation)).toBeNull();
  });
});

describe('mapping boxes back through a quarter turn', () => {
  // A 100 x 50 page. Turned 90 degrees clockwise it is 50 x 100. The box below is in the turned page.
  const turnedBox: OcrBBox = { x: 10, y: 20, width: 5, height: 8 };
  const geometry = (quarterTurnDegrees: 90 | 180 | 270, scale = 1): OcrGeometry => {
    const sideways = quarterTurnDegrees !== 180;
    const orientedWidth = sideways ? 50 : 100;
    const orientedHeight = sideways ? 100 : 50;
    return {
      sourceWidth: 100,
      sourceHeight: 50,
      quarterTurnDegrees,
      scaledWidth: orientedWidth * scale,
      scaledHeight: orientedHeight * scale,
      outputWidth: orientedWidth * scale,
      outputHeight: orientedHeight * scale,
      rotationDegrees: 0,
    };
  };

  // Hand-worked: a point (x, y) of the turned page is (y, 50 - x) on the page as scanned for 90,
  // (100 - x, 50 - y) for 180 and (100 - y, x) for 270.
  it.each([
    [90, { x: 20, y: 35, width: 8, height: 5 }],
    [180, { x: 85, y: 22, width: 5, height: 8 }],
    [270, { x: 72, y: 10, width: 8, height: 5 }],
  ] as const)('puts a box of the page turned %i degrees where it was scanned', (turn, expected) => {
    expect(mapBoxToSource(turnedBox, geometry(turn))).toMatchObject(expected);
  });

  it('undoes the rescale before the turn', () => {
    const scaled: OcrBBox = { x: 20, y: 40, width: 10, height: 16 };
    expect(mapBoxToSource(scaled, geometry(90, 2))).toMatchObject({ x: 20, y: 35, width: 8, height: 5 });
  });
});

/** Where a box of the upright page lies after the page is turned clockwise by `turn` degrees. */
function turnedBox(box: OcrBBox, turn: Turn, uprightWidth: number, uprightHeight: number): OcrBBox {
  const { x, y, width, height } = box;
  if (turn === 180) return { x: uprightWidth - x - width, y: uprightHeight - y - height, width, height };
  if (turn === 90) return { x: uprightHeight - y - height, y: x, width: height, height: width };
  return { x: y, y: uprightWidth - x - width, width: height, height: width };
}

function iou(a: OcrBBox, b: OcrBBox): number {
  const overlapX = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const overlapY = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = overlapX * overlapY;
  return intersection / (a.width * a.height + b.width * b.height - intersection);
}

async function turned(page: string, variant: string, turn: Turn): Promise<Buffer> {
  return sharp(fixtureImage(page, variant)).rotate(turn).png().toBuffer();
}

const withoutSpaces = (text: string): string => text.normalize('NFKC').replace(/\s+/g, '');

describe('reading a page scanned sideways or upside down', () => {
  const pages: Array<[string, string, string]> = [
    ['en_a', 'clean300', 'eng'],
    ['ko_a', 'clean300', 'kor'],
    ['ja_b', 'clean300', 'jpn'],
  ];

  for (const [page, variant, lang] of pages) {
    oracleTest(
      `${page}__${variant} turned 90, 180 and 270 degrees reads within ${MAX_CER_GAP_POINTS} point of the upright page`,
      ['tesseract'],
      async () => {
        requireTessdata(lang);
        requireTessdata('osd');
        const truth = withoutSpaces(groundTruth(page));
        const upright = await performOcr(fixtureImage(page, variant), lang);
        const uprightCer = characterErrorRatePercent(truth, withoutSpaces(upright.text));
        expect(upright.orientation).toMatchObject({ rotationApplied: 0 });
        for (const turn of TURNS) {
          const result = await performOcr(await turned(page, variant, turn), lang);
          const cer = characterErrorRatePercent(truth, withoutSpaces(result.text));
          expect(cer, `turned ${turn}`).toBeLessThanOrEqual(uprightCer + MAX_CER_GAP_POINTS);
        }
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'switching detection off leaves an upside-down page unreadable, which is what it cost before',
    ['tesseract'],
    async () => {
      requireTessdata('eng');
      const truth = groundTruth('en_a');
      const result = await performOcr(await turned('en_a', 'clean300', 180), 'eng', undefined, false);
      expect(result.orientation).toEqual({ status: 'disabled', rotationApplied: 0 });
      expect(characterErrorRatePercent(truth, result.text)).toBeGreaterThan(50);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'records the turn that was applied, the engine\'s confidence and the script',
    ['tesseract'],
    async () => {
      requireTessdata('eng');
      requireTessdata('osd');
      const result = await performOcr(await turned('en_a', 'clean300', 180), 'eng');
      expect(result.orientation).toMatchObject({ status: 'applied', rotationApplied: 180, suggestedRotation: 180, script: 'Latin' });
      expect(result.orientation?.confidence).toBeGreaterThanOrEqual(OSD_MIN_CONFIDENCE);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'maps the word boxes of a turned page back to the orientation it was scanned in (mean IoU >= 0.8)',
    ['tesseract'],
    async () => {
      requireTessdata('eng');
      requireTessdata('osd');
      const upright = await performOcr(fixtureImage('en_a', 'clean300'), 'eng');
      const uprightWords = (upright.lineBlocks ?? []).flatMap((block) => block.words);
      const uprightWidth = upright.imageWidth as number;
      const uprightHeight = upright.imageHeight as number;
      for (const turn of [180, 270] as const) {
        const result = await performOcr(await turned('en_a', 'clean300', turn), 'eng');
        expect(result.orientation?.rotationApplied).toBe(turn === 180 ? 180 : 90);
        const words = (result.lineBlocks ?? []).flatMap((block) => block.words);
        expect(words.map((w) => w.text)).toEqual(uprightWords.map((w) => w.text));
        const overlaps = words.map((word, index) =>
          iou(word.bbox, turnedBox(uprightWords[index].bbox, turn, uprightWidth, uprightHeight))
        );
        const mean = overlaps.reduce((sum, value) => sum + value, 0) / overlaps.length;
        expect(mean, `turned ${turn}`).toBeGreaterThanOrEqual(MIN_MEAN_IOU);
        // The page the boxes are on is the page as scanned.
        expect([result.imageWidth, result.imageHeight]).toEqual(
          turn === 180 ? [uprightWidth, uprightHeight] : [uprightHeight, uprightWidth]
        );
      }
    },
    TEST_TIMEOUT_MS
  );
});

describe('against the reference engine', () => {
  const pages: Array<[string, string, string]> = [
    ['en_a', 'clean300', 'eng'],
    ['ko_a', 'clean300', 'kor'],
  ];

  for (const [page, variant] of pages) {
    oracleTest(
      `${page}__${variant}: the turn read from the densest window is the turn \`tesseract --psm 0\` reads from the whole page`,
      ['tesseract'],
      async () => {
        const tessdataDir = requireTessdata('osd');
        const cli = requireTesseract();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-osd-'));
        try {
          for (const turn of TURNS) {
            const file = path.join(dir, `page-${turn}.png`);
            fs.writeFileSync(file, await turned(page, variant, turn));
            const reference = execFileSync(cli, [file, 'stdout', '--tessdata-dir', tessdataDir, '--psm', '0', '-l', 'osd'], {
              encoding: 'utf-8',
              env: { ...process.env, OMP_THREAD_LIMIT: '1' },
              stdio: ['ignore', 'pipe', 'ignore'],
            });
            const referenceRotate = Number(/^Rotate: (\d+)$/m.exec(reference)?.[1]);
            const reading = await readOrientation(fs.readFileSync(file), { tessdataDir, gzip: false, cliPath: cli });
            expect(reading?.rotateDegrees, `turned ${turn}`).toBe(referenceRotate);
            expect(referenceRotate).toBe((360 - turn) % 360);
          }
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
          await shutdownOcrWorkerPool();
        }
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'a page with no text is reported as having too little to read',
    ['tesseract'],
    async () => {
      const tessdataDir = requireTessdata('osd');
      const blank = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#ffffff' } }).png().toBuffer();
      expect(await readOrientation(blank, { tessdataDir, gzip: false })).toBeNull();
    },
    TEST_TIMEOUT_MS
  );
});

describe('upright pages are never turned', () => {
  // Every degradation of the English and Korean golden pages, including the 72 dpi pages whose
  // text is too small for the engine to read an orientation from.
  const pages: Array<[string, string]> = [
    ['en_a', 'clean300'],
    ['en_a', 'dpi72'],
    ['en_a', 'noise'],
    ['en_b', 'dpi72'],
    ['ko_a', 'clean300'],
    ['ko_a', 'dpi72'],
    ['ko_a', 'noise'],
    ['ko_a', 'skew3'],
    ['twocol', 'dpi150'],
  ];

  for (const [page, variant] of pages) {
    oracleTest(
      `${page}__${variant} keeps its orientation (the 72 dpi pages are the ones the engine misreads)`,
      ['tesseract'],
      async () => {
        const lang = page.startsWith('ko') ? 'kor' : 'eng';
        requireTessdata(lang);
        const detected = await performOcr(fixtureImage(page, variant), lang);
        expect(detected.orientation?.rotationApplied).toBe(0);
        if (variant === 'dpi72') {
          const plain = await performOcr(fixtureImage(page, variant), lang, undefined, false);
          expect(detected.text).toBe(plain.text);
        }
      },
      TEST_TIMEOUT_MS
    );
  }
});

describe('script and the language of a request that named none', () => {
  oracleTest(
    'a Korean page read as `auto` is read in Korean',
    ['tesseract'],
    async () => {
      requireTessdata('kor');
      requireTessdata('osd');
      const result = await performOcr(fixtureImage('ko_a', 'clean300'), 'auto');
      expect(result.language).toBe('kor');
      expect(result.orientation).toMatchObject({ script: 'Korean', languageFromScript: 'kor' });
      expect(characterErrorRatePercent(groundTruth('ko_a'), result.text)).toBeLessThanOrEqual(2);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a request that names a language keeps it whatever the script says',
    ['tesseract'],
    async () => {
      requireTessdata('eng');
      requireTessdata('osd');
      const result = await performOcr(fixtureImage('ko_a', 'clean300'), 'eng');
      expect(result.language).toBe('eng');
      expect(result.orientation?.languageFromScript).toBeUndefined();
    },
    TEST_TIMEOUT_MS
  );
});

describe('when the detection data is missing', () => {
  /** Hides osd.traineddata from the data lookup, as on an image without it. */
  function withoutOsdData(): void {
    const exists = fs.existsSync.bind(fs);
    vi.spyOn(fs, 'existsSync').mockImplementation((file) => !/osd\.traineddata/.test(String(file)) && exists(file));
  }

  oracleTest(
    'asking for detection fails with a 503-class error instead of skipping it',
    ['tesseract'],
    async () => {
      requireTessdata('eng');
      withoutOsdData();
      const failure = await performOcr(fixtureImage('en_a', 'clean300'), 'eng', undefined, true).then(
        () => null,
        (err: unknown) => err as Error
      );
      expect(failure).toBeInstanceOf(OcrEngineUnavailableError);
      expect(failure?.message).toBe(
        "Orientation detection needs the 'osd' OCR data (osd.traineddata), which is not available locally."
      );
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'by default the page is read as it is and the skip is recorded',
    ['tesseract'],
    async () => {
      requireTessdata('eng');
      withoutOsdData();
      const result = await performOcr(await turned('en_a', 'clean300', 180), 'eng');
      expect(result.orientation).toEqual({ status: 'unavailable', rotationApplied: 0 });
    },
    TEST_TIMEOUT_MS
  );
});

describe('cost', () => {
  oracleTest(
    `a page that reads well costs no more than ${MAX_OVERHEAD_RATIO}x what it costs with detection off`,
    ['tesseract'],
    async (ctx) => {
      if (SLOW_RUNNER) {
        ctx.skip();
        return;
      }
      requireTessdata('eng');
      requireTessdata('osd');
      const image = fixtureImage('en_a', 'noise');
      await performOcr(image, 'eng', undefined, false);
      let off = Infinity;
      let on = Infinity;
      for (let run = 0; run < TIMING_RUNS; run++) {
        let started = performance.now();
        await performOcr(image, 'eng', undefined, false);
        off = Math.min(off, performance.now() - started);
        started = performance.now();
        await performOcr(image, 'eng');
        on = Math.min(on, performance.now() - started);
      }
      expect(on / off).toBeLessThanOrEqual(MAX_OVERHEAD_RATIO);
    },
    TEST_TIMEOUT_MS
  );
});
