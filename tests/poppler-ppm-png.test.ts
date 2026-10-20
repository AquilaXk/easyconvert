import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { ConversionFailedError, InvalidPageRangeError, UnsupportedOptionError } from '../src/lib/types';
import { PdfStructureError } from '../src/lib/conversions/pdf-document';
import {
  exceedsPpmPageLimit,
  PAGE_RENDER_MAX_PROCESSES,
  pageRenderProcesses,
  parsePpmHeader,
  PPM_PAGE_MAX_BYTES,
  DIRECT_RENDER_BATCH_PAGES,
  ppmBatchPages,
  renderPngBatch,
  runBounded,
  splitIntoBatches,
} from '../src/worker/poppler-ppm';
import { requireOracleTool } from './helpers/differential-oracle';
import { decodeRgba } from './helpers/imagemagick';
import { oracleTest } from './helpers/oracle-test';

/**
 * PNG pages from Poppler are written by the worker's encoder from PPM pages, because Poppler's own PNG writer costs more
 * than the rendering. The pixels, the size and the pixel density must be exactly what `pdftoppm -png` writes: the
 * oracle is the real `pdftoppm -png` of the same PDF, decoded by ImageMagick (which shares no code with the encoder).
 */

const NATIVE_TIMEOUT_MS = 120_000;
const DPI = 150;
const PNG_SIGNATURE_BYTES = 8;
const PNG_PHYS = 'pHYs';

async function drawing(pageSizes: Array<[number, number]>): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  pageSizes.forEach(([width, height], index) => {
    const page = doc.addPage([width, height]);
    page.drawRectangle({ x: 10, y: 10, width: width / 2, height: height / 3, color: rgb(0.84, 0.15, 0.16) });
    page.drawCircle({ x: width * 0.6, y: height * 0.6, size: Math.min(width, height) / 5, color: rgb(0.12, 0.47, 0.71), borderColor: rgb(0, 0, 0), borderWidth: 2 });
    page.drawText(`Page ${index + 1} of the drawing`, { x: 14, y: height - 30, size: 14, font });
  });
  return Buffer.from(await doc.save());
}

/** PNG chunks as [type, data] in file order. */
function chunks(png: Buffer): Array<[string, Buffer]> {
  const found: Array<[string, Buffer]> = [];
  let at = PNG_SIGNATURE_BYTES;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    found.push([png.toString('latin1', at + 4, at + 8), png.subarray(at + 8, at + 8 + length)]);
    at += 12 + length;
  }
  return found;
}

/** Chunks whose stored CRC-32 is not that of their type and data, read with zlib's routine. */
function badChecksums(png: Buffer): string[] {
  const bad: string[] = [];
  let at = PNG_SIGNATURE_BYTES;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const stored = png.readUInt32BE(at + 8 + length);
    if (zlib.crc32(png.subarray(at + 4, at + 8 + length)) !== stored) bad.push(png.toString('latin1', at + 4, at + 8));
    at += 12 + length;
  }
  return bad;
}

function ihdr(png: Buffer): { width: number; height: number; depth: number; colourType: number } {
  const data = chunks(png)[0][1];
  return { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colourType: data[9] };
}

function referencePages(pdf: Buffer, dpi: number): Buffer[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppm-ref-'));
  try {
    fs.writeFileSync(path.join(dir, 'in.pdf'), pdf);
    execFileSync(requireOracleTool('pdftoppm'), ['-r', String(dpi), '-png', path.join(dir, 'in.pdf'), path.join(dir, 'page')]);
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.png'))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .map((name) => fs.readFileSync(path.join(dir, name)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs `run` with `PDFTOPPM_PATH` naming a script made of `body` (its directory is passed to `run`); the script and the variable are removed afterwards. */
async function withShimScript<T>(body: string[], run: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdftoppm-shim-'));
  const previous = process.env.PDFTOPPM_PATH;
  try {
    const shim = path.join(dir, 'pdftoppm');
    fs.writeFileSync(shim, ['#!/bin/sh', ...body, ''].join('\n'), { mode: 0o755 });
    process.env.PDFTOPPM_PATH = shim;
    return await run(dir);
  } finally {
    if (previous === undefined) delete process.env.PDFTOPPM_PATH;
    else process.env.PDFTOPPM_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A stand-in for pdftoppm that records its arguments and then runs the real one, or does what `onRaw` says for a PPM request. */
async function withPdftoppmShim<T>(onRaw: string, run: (calls: () => string[][]) => Promise<T>): Promise<T> {
  const real = requireOracleTool('pdftoppm');
  return withShimScript(
    ['echo "$*" >> "$(dirname "$0")/calls.log"', 'case " $* " in', `  *" -png "*) exec '${real}' "$@" ;;`, 'esac', onRaw],
    (dir) => {
      const log = path.join(dir, 'calls.log');
      return run(() => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => line.split(' ')) : []));
    }
  );
}

/**
 * A stand-in for pdftoppm that runs the real one after a pause and records how many runs are alive when each one starts, so that
 * the most it ever ran at once can be read. `run` gets that count and the arguments of every run.
 */
async function withOverlapShim<T>(run: (observed: () => { mostAtOnce: number; calls: string[][] }) => Promise<T>): Promise<T> {
  const real = requireOracleTool('pdftoppm');
  const PAUSE_SECONDS = 0.4;
  return withShimScript(
    [
      'here="$(dirname "$0")"',
      'mkdir -p "$here/alive"',
      'echo "$*" >> "$here/calls.log"',
      'touch "$here/alive/$$"',
      'ls "$here/alive" | wc -l | tr -d " " >> "$here/alive.log"',
      `sleep ${PAUSE_SECONDS}`,
      `'${real}' "$@"`,
      'status=$?',
      'rm -f "$here/alive/$$"',
      'exit $status',
    ],
    (dir) =>
      run(() => {
        const lines = (file: string): string[] => fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n');
        return { mostAtOnce: Math.max(...lines('alive.log').map(Number)), calls: lines('calls.log').map((line) => line.split(' ')) };
      })
  );
}

const realPdftoppm = (): string => `exec '${requireOracleTool('pdftoppm')}' "$@"`;

describe('PPM header', () => {
  it('reads the size of a binary PPM with comments between the fields', () => {
    const page = parsePpmHeader(Buffer.from('P6\n# a comment\n834 625\n255\n\xff\xff', 'latin1'));
    expect(page).toEqual({ width: 834, height: 625, dataOffset: 27 });
  });

  it.each([
    ['text PPM (P3)', 'P3\n2 2\n255\n'],
    ['16-bit samples', 'P6\n2 2\n65535\n'],
    ['zero width', 'P6\n0 2\n255\n'],
    ['no size', 'P6\n'],
    ['not a number', 'P6\nwide tall\n255\n'],
    ['header not closed', 'P6\n2 2\n255'],
  ])('refuses %s', (_name, head) => {
    expect(() => parsePpmHeader(Buffer.from(head, 'latin1'))).toThrow(ConversionFailedError);
  });
});

describe('batching', () => {
  it('splits an interval into consecutive batches', () => {
    expect(splitIntoBatches(3, 9, 3)).toEqual([
      { start: 3, end: 5 },
      { start: 6, end: 8 },
      { start: 9, end: 9 },
    ]);
  });

  it('keeps the raw pages of a batch to about 48 MiB, one page at a time at high resolutions', () => {
    expect(ppmBatchPages(72)).toBe(8);
    expect(ppmBatchPages(150)).toBe(7);
    expect(ppmBatchPages(300)).toBe(1);
    expect(ppmBatchPages(600)).toBe(1);
  });

  it('limits one raw page to 128 MiB', () => {
    expect(exceedsPpmPageLimit(PPM_PAGE_MAX_BYTES)).toBe(false);
    expect(exceedsPpmPageLimit(PPM_PAGE_MAX_BYTES + 1)).toBe(true);
  });
});

describe('PDF pages as PNG through PPM', () => {
  oracleTest('a page is the pixels, the size, the layout and the density of `pdftoppm -png`', ['pdftoppm', 'identify'], async () => {
    const pdf = await drawing([[300, 200]]);
    await withPdftoppmShim(realPdftoppm(), async (calls) => {
      const result = await dispatchConversion(pdf, 'pdf', 'png', { dpi: DPI }, 'drawing.pdf');
      const [reference] = referencePages(pdf, DPI);
      expect(ihdr(result.buffer)).toEqual(ihdr(reference));
      const phys = (png: Buffer) => chunks(png).find(([type]) => type === PNG_PHYS)?.[1];
      // The same chunks in the same order, one density chunk and no colour profile, and the chunk checksums hold.
      const layout = (png: Buffer) => chunks(png).map(([type]) => type).filter((type, index, all) => type !== 'IDAT' || all[index - 1] !== 'IDAT');
      expect(layout(result.buffer)).toEqual(layout(reference));
      expect(chunks(result.buffer).filter(([type]) => type === PNG_PHYS)).toHaveLength(1);
      expect(badChecksums(result.buffer)).toEqual([]);
      expect(phys(result.buffer)).toBeDefined();
      expect(phys(result.buffer)?.equals(phys(reference) as Buffer)).toBe(true);
      const ours = decodeRgba(result.buffer, 'png');
      const theirs = decodeRgba(reference, 'png');
      expect(ours.width).toBe(theirs.width);
      expect(ours.height).toBe(theirs.height);
      expect(ours.data.equals(theirs.data)).toBe(true);
      const render = calls().find((call) => call.includes('-f'));
      expect(render).toBeDefined();
      expect(render).not.toContain('-png');
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('several pages come back as the ZIP of pages, each identical to the reference page', ['pdftoppm', 'identify'], async () => {
    const pdf = await drawing([
      [300, 200],
      [200, 300],
      [250, 250],
    ]);
    await withPdftoppmShim(realPdftoppm(), async () => {
      const result = await dispatchConversion(pdf, 'pdf', 'png', { dpi: DPI }, 'drawing.pdf');
      const zip = await JSZip.loadAsync(result.buffer);
      const names = Object.keys(zip.files).sort();
      expect(names).toEqual(['drawing-p001.png', 'drawing-p002.png', 'drawing-p003.png']);
      const references = referencePages(pdf, DPI);
      expect(references).toHaveLength(3);
      for (const [index, name] of names.entries()) {
        const page = await (zip.file(name) as JSZip.JSZipObject).async('nodebuffer');
        expect(decodeRgba(page, 'png').data.equals(decodeRgba(references[index], 'png').data)).toBe(true);
      }
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('a page selection renders only those pages', ['pdftoppm', 'identify'], async () => {
    const pdf = await drawing([
      [300, 200],
      [200, 300],
      [250, 250],
    ]);
    await withPdftoppmShim(realPdftoppm(), async () => {
      const result = await dispatchConversion(pdf, 'pdf', 'png', { dpi: DPI, page: 2 }, 'drawing.pdf');
      const reference = referencePages(pdf, DPI)[1];
      expect(decodeRgba(result.buffer, 'png').data.equals(decodeRgba(reference, 'png').data)).toBe(true);
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('a page over the raw-size limit is drawn again by Poppler as a PNG', ['pdftoppm', 'identify'], async () => {
    const pdf = await drawing([[200, 150]]);
    // The stand-in reports what the process limit reports for a file above the limit: it is stopped by SIGXFSZ.
    await withPdftoppmShim('kill -XFSZ $$', async (calls) => {
      const result = await dispatchConversion(pdf, 'pdf', 'png', { dpi: DPI }, 'drawing.pdf');
      const reference = referencePages(pdf, DPI)[0];
      expect(decodeRgba(result.buffer, 'png').data.equals(decodeRgba(reference, 'png').data)).toBe(true);
      const renders = calls().filter((call) => call.includes('-f'));
      expect(renders).toHaveLength(2);
      expect(renders[0]).not.toContain('-png');
      expect(renders[1]).toContain('-png');
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('nine pages at 72 dpi render as pages 1 to 8 (the early batch) and page 9 alone', ['pdftoppm', 'identify'], async () => {
    const pdf = await drawing(Array.from({ length: 9 }, (_unused, index): [number, number] => [100 + index * 4, 80]));
    await withPdftoppmShim(realPdftoppm(), async (calls) => {
      const result = await dispatchConversion(pdf, 'pdf', 'png', { dpi: 72 }, 'nine.pdf');
      const zip = await JSZip.loadAsync(result.buffer);
      expect(Object.keys(zip.files)).toHaveLength(9);
      const ranges = calls().map((call) => `${call[call.indexOf('-f') + 1]}-${call[call.indexOf('-l') + 1]}`);
      // The two batches run side by side, so the order they start in is not the order of the pages.
      expect([...ranges].sort()).toEqual(['1-8', '9-9']);
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('a page file that is not a binary PPM is a typed error, never a guessed picture', ['pdftoppm'], async () => {
    const pdf = await drawing([[200, 150]]);
    await withPdftoppmShim('for last; do :; done; printf "P3\\n1 1\\n255\\n0 0 0\\n" > "$last-1.ppm"', async () => {
      const run = dispatchConversion(pdf, 'pdf', 'png', { dpi: DPI }, 'drawing.pdf');
      await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
      await expect(run).rejects.toThrow(/not a binary PPM/);
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('the page count is read while the first pages render, and its failures are still the ones reported', ['pdftoppm', 'pdfinfo'], async () => {
    const pdf = await drawing([[200, 150]]);
    await withPdftoppmShim(realPdftoppm(), async (calls) => {
      const ranges = () => calls().map((call) => call.slice(call.indexOf('-f'), call.indexOf('-l') + 2).join(' '));
      // A damaged document: pdfinfo cannot count it, whatever the early render did.
      await expect(dispatchConversion(pdf.subarray(0, 120), 'pdf', 'png', { dpi: DPI }, 'damaged.pdf')).rejects.toBeInstanceOf(PdfStructureError);
      // The early batch was started (and awaited) before the count failed: exactly one run, of the first batch.
      expect(ranges()).toEqual([`-f 1 -l ${ppmBatchPages(DPI)}`]);
      // A page that is not in the document, and a resolution out of range, are the client's; neither starts a render.
      await expect(dispatchConversion(pdf, 'pdf', 'png', { dpi: DPI, page: 9 }, 'drawing.pdf')).rejects.toThrow(new InvalidPageRangeError('Page number 9 is out of bounds (1-1)'));
      await expect(dispatchConversion(pdf, 'pdf', 'png', { dpi: 5000 }, 'drawing.pdf')).rejects.toBeInstanceOf(UnsupportedOptionError);
      expect(ranges()).toEqual([`-f 1 -l ${ppmBatchPages(DPI)}`]);
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('a document of more pages than one batch renders every page, in order', ['pdftoppm', 'identify'], async () => {
    const pdf = await drawing(Array.from({ length: 12 }, (_unused, index): [number, number] => [200 + index * 4, 120]));
    await withPdftoppmShim(realPdftoppm(), async (calls) => {
      const result = await dispatchConversion(pdf, 'pdf', 'png', { dpi: DPI }, 'many.pdf');
      const zip = await JSZip.loadAsync(result.buffer);
      const names = Object.keys(zip.files).sort();
      expect(names).toHaveLength(12);
      const references = referencePages(pdf, DPI);
      for (const [index, name] of names.entries()) {
        const page = await (zip.file(name) as JSZip.JSZipObject).async('nodebuffer');
        expect(decodeRgba(page, 'png').data.equals(decodeRgba(references[index], 'png').data)).toBe(true);
      }
      // The first batch starts with the page count (the processes log in the order they start, which is not fixed); the pages after it follow in batches.
      const batches = calls().map((call) => call.slice(call.indexOf('-f'), call.indexOf('-l') + 2).join(' '));
      expect(batches).toContain(`-f 1 -l ${ppmBatchPages(DPI)}`);
      expect(batches.length).toBeGreaterThan(1);
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('JPEG pages are still written by Poppler', ['pdftoppm'], async () => {
    const pdf = await drawing([[200, 150]]);
    await withPdftoppmShim(realPdftoppm(), async (calls) => {
      const result = await dispatchConversion(pdf, 'pdf', 'jpg', { dpi: DPI }, 'drawing.pdf');
      expect(result.buffer.subarray(0, 2).toString('hex')).toBe('ffd8');
      expect(calls().some((call) => call.includes('-jpeg'))).toBe(true);
    });
  }, NATIVE_TIMEOUT_MS);
});

describe('how many pages are drawn at once', () => {
  it('is the cores this process may use, at most four, never fewer than one', () => {
    expect([0, 1, 2, 3, 4, 8, 64].map((cores) => pageRenderProcesses(cores))).toEqual([1, 1, 2, 3, 4, 4, 4]);
    expect(PAGE_RENDER_MAX_PROCESSES).toBe(4);
  });
});

describe('runBounded', () => {
  const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

  /** Tasks that record how many are running when each starts and ends, and the order they started in. */
  function trackedTasks(count: number, run: (index: number) => Promise<void> = () => pause(5)) {
    const state = { alive: 0, mostAtOnce: 0, started: [] as number[], finished: [] as number[] };
    const tasks = Array.from({ length: count }, (_unused, index) => async () => {
      state.started.push(index);
      state.alive += 1;
      state.mostAtOnce = Math.max(state.mostAtOnce, state.alive);
      try {
        await run(index);
      } finally {
        state.alive -= 1;
        state.finished.push(index);
      }
    });
    return { state, tasks };
  }

  it('runs every task, in the order given, with at most `limit` at once', async () => {
    const { state, tasks } = trackedTasks(10);
    await runBounded(tasks, 3);
    expect(state.mostAtOnce).toBe(3);
    expect(state.started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect([...state.finished].sort((a, b) => a - b)).toEqual(state.started);
  });

  it('runs one task at a time with a limit of one', async () => {
    const { state, tasks } = trackedTasks(4);
    await runBounded(tasks, 1);
    expect(state.mostAtOnce).toBe(1);
    expect(state.finished).toEqual([0, 1, 2, 3]);
  });

  it('counts a run that is already under way as one of the places', async () => {
    const { state, tasks } = trackedTasks(6, () => pause(30));
    let release: () => void = () => undefined;
    const underWay = new Promise<void>((resolve) => (release = resolve));
    const all = runBounded(tasks, 2, underWay);
    await pause(45);
    // One place is held by the run under way, so one task at a time until it ends.
    expect(state.mostAtOnce).toBe(1);
    expect(state.finished.length).toBeGreaterThan(0);
    release();
    await all;
    expect(state.finished).toHaveLength(6);
    expect(state.mostAtOnce).toBe(2);
  });

  it('starts nothing more after a failure, waits for the tasks in flight, and reports the first failure', async () => {
    const { state, tasks } = trackedTasks(8, async (index) => {
      await pause(index === 1 ? 5 : 40);
      if (index === 1) throw new Error('page 1 failed');
    });
    await expect(runBounded(tasks, 3)).rejects.toThrow('page 1 failed');
    // Nothing is left running when the call returns, and the tasks that had not started never did.
    expect(state.alive).toBe(0);
    expect(state.started.length).toBeLessThan(8);
    expect(state.started).not.toContain(7);
  });

  it('reports the failure of a run under way before any task starts', async () => {
    const { state, tasks } = trackedTasks(3);
    await expect(runBounded(tasks, 2, Promise.reject(new Error('early run failed')))).rejects.toThrow('early run failed');
    expect(state.alive).toBe(0);
  });
});

describe('PPM pages of a batch', () => {
  oracleTest('a batch encodes only its own pages, and leaves the raw pages another batch is drawing alone', ['pdftoppm'], async () => {
    const pdf = await drawing([[100, 80], [100, 80]]);
    const real = requireOracleTool('pdftoppm');
    await withShimScript([`exec '${real}' "$@"`], async (dir) => {
      const work = fs.mkdtempSync(path.join(dir, 'work-'));
      // A page of a batch that is still being drawn: it is no complete PPM, and the batch below must not touch it.
      const foreign = path.join(work, 'page-09.ppm');
      fs.writeFileSync(foreign, 'P6\n1000 1000\n255\npartial');
      const input = path.join(work, 'in.pdf');
      fs.writeFileSync(input, pdf);
      const sandbox = { cwd: work, timeoutMs: 60_000, maxBuffer: 1 << 20, networkIsolated: true };
      const args = ['-r', '72', '-png', '-f', '1', '-l', '2', input, path.join(work, 'page')];
      await renderPngBatch(process.env.PDFTOPPM_PATH as string, work, 72, sandbox, args, { start: 1, end: 2 });
      expect(fs.readdirSync(work).filter((name) => name.endsWith('.png')).sort()).toEqual(['page-1.png', 'page-2.png']);
      expect(fs.readFileSync(foreign, 'latin1')).toBe('P6\n1000 1000\n255\npartial');
    });
  }, NATIVE_TIMEOUT_MS);
});

describe('pages drawn side by side', () => {
  const PAGES = 40;
  const LOW_DPI = 72;
  const batches = Math.ceil(PAGES / ppmBatchPages(LOW_DPI));
  const document = () => drawing(Array.from({ length: PAGES }, (_unused, index): [number, number] => [120 + (index % 7) * 6, 90 + (index % 5) * 4]));

  oracleTest('PNG pages of a long document are drawn by several processes at once, and every page is the reference page in its place', ['pdftoppm', 'identify'], async () => {
    const pdf = await document();
    await withOverlapShim(async (observed) => {
      const result = await dispatchConversion(pdf, 'pdf', 'png', { dpi: LOW_DPI }, 'long.pdf');
      const zip = await JSZip.loadAsync(result.buffer);
      const names = Object.keys(zip.files).sort();
      expect(names).toHaveLength(PAGES);
      const references = referencePages(pdf, LOW_DPI);
      for (const [index, name] of names.entries()) {
        const page = await (zip.file(name) as JSZip.JSZipObject).async('nodebuffer');
        expect({ name, same: decodeRgba(page, 'png').data.equals(decodeRgba(references[index], 'png').data) }).toEqual({ name, same: true });
      }
      const { mostAtOnce, calls } = observed();
      expect(mostAtOnce).toBe(Math.min(pageRenderProcesses(), batches));
      // Every page is drawn once: the batches tile pages 1 to 40.
      const drawn = calls.flatMap((call) => {
        const first = Number(call[call.indexOf('-f') + 1]);
        const last = Number(call[call.indexOf('-l') + 1]);
        return Array.from({ length: last - first + 1 }, (_unused, offset) => first + offset);
      });
      expect(drawn.sort((a, b) => a - b)).toEqual(Array.from({ length: PAGES }, (_unused, index) => index + 1));
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('JPEG pages of a long document are drawn by several processes at once, and are the bytes `pdftoppm -jpeg` writes', ['pdftoppm'], async () => {
    const pdf = await document();
    await withOverlapShim(async (observed) => {
      const result = await dispatchConversion(pdf, 'pdf', 'jpg', { dpi: LOW_DPI }, 'long.pdf');
      const zip = await JSZip.loadAsync(result.buffer);
      const names = Object.keys(zip.files).sort();
      expect(names).toHaveLength(PAGES);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpeg-ref-'));
      try {
        fs.writeFileSync(path.join(dir, 'in.pdf'), pdf);
        execFileSync(requireOracleTool('pdftoppm'), ['-r', String(LOW_DPI), '-jpeg', path.join(dir, 'in.pdf'), path.join(dir, 'page')]);
        const references = fs.readdirSync(dir).filter((name) => name.endsWith('.jpg')).sort();
        expect(references).toHaveLength(PAGES);
        for (const [index, name] of names.entries()) {
          const page = await (zip.file(name) as JSZip.JSZipObject).async('nodebuffer');
          expect({ name, same: page.equals(fs.readFileSync(path.join(dir, references[index]))) }).toEqual({ name, same: true });
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      expect(observed().mostAtOnce).toBe(Math.min(pageRenderProcesses(), Math.ceil(PAGES / DIRECT_RENDER_BATCH_PAGES)));
    });
  }, NATIVE_TIMEOUT_MS);
});
