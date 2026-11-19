import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { JOB_DEADLINE_AT } from '../src/lib/conversions/job-time';
import {
  PPTX_LEGACY_PPT_BRIDGE,
  PPT_BRIDGE_MAX_SHAPES_TOTAL,
  PPT_BRIDGE_MAX_SLIDES,
  PPT_BRIDGE_MAX_VECTOR_SHAPES_PER_SLIDE,
  PPT_BRIDGE_MAX_VECTOR_SHAPES_TOTAL,
  pdfToPptx,
  writePackage,
  type SlidePage,
} from '../src/lib/conversions/office/pdf-pptx';
import { CFBF_MAGIC } from '../src/lib/format-signatures';
import { CpuTaskTimeoutError, JobTimeoutError, PayloadLimitError, type ConversionOptions } from '../src/lib/types';
import { convertBridgedTarget, type OfficeSuiteRequest, type OfficeSuiteRouteDeps } from '../src/worker/office-suite-route';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { rawPdf, run as pdfRun } from './helpers/raw-pdf';

const ROOT = path.resolve(__dirname, '..');
const PPT_BRIDGE_HANG_GUARD_MS = 30_000;

function extractSlideTexts(slideXml: string): string[] {
  return [...slideXml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) =>
    m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  );
}

async function readSlides(pptx: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(pptx);
  const names = Object.keys(zip.files)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));
  return Promise.all(names.map((entry) => zip.file(entry)!.async('string')));
}

function buildMultiLineAndDenseVectorPdf(vectorLinesPerPage2: number): Buffer {
  const page1Lines = [
    pdfRun('First paragraph line one describes layout consolidation.', 72, 710, 12),
    pdfRun('First paragraph line two continues smoothly without gaps.', 72, 695, 12),
    pdfRun('First paragraph line three concludes the block cleanly.', 72, 680, 12),
    // 4 decorative filled rectangles (well below 200)
    '0.8 0.2 0.2 rg 72 600 120 20 re f\n',
    '0.2 0.5 0.8 rg 72 560 120 20 re f\n',
    '0.2 0.7 0.3 rg 72 520 120 20 re f\n',
    '0.4 0.4 0.4 rg 72 480 120 20 re f\n',
  ].join('');

  const vectorLines: string[] = [];
  for (let i = 0; i < vectorLinesPerPage2; i++) {
    const x0 = 72 + (i % 40) * 10;
    const y0 = 100 + Math.floor(i / 40) * 12;
    vectorLines.push(`0.1 0.1 0.1 RG 0.5 w ${x0} ${y0} m ${x0 + 8} ${y0 + 8} l S\n`);
    vectorLines.push(`0.9 0.9 0.9 rg ${x0} ${y0} 6 6 re f\n`);
  }
  const page2Content = [
    pdfRun('Dense vector diagram page keeps all paragraph text.', 72, 720, 12),
    pdfRun('Second line of diagram caption remains intact.', 72, 705, 12),
    ...vectorLines,
  ].join('');

  return rawPdf([
    { width: 612, height: 792, content: page1Lines },
    { width: 612, height: 792, content: page2Content },
  ]);
}

describe('PPT bridge hang elimination, job budget clamping, and real-engine soak', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  const makeTempDir = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  describe('1. convertBridgedTarget stage budget propagation and fail-closed timeout', () => {
    it('aborts before Stage 2 when Stage 1 exhausts JOB_DEADLINE_AT and discards Stage 1 temp output', async () => {
      const tempStage1 = path.join(makeTempDir('bridge-expired-'), 'stage1.pptx');
      fs.writeFileSync(tempStage1, Buffer.from('stage1'));
      const discarded: Array<string | undefined> = [];
      let suiteCalls = 0;

      const deps: OfficeSuiteRouteDeps = {
        async convert() {
          await new Promise((r) => setTimeout(r, 35));
          return {
            buffer: Buffer.from('stage1'),
            filePath: tempStage1,
            mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            filename: 'out.pptx',
            size: 6,
            engineUsed: 'internal-fallback',
            executionTimeMs: 35,
          };
        },
        async writeWithOfficeSuite() {
          suiteCalls++;
          return null;
        },
        discardOutput(filePath) {
          discarded.push(filePath);
          if (filePath && fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
        },
      };

      const req: OfficeSuiteRequest = {
        input: Buffer.from('%PDF-1.4'),
        src: 'pdf',
        tgt: 'ppt',
        options: { [JOB_DEADLINE_AT]: Date.now() + 15 } as OfficeSuiteRequest['options'],
        originalFilename: 'expired.pdf',
      };

      await expect(
        convertBridgedTarget(deps, req, async () => {
          throw new Error('direct path should not run');
        })
      ).rejects.toBeInstanceOf(CpuTaskTimeoutError);
      expect(suiteCalls).toBe(0);
      expect(discarded).toEqual([tempStage1]);
      expect(fs.existsSync(tempStage1)).toBe(false);
    });

    it('preserves aborted signal reason (JobTimeoutError) after Stage 1 without invoking Stage 2', async () => {
      const controller = new AbortController();
      const stage1Path = path.join(makeTempDir('bridge-abort-'), 'stage1.docx');
      fs.writeFileSync(stage1Path, Buffer.from('docx'));
      let suiteCalls = 0;
      const discarded: Array<string | undefined> = [];

      const deps: OfficeSuiteRouteDeps = {
        async convert() {
          controller.abort(new JobTimeoutError(5_000));
          return {
            buffer: Buffer.from('docx'),
            filePath: stage1Path,
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            filename: 'a.docx',
            size: 4,
            engineUsed: 'internal-fallback',
            executionTimeMs: 10,
          };
        },
        async writeWithOfficeSuite() {
          suiteCalls++;
          return null;
        },
        discardOutput(filePath) {
          discarded.push(filePath);
        },
      };

      const req: OfficeSuiteRequest = {
        input: Buffer.from('%PDF-1.4'),
        src: 'pdf',
        tgt: 'doc',
        options: { [JOB_DEADLINE_AT]: Date.now() + 5, signal: controller.signal } as OfficeSuiteRequest['options'],
        originalFilename: 'a.pdf',
      };

      await expect(
        convertBridgedTarget(deps, req, async () => {
          throw new Error('direct path should not run');
        })
      ).rejects.toBeInstanceOf(JobTimeoutError);
      expect(suiteCalls).toBe(0);
      expect(discarded).toEqual([stage1Path]);
    });

    it('clamps Stage 2 timeoutMs and propagates JOB_DEADLINE_AT after Stage 1, and tags PPTX_LEGACY_PPT_BRIDGE only for ppt', async () => {
      const seenStage1: Array<Record<string | symbol, unknown>> = [];
      const seenStage2: Array<Record<string | symbol, unknown>> = [];
      let stage1FinishedAt = 0;

      const deps: OfficeSuiteRouteDeps = {
        async convert(_in, _src, _tgt, opts) {
          seenStage1.push(opts as unknown as Record<string | symbol, unknown>);
          await new Promise((r) => setTimeout(r, 40));
          stage1FinishedAt = Date.now();
          return {
            buffer: Buffer.from('bridge'),
            mimeType: 'application/octet-stream',
            filename: 'a.pptx',
            size: 6,
            engineUsed: 'internal-fallback',
            executionTimeMs: 40,
          };
        },
        async writeWithOfficeSuite(_in, _src, tgt, opts) {
          seenStage2.push(opts as unknown as Record<string | symbol, unknown>);
          return {
            buffer: Buffer.from(CFBF_MAGIC),
            mimeType: tgt === 'ppt' ? 'application/vnd.ms-powerpoint' : 'application/msword',
            filename: `a.${tgt}`,
            size: CFBF_MAGIC.length,
            engineUsed: 'native-soffice',
            executionTimeMs: 5,
          };
        },
        discardOutput() {},
      };

      await convertBridgedTarget(
        deps,
        {
          input: Buffer.from('%PDF-1.4'),
          src: 'pdf',
          tgt: 'ppt',
          options: { timeoutMs: 2_000 } as OfficeSuiteRequest['options'],
          originalFilename: 'deck.pdf',
        },
        async () => {
          throw new Error('unexpected');
        }
      );

      const deadlineAt = seenStage1[0]?.[JOB_DEADLINE_AT] as number;
      const maxRemainingAfterStage1 = Math.max(1, deadlineAt - stage1FinishedAt);
      const stage1Limit = seenStage1[0]?.timeoutMs as number;
      const stage2Limit = seenStage2[0]?.timeoutMs as number;
      expect(seenStage1[0]?.[PPTX_LEGACY_PPT_BRIDGE]).toBe(true);
      expect(typeof deadlineAt).toBe('number');
      expect(typeof seenStage2[0]?.[JOB_DEADLINE_AT]).toBe('number');
      expect(seenStage2[0]?.[JOB_DEADLINE_AT]).toBe(deadlineAt);
      expect(stage2Limit).toBeTypeOf('number');
      expect(stage2Limit).toBeLessThan(stage1Limit);
      expect(stage2Limit).toBeLessThanOrEqual(maxRemainingAfterStage1);
      expect(stage2Limit).toBeGreaterThanOrEqual(1);

      await convertBridgedTarget(
        deps,
        {
          input: Buffer.from('%PDF-1.4'),
          src: 'pdf',
          tgt: 'doc',
          options: {} as OfficeSuiteRequest['options'],
          originalFilename: 'doc.pdf',
        },
        async () => {
          throw new Error('unexpected');
        }
      );
      expect(seenStage1[1]?.[PPTX_LEGACY_PPT_BRIDGE]).toBeUndefined();
    });
  });

  describe('2. pdfToPptx PPT bridge consolidation, vector caps, and fail-closed bounds', () => {
    it('keeps pure pdf->pptx line boxes and all vector shapes untouched while consolidating & bounding ppt bridge mode', async () => {
      const pdf = buildMultiLineAndDenseVectorPdf(300);

      // Pure pdf->pptx (unchanged)
      const purePptx = await pdfToPptx(pdf, {}, 'pure');
      const pureSlides = await readSlides(purePptx);
      expect(pureSlides).toHaveLength(2);
      const pureSlide1TextBoxes = (pureSlides[0].match(/txBox="1"/g) ?? []).length;
      expect(pureSlide1TextBoxes).toBe(3); // 3 separate lines on page 1
      const pureSlide2Shapes = (pureSlides[1].match(/<p:sp>/g) ?? []).length - (pureSlides[1].match(/txBox="1"/g) ?? []).length;
      const pureSlide2Rules = (pureSlides[1].match(/<p:cxnSp>/g) ?? []).length;
      expect(pureSlide2Shapes + pureSlide2Rules).toBeGreaterThan(PPT_BRIDGE_MAX_VECTOR_SHAPES_PER_SLIDE);

      // Bridged pdf->ppt intermediate PPTX
      const bridgeOpts = { [PPTX_LEGACY_PPT_BRIDGE]: true } as unknown as ConversionOptions;
      const bridgedPptx = await pdfToPptx(pdf, bridgeOpts, 'bridged');
      const bridgedSlides = await readSlides(bridgedPptx);
      expect(bridgedSlides).toHaveLength(2);

      // Multi-line paragraphs consolidated to 1 text box per paragraph
      expect((bridgedSlides[0].match(/txBox="1"/g) ?? []).length).toBe(1);
      expect((bridgedSlides[1].match(/txBox="1"/g) ?? []).length).toBe(1);

      // Slide 1 (<= 200 vectors) preserves its 4 decorative shapes
      const bridgedSlide1NonTextSp =
        (bridgedSlides[0].match(/<p:sp>/g) ?? []).length - (bridgedSlides[0].match(/txBox="1"/g) ?? []).length;
      expect(bridgedSlide1NonTextSp).toBe(4);

      // Slide 2 (> 200 vectors) omits overloaded decorative vectors while keeping all paragraph text
      const bridgedSlide2NonTextSp =
        (bridgedSlides[1].match(/<p:sp>/g) ?? []).length - (bridgedSlides[1].match(/txBox="1"/g) ?? []).length;
      const bridgedSlide2Rules = (bridgedSlides[1].match(/<p:cxnSp>/g) ?? []).length;
      expect(bridgedSlide2NonTextSp + bridgedSlide2Rules).toBe(0);

      const allText = bridgedSlides.flatMap(extractSlideTexts).join(' ');
      expect(allText).toContain('First paragraph line one describes layout consolidation.');
      expect(allText).toContain('First paragraph line three concludes the block cleanly.');
      expect(allText).toContain('Dense vector diagram page keeps all paragraph text.');
      expect(allText).toContain('Second line of diagram caption remains intact.');
    });

    it('bounds cumulative decorative vectors across many slides to PPT_BRIDGE_MAX_VECTOR_SHAPES_TOTAL', async () => {
      const makePage = (shapeCount: number, label: string): SlidePage => ({
        width: 612,
        height: 792,
        images: [],
        rules: [],
        shapes: Array.from({ length: shapeCount }, (_, idx) => ({
          kind: 'rect' as const,
          x0: 10 + (idx % 20),
          y0: 10 + Math.floor(idx / 20) * 5,
          x1: 18 + (idx % 20),
          y1: 14 + Math.floor(idx / 20) * 5,
          fill: 0x336699,
          z: idx,
        })),
        blocks: [],
        plainText: undefined,
      });

      // 15 pages x 180 vectors = 2,700 (> 2,000 total budget, even though each page <= 200)
      const pages: SlidePage[] = Array.from({ length: 15 }, (_, i) => ({
        ...makePage(180, `Slide ${i + 1}`),
        plainText: undefined,
        blocks: [
          {
            kind: 'paragraph',
            columns: 1,
            band: 0,
            full: true,
            paragraph: {
              runs: [{ text: `Slide ${i + 1}`, bold: false, italic: false, monospace: false }],
              text: `Slide ${i + 1}`,
              lines: [
                {
                  runs: [{ text: `Slide ${i + 1}`, bold: false, italic: false, monospace: false }],
                  text: `Slide ${i + 1}`,
                  box: { x0: 72, y0: 72, x1: 200, y1: 86 },
                  baseline: 84,
                  size: 12,
                  bold: false,
                  italic: false,
                  monospace: false,
                  rtl: false,
                  fontKey: 'F1',
                  vertical: false,
                },
              ],
              box: { x0: 72, y0: 72, x1: 200, y1: 86 },
              size: 12,
              bold: false,
              italic: false,
              monospace: false,
              rtl: false,
              fontKey: 'F1',
              firstLineX: 72,
              leftX: 72,
              flow: 1,
              pageNumber: i + 1,
              full: true,
            },
          },
        ],
      }));

      const pptx = await writePackage(pages, new Map(), 'multi-vector', { legacyPptBridge: true });
      const slides = await readSlides(pptx);
      let totalVectorSp = 0;
      for (const slide of slides) {
        const sp = (slide.match(/<p:sp>/g) ?? []).length;
        const tx = (slide.match(/txBox="1"/g) ?? []).length;
        totalVectorSp += sp - tx;
      }
      expect(totalVectorSp).toBeLessThanOrEqual(PPT_BRIDGE_MAX_VECTOR_SHAPES_TOTAL);
      expect(totalVectorSp).toBeGreaterThan(0);
      expect(slides.flatMap(extractSlideTexts).join(' ')).toContain('Slide 15');
    });

    it('fails closed with 413 PayloadLimitError when legacy .ppt bridge exceeds slide or total shape limits', async () => {
      const tinyPage = (text: string): SlidePage => ({
        width: 612,
        height: 792,
        images: [],
        rules: [],
        shapes: [],
        blocks: [],
        plainText: text,
      });

      const tooManySlides = Array.from({ length: PPT_BRIDGE_MAX_SLIDES + 1 }, (_, i) => tinyPage(`P${i + 1}`));
      await expect(writePackage(tooManySlides, new Map(), 'too-many-slides', { legacyPptBridge: true })).rejects.toMatchObject({
        name: 'PayloadLimitError',
        status: 413,
      });

      // Exceeding PPT_BRIDGE_MAX_SHAPES_TOTAL across 10 slides (2,001 text boxes per slide)
      const makeLine = (i: number) => ({
        runs: [{ text: `w${i}`, bold: false, italic: false, monospace: false }],
        text: `w${i}`,
        box: { x0: 10, y0: 10 + i, x1: 40, y1: 20 + i },
        baseline: 18 + i,
        size: 10,
        bold: false,
        italic: false,
        monospace: false,
        rtl: false,
        fontKey: 'F1',
        vertical: false,
      });
      const heavyPages: SlidePage[] = Array.from({ length: 10 }, (_, p) => ({
        width: 612,
        height: 792,
        images: [],
        rules: [],
        shapes: [],
        blocks: Array.from({ length: Math.ceil((PPT_BRIDGE_MAX_SHAPES_TOTAL + 10) / 10) }, (_, j) => {
          const line = makeLine(j);
          return {
            kind: 'paragraph' as const,
            columns: 1,
            band: 0,
            full: true,
            paragraph: {
              runs: line.runs,
              text: line.text,
              lines: [line],
              box: line.box,
              size: 10,
              bold: false,
              italic: false,
              monospace: false,
              rtl: false,
              fontKey: 'F1',
              firstLineX: 10,
              leftX: 10,
              flow: 1,
              pageNumber: p + 1,
              full: true,
            },
          };
        }),
      }));
      await expect(writePackage(heavyPages, new Map(), 'too-many-shapes', { legacyPptBridge: true })).rejects.toMatchObject({
        name: 'PayloadLimitError',
        status: 413,
      });
    });

    oracleTest(
      'converts a dense-vector multi-paragraph PDF to valid CFBF .ppt with LibreOffice inside hang guard and preserves slide text',
      ['soffice', 'pdftotext'],
      async () => {
        const pdf = buildMultiLineAndDenseVectorPdf(1_200);
        const res = await dispatchConversion(pdf, 'pdf', 'ppt', {}, 'dense-vectors.pdf');
        expect(Buffer.from(res.buffer.subarray(0, 8))).toEqual(Buffer.from(CFBF_MAGIC));
        expect(res.buffer.length).toBeGreaterThan(10_000);

        const dir = makeTempDir('ppt-oracle-');
        const pptPath = path.join(dir, 'out.ppt');
        fs.writeFileSync(pptPath, res.buffer);
        execFileSync(
          requireOracleTool('soffice'),
          ['--headless', `-env:UserInstallation=file://${path.join(dir, 'profile')}`, '--convert-to', 'pdf', '--outdir', dir, pptPath],
          { timeout: PPT_BRIDGE_HANG_GUARD_MS, stdio: 'ignore' }
        );
        const extracted = execFileSync(requireOracleTool('pdftotext'), ['-enc', 'UTF-8', path.join(dir, 'out.pdf'), '-'], { encoding: 'utf8' });
        expect(extracted).toContain('First paragraph line one describes layout consolidation.');
        expect(extracted).toContain('Dense vector diagram page keeps all paragraph text.');
      },
      PPT_BRIDGE_HANG_GUARD_MS * 2
    );
  });

  describe('3. scripts/run-endurance-soak.ts real conversion engine cycle & CLI flags', () => {
    it('executes real conversion engine cycles by default, supports --chunk-mb and --max-drift-mb, and leaves zero temp residue', () => {
      const dir = makeTempDir('real-soak-');
      const outputPath = path.join(dir, 'soak-telemetry.json');
      const run = spawnSync(
        process.execPath,
        [
          '--expose-gc',
          '--import',
          'tsx',
          path.join(ROOT, 'scripts', 'run-endurance-soak.ts'),
          '--duration',
          '4s',
          '--target-mb',
          '1',
          '--chunk-mb',
          '0.25',
          '--max-drift-mb',
          '64',
          '--snapshot-interval-ms',
          '250',
          '--quiet',
          '--output',
          outputPath,
        ],
        { encoding: 'utf8', timeout: PPT_BRIDGE_HANG_GUARD_MS }
      );
      expect(run.status, run.stderr).toBe(0);
      expect(fs.existsSync(outputPath)).toBe(true);
      const report = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as {
        totalIterations: number;
        totalBytesProcessed: number;
        isMemoryStable: boolean;
        fdDelta: number;
        engineSoak?: {
          enabled: boolean;
          cyclesCompleted: number;
          conversionCounts: Record<string, number>;
          leftoverTempEntries: number;
        };
      };
      expect(report.totalIterations).toBeGreaterThanOrEqual(1);
      expect(report.totalBytesProcessed).toBeGreaterThanOrEqual(1024 * 1024);
      expect(report.isMemoryStable).toBe(true);
      expect(report.fdDelta).toBeLessThanOrEqual(3);
      expect(report.engineSoak?.enabled).toBe(true);
      expect(report.engineSoak?.cyclesCompleted).toBeGreaterThanOrEqual(1);
      expect(report.engineSoak?.conversionCounts.image).toBeGreaterThanOrEqual(2);
      expect(report.engineSoak?.conversionCounts.document).toBeGreaterThanOrEqual(2);
      expect(report.engineSoak?.conversionCounts.pdfText).toBeGreaterThanOrEqual(1);
      expect(report.engineSoak?.conversionCounts.archive).toBeGreaterThanOrEqual(2);
      expect(report.engineSoak?.leftoverTempEntries).toBe(0);
    }, 45_000);

    it('supports --stream-only flag while preserving SoakSessionReport schema compatibility', () => {
      const dir = makeTempDir('stream-only-soak-');
      const outputPath = path.join(dir, 'soak-telemetry.json');
      const run = spawnSync(
        process.execPath,
        [
          '--expose-gc',
          '--import',
          'tsx',
          path.join(ROOT, 'scripts', 'run-endurance-soak.ts'),
          '--stream-only',
          '--duration',
          '2s',
          '--target-mb',
          '1',
          '--quiet',
          '--output',
          outputPath,
        ],
        { encoding: 'utf8', timeout: PPT_BRIDGE_HANG_GUARD_MS }
      );
      expect(run.status, run.stderr).toBe(0);
      const report = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as {
        totalIterations: number;
        isMemoryStable: boolean;
        engineSoak?: { enabled: boolean; cyclesCompleted: number };
      };
      expect(report.totalIterations).toBeGreaterThanOrEqual(1);
      expect(report.isMemoryStable).toBe(true);
      expect(report.engineSoak?.enabled).toBe(false);
      expect(report.engineSoak?.cyclesCompleted).toBe(0);
    }, 30_000);
  });
});
