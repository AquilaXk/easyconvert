import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * The replacement of a text thread, on real threads: a thread that has read most of its documents is followed by a
 * thread that has read the fixed warm-up page, and the documents go on reading the same text across the hand-over.
 * The unit test with stand-in threads (pdf-text-host.test.ts) holds the bookkeeping; this one holds that a thread
 * started with the warm-up request really reports it is ready and then reads documents.
 */

const started = vi.hoisted(() => ({ workers: [] as Array<{ worker: import('node:worker_threads').Worker; workerData: unknown }> }));

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  class RecordingWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      started.workers.push({ worker: this, workerData: (args[1] as { workerData?: unknown } | undefined)?.workerData });
    }
  }
  return { ...actual, Worker: RecordingWorker };
});

import { runPdfTextJobInThread, shutdownPdfTextThreads } from '../src/lib/conversions/pdf-text-host';
import { warmupPdf } from '../src/lib/conversions/pdf-text-warmup';
import { requireOracleTool } from './helpers/differential-oracle';
import { skipWithoutTools } from './helpers/strict-skip';

const FIXTURE = path.join(__dirname, 'fixtures', 'pdf-text', 'latin.pdf');
const LAST_DOCUMENT_OF_THE_FIRST_THREAD = 200;
const TEXT_JOB = { geometry: 'none', content: true } as const;
/** The lines of the three pages of the warm-up document, as its source writes them (page 1: two standard fonts, 2: an embedded simple font, 3: an embedded composite font). */
const WARMUP_PAGES = [
  [
    'Replacement threads read this page before the first document.',
    'Words, numbers 1234567890 and punctuation, (like this); are set in two fonts.',
    'A second paragraph keeps the reading order and the line joining busy.',
  ],
  [
    'An embedded font program is parsed and its glyphs are mapped back to text.',
    'Fourteen small paragraphs of forty words are what a typical page holds.',
    'The third line closes the page and ends the stream.',
  ],
  [
    'Glyph numbers and a map to Unicode carry this line.',
    'Здравствуй, мир: строка с кириллицей и греческим αβγ.',
    'これは漢字とかなの文です。',
  ],
];
const WARMUP_LINES = WARMUP_PAGES.flat();
const poppler = skipWithoutTools('pdftotext');

afterAll(() => {
  shutdownPdfTextThreads();
});

function textOf(content: Array<{ items: Array<{ text: string }> }>): string {
  return content.map((page) => page.items.map((item) => item.text).join('\n')).join('\f');
}

/** The text of each page as the reader returns it, which splits runs at the word spaces of an embedded font, so the lines of a page are compared joined. */
function pageTextsOf(content: Array<{ items: Array<{ text: string }> }>): string[] {
  return content.map((page) => page.items.map((item) => item.text).join(''));
}

describe('text threads on real worker threads', () => {
  it.skipIf(poppler)('writes a warm-up document that Poppler reads line by line, without a repair of its structure or fonts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-warmup-'));
    try {
      const file = path.join(dir, 'warmup.pdf');
      fs.writeFileSync(file, warmupPdf());
      const read = spawnSync(requireOracleTool('pdftotext'), ['-enc', 'UTF-8', file, '-'], { encoding: 'utf8' });
      expect(read.stderr).toBe('');
      expect(read.status).toBe(0);
      expect(read.stdout.split(/[\n\f]/).filter((line) => line !== '')).toEqual(WARMUP_LINES);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the warm-up document on a text thread as the page it is', async () => {
    const result = await runPdfTextJobInThread(Buffer.from(warmupPdf()), TEXT_JOB);
    expect(pageTextsOf(result.content)).toEqual(WARMUP_PAGES.map((lines) => lines.join('')));
    expect(result.content.map((page) => page.unmappedGlyphs)).toEqual([0, 0, 0]);
    expect(result.fonts.map((font) => font.name).sort()).toEqual(['Helvetica', 'Times-Roman', 'WarmupSans', 'WarmupSans']);
  });

  it('hands the documents over to a warm replacement and reads the same text on both threads', async () => {
    const pdf = fs.readFileSync(FIXTURE);
    const first = textOf((await runPdfTextJobInThread(pdf, TEXT_JOB)).content);
    expect(first.length).toBeGreaterThan(0);
    // Read until the first thread is retired (at 100 documents once the replacement is ready, at 200 at the latest), however long the
    // replacement takes to start on this machine.
    for (let read = 1; read < LAST_DOCUMENT_OF_THE_FIRST_THREAD && started.workers[0].worker.threadId !== -1; read++) {
      expect(textOf((await runPdfTextJobInThread(pdf, TEXT_JOB)).content)).toBe(first);
    }
    expect(started.workers.map((entry) => entry.workerData)).toMatchObject([
      { warmUp: false, images: false },
      { warmUp: true, images: false },
    ]);
    expect(started.workers).toHaveLength(2);
    await vi.waitFor(() => expect(started.workers[0].worker.threadId).toBe(-1));
    expect(started.workers[1].worker.threadId).toBeGreaterThan(0);
  });
});
