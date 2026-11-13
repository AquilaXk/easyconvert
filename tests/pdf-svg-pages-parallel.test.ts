import { expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { pageRenderProcesses } from '../src/worker/poppler-ppm';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { runWithoutFileConfinement } from './helpers/unconfined-files';

// The stand-in program of this suite writes its record outside the job directory, which the file confinement refuses (policy 248).
runWithoutFileConfinement();

/**
 * The pages of a PDF written as SVG are drawn by one `pdftocairo` run for each page. The runs go several at a time, so that a document of
 * hundreds of pages is drawn by the cores that are there and stays inside the stage limit (the regression corpus's `cc-3800371.pdf`, 212
 * pages, took 34 s one page after another on the Linux VM and 13 s with the runs side by side, and was refused at the 45 s limit of the
 * runner). Every page is the page the real program draws, in its place in the ZIP.
 */

const PAGES = 24;
const PAUSE_SECONDS = 0.4;
const NATIVE_TIMEOUT_MS = 120_000;

async function document(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < PAGES; index++) {
    const page = doc.addPage([240 + (index % 5) * 10, 180]);
    page.drawRectangle({ x: 10, y: 10, width: 60, height: 40, color: rgb(0.84, 0.15, 0.16) });
    page.drawText(`Page ${index + 1} of the drawing`, { x: 14, y: 140, size: 14, font });
  }
  return Buffer.from(await doc.save());
}

/** Runs `run` with `PDFTOCAIRO_PATH` naming a stand-in that runs the real program after a pause and records how many runs are alive when each starts. */
async function withOverlapShim<T>(run: (observed: () => { mostAtOnce: number; pagesDrawn: number[] }) => Promise<T>): Promise<T> {
  const real = requireOracleTool('pdftocairo');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdftocairo-shim-'));
  const previous = process.env.PDFTOCAIRO_PATH;
  try {
    const shim = path.join(dir, 'pdftocairo');
    fs.writeFileSync(
      shim,
      [
        '#!/bin/sh',
        `case "$*" in -v) exec '${real}' -v ;; esac`,
        'here="$(dirname "$0")"',
        'mkdir -p "$here/alive"',
        'echo "$*" >> "$here/calls.log"',
        // A file of its own for each run: the id of the shell is an id of the PID namespace the sandbox puts it in, the same for every run.
        'slot="$(mktemp "$here/alive/run.XXXXXX")"',
        'ls "$here/alive" | wc -l | tr -d " " >> "$here/alive.log"',
        `sleep ${PAUSE_SECONDS}`,
        `'${real}' "$@"`,
        'status=$?',
        'rm -f "$slot"',
        'exit $status',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    process.env.PDFTOCAIRO_PATH = shim;
    return await run(() => {
      const lines = (file: string): string[] => fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n');
      const pagesDrawn = lines('calls.log').map((line) => {
        const args = line.split(' ');
        return Number(args[args.indexOf('-f') + 1]);
      });
      return { mostAtOnce: Math.max(...lines('alive.log').map(Number)), pagesDrawn };
    });
  } finally {
    if (previous === undefined) delete process.env.PDFTOCAIRO_PATH;
    else process.env.PDFTOCAIRO_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

oracleTest(
  'SVG pages of a long document are drawn by several processes at once, each page once, and every page is the page the real program draws',
  ['pdftocairo'],
  async () => {
    const pdf = await document();
    await withOverlapShim(async (observed) => {
      const result = await dispatchConversion(pdf, 'pdf', 'svg', {}, 'long.pdf');
      const zip = await JSZip.loadAsync(result.buffer);
      const names = Object.keys(zip.files).sort();
      expect(names).toHaveLength(PAGES);
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-svg-reference-'));
      try {
        const input = path.join(work, 'in.pdf');
        fs.writeFileSync(input, pdf);
        for (const [index, name] of names.entries()) {
          const page = index + 1;
          const reference = path.join(work, `page-${page}.svg`);
          execFileSync(requireOracleTool('pdftocairo'), ['-svg', '-f', String(page), '-l', String(page), input, reference]);
          const drawn = await (zip.file(name) as JSZip.JSZipObject).async('nodebuffer');
          expect({ name, same: drawn.equals(fs.readFileSync(reference)) }).toEqual({ name, same: true });
        }
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
      const { mostAtOnce, pagesDrawn } = observed();
      expect(mostAtOnce).toBe(Math.min(pageRenderProcesses(), PAGES));
      expect([...pagesDrawn].sort((a, b) => a - b)).toEqual(Array.from({ length: PAGES }, (_unused, index) => index + 1));
    });
  },
  NATIVE_TIMEOUT_MS
);
