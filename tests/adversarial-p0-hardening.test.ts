import { constants as bufferConstants } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dispatchConversion, materializeResultForTest } from '../src/lib/conversions/dispatch';
import { convertMedia } from '../src/lib/conversions/media';
import {
  buildFfmpegArguments,
  resetHardwareAccelerationCache,
} from '../src/lib/conversions/media-ffmpeg-args';
import { openMediaInput } from '../src/lib/conversions/media-process';
import {
  OcrWorkerPool,
  type OcrPooledWorker,
  type OcrWorkerHealth,
  type OcrWorkerSpec,
} from '../src/lib/conversions/ocr-worker-pool';
import {
  SpreadsheetDagEngine,
  SpreadsheetFormulaEvaluator,
} from '../src/lib/conversions/office/spreadsheet-formula';
import {
  runTilesOnThreads,
  shutdownDemosaicThreads,
} from '../src/lib/conversions/raw-demosaic-threads';
import type { TileJob } from '../src/lib/conversions/raw-demosaic-tiles';
import { demosaicAmazeBayerCfa } from '../src/lib/conversions/raw-demosaic';
import { encodeBinaryStl, encodeStl, type TessellatedMesh } from '../src/lib/edge/pure/pure-cad';
import { convertPureCanvas, encodeBmpFromImageData } from '../src/lib/edge/pure/pure-canvas';
import { convertPureData } from '../src/lib/edge/pure/pure-data';
import {
  ConversionFailedError,
  PayloadLimitError,
} from '../src/lib/types';
import {
  hasNonWhitespaceBytes,
  resolveNativeBinary,
  resetNativeBinaryCache,
} from '../src/worker/engines';
import { createConversionResult } from '../src/worker/worker-output';
import { LibreOfficePoolManager, type SandboxedProcessRunner } from '../src/worker/libreoffice-pool';

const scratchDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function writeStubExecutable(dir: string, name: string, body: string): string {
  const target = path.join(dir, name);
  fs.writeFileSync(target, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return target;
}

afterEach(() => {
  resetHardwareAccelerationCache();
  resetNativeBinaryCache();
  shutdownDemosaicThreads();
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Track B P0 adversarial hardening regressions', () => {
  describe('F-01: media hardware gating, CRF fidelity, NVENC flags, and default originalFilename', () => {
    it('gates videotoolbox behind explicit gpuAcceleration: true while still probing hardware once for default options', async () => {
      const dir = makeTempDir('f01-vt-');
      const logFile = path.join(dir, 'ffmpeg.log');
      const ffmpegStub = writeStubExecutable(
        dir,
        'ffmpeg',
        [
          `printf '%s\\n' "$*" >> "${logFile}"`,
          'case " $* " in',
          '  *" -encoders "*)',
          '    printf " V....D libx264\\n V....D h264_videotoolbox\\n V....D hevc_videotoolbox\\n A....D aac\\n"',
          '    exit 0 ;;',
          'esac',
          'exit 0',
        ].join('\n'),
      );
      const mediaIn = openMediaInput(path.join(dir, 'absent.mp4'), 'mp4');

      const defaultArgs = await buildFfmpegArguments(
        mediaIn,
        path.join(dir, 'out-default.mp4'),
        'mp4',
        {},
        ffmpegStub,
      );
      const cvIdxDefault = defaultArgs.indexOf('-c:v');
      expect(defaultArgs[cvIdxDefault + 1]).toBe('libx264');
      expect(fs.existsSync(logFile)).toBe(true);

      if (process.platform === 'darwin') {
        const gpuArgs = await buildFfmpegArguments(
          mediaIn,
          path.join(dir, 'out-gpu.mp4'),
          'mp4',
          { gpuAcceleration: true },
          ffmpegStub,
        );
        const cvIdxGpu = gpuArgs.indexOf('-c:v');
        expect(gpuArgs[cvIdxGpu + 1]).toBe('h264_videotoolbox');
      }
    });

    it('keeps libx264 when explicit rateControl.mode === "crf" is requested without gpuAcceleration: true', async () => {
      const dir = makeTempDir('f01-crf-');
      const ffmpegStub = writeStubExecutable(
        dir,
        'ffmpeg',
        [
          'case " $* " in',
          '  *" -encoders "*)',
          '    printf " V....D libx264\\n V....D h264_nvenc\\n A....D aac\\n"',
          '    exit 0 ;;',
          '  *" -c:v h264_nvenc "*)',
          '    exit 0 ;;',
          'esac',
          'exit 0',
        ].join('\n'),
      );
      const mediaIn = openMediaInput(path.join(dir, 'absent.mp4'), 'mp4');

      // Default {} on NVENC host selects h264_nvenc
      const implicitArgs = await buildFfmpegArguments(
        mediaIn,
        path.join(dir, 'out-implicit.mp4'),
        'mp4',
        {},
        ffmpegStub,
      );
      expect(implicitArgs[implicitArgs.indexOf('-c:v') + 1]).toBe('h264_nvenc');

      // Explicit CRF without gpuAcceleration: true stays on libx264
      const explicitCrfArgs = await buildFfmpegArguments(
        mediaIn,
        path.join(dir, 'out-crf.mp4'),
        'mp4',
        { video: { rateControl: { mode: 'crf', crf: 21 } } },
        ffmpegStub,
      );
      expect(explicitCrfArgs[explicitCrfArgs.indexOf('-c:v') + 1]).toBe('libx264');
      expect(explicitCrfArgs[explicitCrfArgs.indexOf('-crf') + 1]).toBe('21');
    });

    it('maps x264 presets to NVENC p1..p7, emits -rc vbr -cq -b:v 0, and forwards -profile:v and -level', async () => {
      const dir = makeTempDir('f01-nvenc-');
      const ffmpegStub = writeStubExecutable(
        dir,
        'ffmpeg',
        [
          'case " $* " in',
          '  *" -encoders "*)',
          '    printf " V....D libx264\\n V....D h264_nvenc\\n A....D aac\\n"',
          '    exit 0 ;;',
          '  *" -c:v h264_nvenc "*)',
          '    exit 0 ;;',
          'esac',
          'exit 0',
        ].join('\n'),
      );
      const mediaIn = openMediaInput(path.join(dir, 'absent.mp4'), 'mp4');

      const args = await buildFfmpegArguments(
        mediaIn,
        path.join(dir, 'out-nvenc.mp4'),
        'mp4',
        {
          gpuAcceleration: true,
          video: {
            preset: 'slower',
            profile: 'high',
            level: '4.1',
            rateControl: { mode: 'crf', crf: 19 },
          },
        },
        ffmpegStub,
      );

      expect(args[args.indexOf('-c:v') + 1]).toBe('h264_nvenc');
      expect(args[args.indexOf('-preset') + 1]).toBe('p6');
      expect(args[args.indexOf('-rc') + 1]).toBe('vbr');
      expect(args[args.indexOf('-cq') + 1]).toBe('19');
      expect(args[args.indexOf('-b:v') + 1]).toBe('0');
      expect(args[args.indexOf('-profile:v') + 1]).toBe('high');
      expect(args[args.indexOf('-level') + 1]).toBe('4.1');
    });

    it('defaults originalFilename in 4-argument convertMedia calls without throwing TypeError', async () => {
      const pcm = new Int16Array([0, 1200, -1200, 400]);
      const wav = Buffer.alloc(44 + pcm.byteLength);
      wav.write('RIFF', 0);
      wav.writeUInt32LE(36 + pcm.byteLength, 4);
      wav.write('WAVE', 8);
      wav.write('fmt ', 12);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(8000, 24);
      wav.writeUInt32LE(16000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write('data', 36);
      wav.writeUInt32LE(pcm.byteLength, 40);
      Buffer.from(pcm.buffer).copy(wav, 44);

      const callFourArgs = convertMedia as unknown as (
        buf: Buffer,
        src: string,
        tgt: string,
        opts?: Record<string, unknown>,
      ) => Promise<{ filename: string; mimeType: string }>;
      const res = await callFourArgs(wav, 'wav', 'wav', { disableNativeEngine: true });
      expect(res.filename).toBe('input.wav');
      expect(res.mimeType).toBe('audio/wav');
    });
  });

  describe('F-02 & F-03: spreadsheet formula O(1)-stack loops, unique range budget, and lookup caching', () => {
    it('evaluates =MIN(A1:A90000,B1:B90000) and =MAX(...) across 180,000 cells without call-stack overflow', () => {
      const cells: Record<string, number> = {
        A1: 500,
        A45000: -42,
        A90000: 999,
        B1: 10,
        B60000: 123456,
        B90000: -7,
      };
      const evaluator = new SpreadsheetFormulaEvaluator((ref) => cells[ref] ?? 1);
      expect(evaluator.evaluate('=MIN(A1:A90000,B1:B90000)')).toBe(-42);

      const maxEval = new SpreadsheetFormulaEvaluator((ref) => cells[ref] ?? 1);
      expect(maxEval.evaluate('=MAX(A1:A90000,B1:B90000)')).toBe(123456);
    });

    it('evaluates 150 VLOOKUP and MATCH formulas against a shared 5,000x2 table without false 413 PayloadLimitError', () => {
      const cellMap: Record<string, string | number> = {};
      for (let r = 1; r <= 5000; r++) {
        cellMap[`D${r}`] = `KEY_${r}`;
        cellMap[`E${r}`] = r * 10;
      }
      const formulas = [];
      for (let i = 1; i <= 150; i++) {
        const targetIdx = ((i * 33) % 5000) + 1;
        cellMap[`A${i}`] = `key_${targetIdx}`;
        formulas.push({
          ref: `B${i}`,
          formula: `=VLOOKUP(A${i}, $D$1:$E$5000, 2, FALSE)`,
          rowIdx: i - 1,
          colIdx: 1,
        });
        formulas.push({
          ref: `C${i}`,
          formula: `=MATCH(A${i}, $D$1:$D$5000, 0)`,
          rowIdx: i - 1,
          colIdx: 2,
        });
      }

      const dag = new SpreadsheetDagEngine(cellMap);
      const { evaluated, cycles } = dag.evaluateWithDag(formulas);
      expect(cycles).toEqual([]);
      expect(evaluated.B1).toBe(340);
      expect(evaluated.C1).toBe(34);
      expect(evaluated.B150).toBe(49510);
      expect(evaluated.C150).toBe(4951);
    });

    it('still fails closed with PayloadLimitError when distinct ranges exceed 250,000 cells', () => {
      const dag = new SpreadsheetDagEngine({ A1: 1 });
      expect(() =>
        dag.evaluateWithDag([
          { ref: 'Z1', formula: '=SUM(A1:A90000)' },
          { ref: 'Z2', formula: '=SUM(B1:B90000)' },
          { ref: 'Z3', formula: '=SUM(C1:C90000)' },
        ]),
      ).toThrow(PayloadLimitError);
    });
  });

  describe('F-04: deadlock-free demosaic tile supervision and concurrent worker leasing', () => {
    it(
      'surfaces an abrupt tile worker process.exit(1) as ConversionFailedError instead of hanging',
      () => {
        const width = 32;
        const height = 32;
        const job = {
          kind: 'amaze',
          width,
          height,
          tile: 16,
          input: { kind: 'direct', samples: new Uint16Array(new SharedArrayBuffer(width * height * 2)) },
          calibration: { black: new Float64Array(4), range: new Float64Array(4).fill(65535) },
          layout: { greenParity: 0, redRowParity: 0 },
          out: {
            width,
            floatOut: new Float32Array(new SharedArrayBuffer(width * height * 12)),
            rgb8: null,
            tables: null,
            wbR: 1,
            wbG: 1,
            wbB: 1,
            matrix: null,
            gamma: false,
            roundToFloat32: false,
          },
          planes: null,
        } as unknown as TileJob;

        const crashingEntry = {
          kind: 'source' as const,
          bootstrap: "require('node:worker_threads').parentPort.on('message', () => { process.exit(1); });",
        };

        expect(() => runTilesOnThreads(job, 2, crashingEntry)).toThrow(ConversionFailedError);
        expect(() => runTilesOnThreads(job, 2, crashingEntry)).toThrow(/tile worker exited unexpectedly/);
      },
      15_000,
    );

    it('recovers cleanly after a crashed job and isolates concurrent multi-thread demosaic runs', async () => {
      const width = 96;
      const height = 96;
      const dataA = new Uint16Array(width * height);
      const dataB = new Uint16Array(width * height);
      for (let i = 0; i < dataA.length; i++) {
        dataA[i] = (i * 257) & 0xffff;
        dataB[i] = ((dataA.length - i) * 193) & 0xffff;
      }
      const sensorA = { width, height, pattern: 'RGGB' as const, data: dataA, bitsPerSample: 16 as const };
      const sensorB = { width, height, pattern: 'BGGR' as const, data: dataB, bitsPerSample: 16 as const };
      const singleA = demosaicAmazeBayerCfa(sensorA, { tileSize: 16, threads: 1 });
      const singleB = demosaicAmazeBayerCfa(sensorB, { tileSize: 16, threads: 1 });
      const [multiA, multiB] = await Promise.all([
        Promise.resolve().then(() => demosaicAmazeBayerCfa(sensorA, { tileSize: 16, threads: 3 })),
        Promise.resolve().then(() => demosaicAmazeBayerCfa(sensorB, { tileSize: 16, threads: 2 })),
      ]);
      expect(Buffer.compare(multiA.data, singleA.data)).toBe(0);
      expect(Buffer.compare(multiB.data, singleB.data)).toBe(0);
    });
  });

  describe('F-12: oversize materialize PayloadLimitError guard and O(1) hasNonWhitespaceBytes', () => {
    it('throws PayloadLimitError instead of RangeError when materializing a sparse file exceeding single-Buffer limit', () => {
      const dir = makeTempDir('f12-oversize-');
      const hugeFile = path.join(dir, 'huge.bin');
      const overTwoGiB = Math.min(bufferConstants.MAX_LENGTH, 0x7fff_ffff) + 4096;
      fs.writeFileSync(hugeFile, '');
      fs.truncateSync(hugeFile, overTwoGiB);

      const lazyResult = createConversionResult(hugeFile, 'bin', 'huge', 'native-ffmpeg', 5);
      expect(() => materializeResultForTest(lazyResult)).toThrow(PayloadLimitError);
      expect(fs.existsSync(hugeFile)).toBe(false);
    });

    it('keeps output on disk without reading into heap when zeroHeap is true with Buffer input', async () => {
      const dir = makeTempDir('f12-zeroheap-');
      const outPath = path.join(dir, 'out.json');
      const res = await dispatchConversion(
        Buffer.from('id,val\n1,alpha\n'),
        'csv',
        'json',
        { zeroHeap: true, outputPath: outPath } as Record<string, unknown>,
        'data.csv',
      );
      expect(res.filePath).toBe(outPath);
      expect(fs.existsSync(outPath)).toBe(true);
    });

    it('detects non-whitespace bytes in O(1) memory while skipping UTF-8 BOM, form feeds, and NBSP', () => {
      expect(hasNonWhitespaceBytes(Buffer.alloc(0))).toBe(false);
      expect(hasNonWhitespaceBytes(Buffer.from('\uFEFF \t\r\n\f\v\u00A0\u3000', 'utf-8'))).toBe(false);
      expect(hasNonWhitespaceBytes(Buffer.from('\uFEFF\f\n  X', 'utf-8'))).toBe(true);
    });
  });

  describe('F-13: edge pure-data formula escaping & YAML bomb cap, pure-canvas fit/BMP bounds, and pure-cad binary STL', () => {
    it('escapes spreadsheet formula triggers when converting JSON to CSV/TSV in pure-data', () => {
      const payload = JSON.stringify([
        { name: "=CMD|'/C calc'!A0", amount: '+SUM(A1:A2)', note: '\t=1+1', safe: 'normal' },
      ]);
      const csv = convertPureData(payload, 'json', 'csv');
      expect(csv.text).toBe(
        'name,amount,note,safe\r\n"\'=CMD|\'/C calc\'!A0","\'+SUM(A1:A2)","\'\t=1+1",normal',
      );
      const unescaped = convertPureData(payload, 'json', 'csv', { escapeFormulas: false });
      expect(unescaped.text).toBe(
        "name,amount,note,safe\r\n=CMD|'/C calc'!A0,+SUM(A1:A2),\t=1+1,normal",
      );
    });

    it('fails closed on YAML billion-laughs alias expansion bombs in pure-data', () => {
      const bomb = [
        'a0: &a0 [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]',
        'a1: &a1 [*a0, *a0, *a0, *a0, *a0, *a0, *a0, *a0, *a0, *a0]',
        'a2: &a2 [*a1, *a1, *a1, *a1, *a1, *a1, *a1, *a1, *a1, *a1]',
        'a3: &a3 [*a2, *a2, *a2, *a2, *a2, *a2, *a2, *a2, *a2, *a2]',
        'a4: &a4 [*a3, *a3, *a3, *a3, *a3, *a3, *a3, *a3, *a3, *a3]',
        'a5: &a5 [*a4, *a4, *a4, *a4, *a4, *a4, *a4, *a4, *a4, *a4]',
        'a6: &a6 [*a5, *a5, *a5, *a5, *a5, *a5, *a5, *a5, *a5, *a5]',
      ].join('\n');
      expect(() => convertPureData(bomb, 'yaml', 'json')).toThrow(/YAML parsing failed.*alias/i);
    });

    it('computes sharp-equivalent fit: "outside" and fit: "inside" dimensions in pure-canvas and bounds BMP input', async () => {
      const origCreateImageBitmap = globalThis.createImageBitmap;
      const origOffscreenCanvas = globalThis.OffscreenCanvas;
      try {
        globalThis.createImageBitmap = (async () => ({
          width: 400,
          height: 200,
          close: () => undefined,
        })) as unknown as typeof createImageBitmap;
        globalThis.OffscreenCanvas = class {
          width: number;
          height: number;
          constructor(w: number, h: number) {
            this.width = w;
            this.height = h;
          }
          getContext() {
            return {
              fillStyle: '#FFFFFF',
              imageSmoothingEnabled: true,
              imageSmoothingQuality: 'high',
              fillRect: () => undefined,
              drawImage: () => undefined,
              getImageData: (_x: number, _y: number, w: number, h: number) => ({
                width: w,
                height: h,
                data: new Uint8ClampedArray(w * h * 4),
              }),
            };
          }
        } as unknown as typeof OffscreenCanvas;

        // 400x200 into 100x100 with fit: 'outside' -> scale = max(100/400, 100/200) = 0.5 -> 200x100
        const outside = await convertPureCanvas(new Uint8Array([1, 2, 3]), 'png', 'bmp', {
          width: 100,
          height: 100,
          fit: 'outside',
        });
        expect(outside.width).toBe(200);
        expect(outside.height).toBe(100);

        // 400x200 into 100x100 with fit: 'inside' -> scale = min(100/400, 100/200) = 0.25 -> 100x50
        const inside = await convertPureCanvas(new Uint8Array([1, 2, 3]), 'png', 'bmp', {
          width: 100,
          height: 100,
          fit: 'inside',
        });
        expect(inside.width).toBe(100);
        expect(inside.height).toBe(50);
      } finally {
        globalThis.createImageBitmap = origCreateImageBitmap;
        globalThis.OffscreenCanvas = origOffscreenCanvas;
      }

      // Non-integer dimensions, >32768 dimensions, and truncated pixel buffer must fail closed
      expect(() =>
        encodeBmpFromImageData({ width: 2.5, height: 2, data: new Uint8Array(32) }),
      ).toThrow(/Invalid image dimensions/);
      expect(() =>
        encodeBmpFromImageData({ width: 40000, height: 10, data: new Uint8Array(40000 * 10 * 4) }),
      ).toThrow(/Invalid image dimensions/);
      expect(() =>
        encodeBmpFromImageData({ width: 4, height: 4, data: new Uint8Array(16) }),
      ).toThrow(/Invalid image dimensions|pixel data/);
    });

    it('encodes exact 84+50N byte binary STL facets while keeping ASCII encodeStl unchanged', () => {
      const mesh: TessellatedMesh = {
        name: 'tri',
        vertices: [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
        ],
        normals: [],
        faces: [[0, 1, 2]],
      };
      const ascii = encodeStl(mesh);
      expect(ascii.startsWith('solid tri\n  facet normal 0 0 1\n')).toBe(true);

      const bin = encodeBinaryStl(mesh);
      expect(bin.byteLength).toBe(134);
      const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
      expect(view.getUint32(80, true)).toBe(1);
      // Normal (0, 0, 1)
      expect(view.getFloat32(84, true)).toBe(0);
      expect(view.getFloat32(88, true)).toBe(0);
      expect(view.getFloat32(92, true)).toBe(1);
      // v2 = (1, 0, 0) at offset 84 + 24 = 108
      expect(view.getFloat32(108, true)).toBe(1);
      expect(view.getUint16(132, true)).toBe(0);
    });
  });

  describe('F-25: OCR pool single-waiter FIFO wake with abort cascade, async LibreOffice reset, and binary TTL cache', () => {
    it('wakes only one FIFO waiter per released worker and cascades when the woken waiter aborts', async () => {
      const spec: OcrWorkerSpec = {
        langs: 'eng',
        langPath: '/tessdata',
        gzip: false,
        engineMode: 1,
        parameters: { tessedit_pageseg_mode: '3' },
      };
      let takeIdleAttempts = 0;

      class CountingPool extends OcrWorkerPool {
        override async createWorker(_s: OcrWorkerSpec, _h: OcrWorkerHealth): Promise<OcrPooledWorker> {
          return {
            setParameters: async () => undefined,
            recognize: async () => ({ data: { text: 'ok' } }) as never,
            terminate: async () => undefined,
          };
        }
      }

      const pool = new CountingPool({ maxWorkersPerKey: 1, maxWorkersTotal: 1 });
      const origTakeIdle = (pool as unknown as { takeIdle: (k: string) => unknown }).takeIdle.bind(pool);
      (pool as unknown as { takeIdle: (k: string) => unknown }).takeIdle = (k: string) => {
        takeIdleAttempts++;
        return origTakeIdle(k);
      };

      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((r) => {
        releaseFirst = r;
      });

      const job1 = pool.run(spec, async () => {
        await firstGate;
        return 'j1';
      });
      // Let job1 acquire the single worker
      await new Promise((r) => setTimeout(r, 20));

      const abort2 = new AbortController();
      const order: string[] = [];
      const job2 = pool.run(
        spec,
        async () => {
          order.push('j2');
          return 'j2';
        },
        abort2.signal,
      );
      const job3 = pool.run(spec, async () => {
        order.push('j3');
        return 'j3';
      });
      const job4 = pool.run(spec, async () => {
        order.push('j4');
        return 'j4';
      });
      await new Promise((r) => setTimeout(r, 20));
      const baselineAttempts = takeIdleAttempts;

      // Abort job2 right before releasing job1; releasing 1 worker must wake job3 ONLY (not job3+job4 together)
      abort2.abort(new Error('cancelled-j2'));
      await expect(job2).rejects.toThrow('cancelled-j2');

      releaseFirst();
      const [r1, r3, r4] = await Promise.all([job1, job3, job4]);
      expect([r1, r3, r4]).toEqual(['j1', 'j3', 'j4']);
      expect(order).toEqual(['j3', 'j4']);
      // With FIFO single-waiter wake, job3 takes the idle worker (1 takeIdle call) and job4 takes it next (1 takeIdle call) = 2 total,
      // whereas Thundering Herd woke BOTH job3 and job4 on job1's release (>= 3 takeIdle calls).
      expect(takeIdleAttempts - baselineAttempts).toBe(2);
      await pool.shutdown();
    });

    it('resets LibreOffice slot profile asynchronously and caches resolved native binary paths by env', async () => {
      const dir = makeTempDir('f25-bin-');
      const fakeBin = writeStubExecutable(dir, 'soffice', 'exit 0');
      const prev = process.env.SOFFICE_PATH;
      try {
        process.env.SOFFICE_PATH = fakeBin;
        expect(resolveNativeBinary('soffice')).toBe(fakeBin);
        expect(resolveNativeBinary('soffice')).toBe(fakeBin);

        process.env.SOFFICE_PATH = path.join(dir, 'missing-soffice');
        expect(resolveNativeBinary('soffice')).toBeNull();
      } finally {
        if (prev === undefined) delete process.env.SOFFICE_PATH;
        else process.env.SOFFICE_PATH = prev;
      }

      const executor: SandboxedProcessRunner = async (_bin, args, options) => {
        if (args.includes('--convert-to') && options?.cwd) {
          await fs.promises.writeFile(path.join(options.cwd, 'input.pdf'), '%PDF-1.7 ok');
        }
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          exitCode: 0,
          durationMs: 1,
          sandboxed: true,
          sandboxType: 'host',
        };
      };
      const loPool = new LibreOfficePoolManager({
        maxWorkers: 1,
        minWorkers: 0,
        sofficePath: fakeBin,
        enabled: true,
        executor,
        readinessProbe: false,
      });
      try {
        const out = await loPool.convert(Buffer.from('hello'), 'docx', 'pdf', { timeoutMs: 5000 }, 'hello.docx');
        expect(out?.mimeType).toBe('application/pdf');
        if (out?.filePath) fs.rmSync(out.filePath, { force: true });
      } finally {
        await loPool.shutdown();
      }
    });
  });
});
