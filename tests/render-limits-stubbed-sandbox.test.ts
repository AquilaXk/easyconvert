import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PPM_PAGE_MAX_BYTES, renderPngBatch } from '../src/worker/poppler-ppm';
import { convertWithNativeSvg } from '../src/worker/engines';
import { SandboxedBufferLimitError, type SandboxedExecutionOptions } from '../src/worker/sandbox';

/**
 * The limits of the page and SVG routes, driven with a stand-in for the sandboxed process runner so that each branch is
 * reached on every platform: a host without `prlimit` never stops a program at the file-size limit, and one with it
 * never lets a file grow past the limit, so the two ways a page can be too large cannot both be produced by a real run.
 */

const { run, launch } = vi.hoisted(() => ({ run: vi.fn(), launch: vi.fn() }));
vi.mock('../src/worker/sandbox', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/worker/sandbox')>()), executeSandboxedBinary: run }));
vi.mock('../src/lib/security/sandbox-launcher', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/lib/security/sandbox-launcher')>()), launchSandboxedBinary: launch }));

const PNG_MARK = 'png written by the stand-in for Poppler';
const SANDBOX: SandboxedExecutionOptions = { timeoutMs: 1000 };
const DPI = 72;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const SVG_OUTPUT_LIMIT = 512 * 1024 * 1024;

let dir: string;
beforeEach(() => {
  run.mockReset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-limits-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const asksForPng = (args: readonly string[]): boolean => args.includes('-png');

/** A 2 x 1 binary PPM page. */
const smallPage = (): Buffer => Buffer.concat([Buffer.from('P6\n2 1\n255\n', 'latin1'), Buffer.from([255, 0, 0, 0, 0, 255])]);

describe('a page too large to hold in memory is drawn again by Poppler as a PNG', () => {
  it('when the page file grew past the limit without the process being stopped (a host without prlimit)', async () => {
    run.mockImplementation(async (_binary: string, args: string[]) => {
      if (asksForPng(args)) fs.writeFileSync(path.join(dir, 'page-1.png'), PNG_MARK);
      else {
        fs.writeFileSync(path.join(dir, 'page-1.ppm'), '');
        fs.truncateSync(path.join(dir, 'page-1.ppm'), PPM_PAGE_MAX_BYTES + 1);
      }
      return { stdout: Buffer.alloc(0) };
    });
    await renderPngBatch('pdftoppm', dir, DPI, SANDBOX, ['-r', '72', '-png', 'in.pdf', 'page']);
    expect(run.mock.calls.map(([, args]) => asksForPng(args as string[]))).toEqual([false, true]);
    expect(fs.readdirSync(dir).sort()).toEqual(['page-1.png']);
    expect(fs.readFileSync(path.join(dir, 'page-1.png'), 'utf8')).toBe(PNG_MARK);
  });

  it('when the process was stopped at the file-size limit', async () => {
    run.mockImplementation(async (_binary: string, args: string[]) => {
      if (asksForPng(args)) {
        fs.writeFileSync(path.join(dir, 'page-1.png'), PNG_MARK);
        return { stdout: Buffer.alloc(0) };
      }
      fs.writeFileSync(path.join(dir, 'page-1.ppm'), 'cut off');
      throw new SandboxedBufferLimitError(PPM_PAGE_MAX_BYTES);
    });
    await renderPngBatch('pdftoppm', dir, DPI, SANDBOX, ['-r', '72', '-png', 'in.pdf', 'page']);
    expect(run.mock.calls.map(([, args]) => asksForPng(args as string[]))).toEqual([false, true]);
    expect(fs.readdirSync(dir)).toEqual(['page-1.png']);
  });

  it('and a page within the limit is compressed in process, with one program run', async () => {
    run.mockImplementation(async () => {
      fs.writeFileSync(path.join(dir, 'page-1.ppm'), smallPage());
      return { stdout: Buffer.alloc(0) };
    });
    await renderPngBatch('pdftoppm', dir, DPI, SANDBOX, ['-r', '72', '-png', 'in.pdf', 'page']);
    expect(run).toHaveBeenCalledTimes(1);
    expect(asksForPng(run.mock.calls[0][1] as string[])).toBe(false);
    expect(run.mock.calls[0][2]).toMatchObject({ maxFileSize: PPM_PAGE_MAX_BYTES });
    expect(fs.readdirSync(dir)).toEqual(['page-1.png']);
    expect(fs.readFileSync(path.join(dir, 'page-1.png')).subarray(0, 4).equals(PNG_SIGNATURE)).toBe(true);
  });
});

describe('the SVG renderer output limit', () => {
  const previous = process.env.RSVG_CONVERT_PATH;
  beforeEach(() => {
    process.env.RSVG_CONVERT_PATH = process.execPath;
    launch.mockReset();
    launch.mockResolvedValue({ stdout: Buffer.from('%PDF-1.4 stand-in') });
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.RSVG_CONVERT_PATH;
    else process.env.RSVG_CONVERT_PATH = previous;
  });

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
  const limitFor = async (maxBufferBytes?: number): Promise<number> => {
    await convertWithNativeSvg(svg, 'svg', 'pdf', maxBufferBytes === undefined ? {} : { maxBufferBytes }, 'a.svg');
    return (launch.mock.calls.at(-1)?.[2] as SandboxedExecutionOptions).maxBuffer as number;
  };

  it('is the output limit when the request names none', async () => {
    expect(await limitFor()).toBe(SVG_OUTPUT_LIMIT);
  });

  it('is the request limit when that is smaller', async () => {
    expect(await limitFor(1024 * 1024)).toBe(1024 * 1024);
  });

  it('never exceeds the output limit, whatever the request asks for', async () => {
    expect(await limitFor(SVG_OUTPUT_LIMIT * 4)).toBe(SVG_OUTPUT_LIMIT);
  });

  it('tells the launcher to expect a PDF about the size of the drawing plus the fonts it may embed, so that a small page is worth the helper', async () => {
    await limitFor();
    const { expectedOutputBytes } = launch.mock.calls.at(-1)?.[2] as { expectedOutputBytes: number };
    expect(expectedOutputBytes).toBeGreaterThan(svg.length);
    expect(expectedOutputBytes).toBeLessThanOrEqual(svg.length + 64 * 1024);
  });
});
