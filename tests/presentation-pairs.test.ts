import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { getOracleToolPath, extractTextWithExternalPdftotext } from './helpers/differential-oracle';
import { pdfinfoPages } from './helpers/encrypted-pdf-fixtures';
import { requireRealworldSample } from './helpers/realworld-sample';
import { sofficeConvert } from './helpers/soffice-convert';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * The presentation, spreadsheet and table pairs of entry 185: slide shows, templates, macro presentations, Keynote and Kingsoft files
 * written as page pictures, PostScript pictures, Markdown and the other presentation formats, and Excel macro workbooks and CSV tables
 * written as page pictures. Each class converts a real file (or one the office suite saves from a real file under the name of a format
 * that has no public sample) through the dispatcher, and the output is read back by a program that is not the converter: LibreOffice
 * (printing the output to a PDF, read by pdftotext), Tesseract on the page pictures, Ghostscript drawing the PostScript pictures, and
 * the package parts of the OpenDocument and PowerPoint outputs. The pairs that the entry leaves out are pinned at the end.
 */

const TIMEOUT_MS = 600_000;
const MIN_WORD_LENGTH = 4;
const COMPOUND_FILE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const POWERPOINT_STREAM = 'PowerPoint Document';
const RASTER_DPI = 150;

const normalized = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const wordsOf = (text: string): string[] => normalized(text).split(' ').filter((word) => word.length >= MIN_WORD_LENGTH);

function withTempDirectory<T>(use: (directory: string) => T): T {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'presentation-pairs-'));
  try {
    return use(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** The pictures of an output: the file itself, or the entries of the ZIP that a document of several pages arrives in, in page order. */
async function pagePictures(output: Buffer): Promise<Buffer[]> {
  if (output.subarray(0, 2).toString('latin1') !== 'PK') return [output];
  const archive = await JSZip.loadAsync(output);
  return Promise.all(
    Object.keys(archive.files)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .map(async (name) => Buffer.from(await archive.files[name].async('uint8array')))
  );
}

/** Tesseract's reading of a picture. */
function recognizedText(picture: Buffer): string {
  return withTempDirectory((directory) => {
    const file = path.join(directory, 'page.png');
    fs.writeFileSync(file, picture);
    return execFileSync(getOracleToolPath('tesseract') ?? 'tesseract', [file, '-', '--psm', '6'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  });
}

/** Page count and first page size in points of a PDF, from Poppler's pdfinfo. */
function pdfPages(pdf: Buffer): { count: number; width: number; height: number } {
  const size = withTempDirectory((directory) => {
    const file = path.join(directory, 'in.pdf');
    fs.writeFileSync(file, pdf);
    const info = execFileSync(getOracleToolPath('pdfinfo') ?? 'pdfinfo', [file], { encoding: 'utf-8' });
    const match = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(info);
    return { width: Number(match?.[1]), height: Number(match?.[2]) };
  });
  return { count: pdfinfoPages(pdf), ...size };
}

type Printed = { count: number; width: number; height: number };

/** The PDF the office suite prints of an input: the pages that every picture has to match. */
const printedPdf = (input: Buffer, name: string): Buffer => sofficeConvert(input, name, 'pdf', (pdf) => pdf.read());

/** The text of an output as the office suite prints it and Poppler reads it. */
const printedText = (output: Buffer, name: string): string => sofficeConvert(output, name, 'pdf', (pdf) => extractTextWithExternalPdftotext(pdf.read()) ?? '');

function expectPhrases(phrases: readonly string[], text: string, label: string): void {
  const found = normalized(text);
  expect({ label, missing: phrases.filter((phrase) => !found.includes(phrase)) }).toEqual({ label, missing: [] });
}

function expectLegacyPresentation(output: Buffer, label: string): void {
  expect(output.subarray(0, COMPOUND_FILE_SIGNATURE.length).equals(COMPOUND_FILE_SIGNATURE), `${label} is a compound file`).toBe(true);
  expect(output.includes(Buffer.from(POWERPOINT_STREAM, 'utf16le')), `${label} holds the ${POWERPOINT_STREAM} stream`).toBe(true);
}

async function expectPictures(output: Buffer, target: 'png' | 'jpg', printed: Printed, label: string): Promise<Buffer[]> {
  const pictures = await pagePictures(output);
  expect({ label, pages: pictures.length }).toEqual({ label, pages: printed.count });
  for (const picture of pictures) {
    const metadata = await sharp(picture).metadata();
    expect(metadata.format).toBe(target === 'png' ? 'png' : 'jpeg');
    expect(Math.abs((metadata.width ?? 0) / (metadata.height ?? 1) - printed.width / printed.height), `${label} aspect ratio`).toBeLessThan(0.01);
  }
  const { channels } = await sharp(pictures[0]).stats();
  expect(Math.max(...channels.map((channel) => channel.max - channel.min)), `${label} first page is not one flat colour`).toBeGreaterThan(0);
  return pictures;
}

/** The first page of a PostScript picture drawn by Ghostscript, a PNG. */
function drawnByGhostscript(eps: Buffer): Buffer {
  return withTempDirectory((directory) => {
    const file = path.join(directory, 'page.eps');
    fs.writeFileSync(file, eps);
    const png = path.join(directory, 'page.png');
    execFileSync(getOracleToolPath('gs') ?? 'gs', ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-dEPSCrop', '-sDEVICE=png16m', `-r${RASTER_DPI}`, `-sOutputFile=${png}`, file]);
    return fs.readFileSync(png);
  });
}

/** A deck or workbook under test: a real file, or the real file the office suite saved in another format when the format has no public sample. */
interface Sample {
  /** Id in bench/realworld/manifest.json. */
  id: string;
  extension: string;
  /** The office suite's filter that saves the sample again in `extension`. */
  resaveAs?: string;
  /** Phrases of the document's own text, read from its PDF by pdftotext. */
  phrases: readonly string[];
  /** Whether Tesseract reads the first picture of the sample (stylised text does not read back). */
  readsBack: boolean;
}

const INSTRUMENT = ['so you want an instrument approach', 'new york flight procedures office'];

const SAMPLES: Readonly<Record<string, Sample>> = {
  pps: { id: 'govdocs1-764092.pps', extension: 'pps', phrases: INSTRUMENT, readsBack: true },
  pot: { id: 'govdocs1-764092.pps', extension: 'pot', resaveAs: 'pot:MS PowerPoint 97 Vorlage', phrases: INSTRUMENT, readsBack: true },
  dps: { id: 'govdocs1-764092.pps', extension: 'dps', resaveAs: 'ppt:MS PowerPoint 97', phrases: INSTRUMENT, readsBack: true },
  potx: { id: 'lo-tdf96389_deftabstopecma.potx', extension: 'potx', phrases: ['xxx yyy'], readsBack: true },
  ppsx: { id: 'lo-test.ppsx', extension: 'ppsx', phrases: ['test'], readsBack: true },
  pptm: { id: 'lo-macro.pptm', extension: 'pptm', phrases: ['presentation with a macro', 'click the button to see a message'], readsBack: true },
  key: { id: 'tika-testkeynote2018.key', extension: 'key', phrases: ['libreoffice 6 2'], readsBack: false },
  odp: { id: 'opf-libreofficeimpress_odp_1.3.odp', extension: 'odp', phrases: ['example impress file'], readsBack: true },
};

async function loadSample(ctx: Parameters<typeof requireRealworldSample>[0], sample: Sample): Promise<Buffer> {
  const { bytes } = await requireRealworldSample(ctx, sample.id);
  return sample.resaveAs === undefined ? bytes : sofficeConvert(bytes, sample.id, sample.resaveAs, (output) => output.read());
}

const OFFICE_TOOLS = ['soffice', 'pdftotext', 'pdfinfo', 'pdftoppm'] as const;

describe.skipIf(skipWithoutTools(...OFFICE_TOOLS, 'tesseract'))('slide shows, templates, macro presentations and Keynote files as page pictures', () => {
  const CASES: ReadonlyArray<readonly [string, readonly ('png' | 'jpg')[]]> = [
    ['pot', ['png', 'jpg']],
    ['potx', ['png', 'jpg']],
    ['ppsx', ['png', 'jpg']],
    ['pptm', ['png', 'jpg']],
    ['key', ['png', 'jpg']],
  ];
  for (const [name, targets] of CASES) {
    const sample = SAMPLES[name];
    it(
      `.${sample.extension} (${sample.id}) is one picture for each page of its PDF, in a ZIP when there are several`,
      async (ctx) => {
        const bytes = await loadSample(ctx, sample);
        const printed = pdfPages(printedPdf(bytes, `in.${sample.extension}`));
        for (const target of targets) {
          const label = `${sample.id} as .${sample.extension} -> ${target}`;
          const result = await dispatchConversion(bytes, sample.extension, target, {}, sample.id);
          expect(result.engineUsed, label).toMatch(/^native-/);
          const pictures = await expectPictures(result.buffer, target, printed, label);
          if (printed.count === 1) expect(result.buffer.subarray(0, 2).toString('latin1'), `${label} is a single picture`).not.toBe('PK');
          else expect(result.buffer.subarray(0, 2).toString('latin1'), `${label} is a ZIP of the pages`).toBe('PK');
          if (sample.readsBack) expectPhrases([sample.phrases[0]], recognizedText(await sharp(pictures[0]).png().toBuffer()), `${label} (read by Tesseract)`);
          // The first page alone is a picture, not an archive.
          const first = await dispatchConversion(bytes, sample.extension, target, { multiPageOutput: 'first' }, sample.id);
          expect(first.buffer.subarray(0, 2).toString('latin1'), `${label} first page`).not.toBe('PK');
        }
      },
      TIMEOUT_MS
    );
  }

  it(
    'an Excel macro workbook is one picture for each printed page of its sheets',
    async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, 'office-spreadsheet-testnames.xlsm');
      const printed = pdfPages(printedPdf(bytes, 'in.xlsm'));
      for (const target of ['png', 'jpg'] as const) {
        const result = await dispatchConversion(bytes, 'xlsm', target, {}, 'testnames.xlsm');
        const pictures = await expectPictures(result.buffer, target, printed, `xlsm -> ${target}`);
        expectPhrases(['abc2'], recognizedText(await sharp(pictures[0]).png().toBuffer()), `xlsm -> ${target} (read by Tesseract)`);
      }
    },
    TIMEOUT_MS
  );
});

describe.skipIf(skipWithoutTools('pdftotext', 'pdfinfo', 'pdftoppm', 'tesseract'))('a CSV table as page pictures', () => {
  const ROWS = 160;
  const csv = Buffer.from(['city,country,population', ...Array.from({ length: ROWS }, (_, row) => `Harbourtown${row + 1},Lanternia,${1000 + row}`)].join('\n') + '\n');

  it(
    'is one picture for each page of the PDF the same table converts to, and the first page reads back',
    async () => {
      const pdf = (await dispatchConversion(csv, 'csv', 'pdf', {}, 'cities.csv')).buffer;
      const printed = pdfPages(pdf);
      expect(printed.count).toBeGreaterThan(1);
      for (const target of ['png', 'jpg'] as const) {
        const label = `csv -> ${target}`;
        const result = await dispatchConversion(csv, 'csv', target, {}, 'cities.csv');
        expect(result.engineUsed, label).toBe('native-poppler');
        const pictures = await expectPictures(result.buffer, target, printed, label);
        expectPhrases(['harbourtown1 lanternia 1000'], recognizedText(await sharp(pictures[0]).png().toBuffer()), `${label} (read by Tesseract)`);
        // The last page holds the last row.
        expectPhrases([`harbourtown${ROWS} lanternia ${1000 + ROWS - 1}`], recognizedText(await sharp(pictures[pictures.length - 1]).png().toBuffer()), `${label} last page (read by Tesseract)`);
        const first = await dispatchConversion(csv, 'csv', target, { multiPageOutput: 'first' }, 'cities.csv');
        expect(first.buffer.subarray(0, 2).toString('latin1'), `${label} first page`).not.toBe('PK');
      }
    },
    TIMEOUT_MS
  );
});

describe.skipIf(skipWithoutTools(...OFFICE_TOOLS))('slide shows, templates and Keynote files as the other presentation formats', () => {
  const CASES: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['pot', ['ppt']],
    ['potx', ['odp', 'ppt']],
    ['ppsx', ['ppt']],
    ['pptm', ['odp', 'ppt', 'pptx', 'pdf', 'html', 'txt']],
    ['key', ['ppt']],
  ];
  for (const [name, targets] of CASES) {
    const sample = SAMPLES[name];
    it(
      `.${sample.extension} (${sample.id}) converts to ${targets.join(', ')} with the words the office suite shows`,
      async (ctx) => {
        const bytes = await loadSample(ctx, sample);
        for (const target of targets) {
          const label = `${sample.id} as .${sample.extension} -> ${target}`;
          const result = await dispatchConversion(bytes, sample.extension, target, {}, sample.id);
          if (target === 'ppt') expectLegacyPresentation(result.buffer, label);
          if (target === 'odp') {
            const archive = await JSZip.loadAsync(result.buffer);
            expect(await archive.file('mimetype')?.async('string'), label).toBe('application/vnd.oasis.opendocument.presentation');
          }
          if (target === 'pptx') {
            // A macro project never travels into the result, and the main part is a presentation, not a macro presentation.
            const archive = await JSZip.loadAsync(result.buffer);
            expect(Object.keys(archive.files).some((entry) => /vbaProject/i.test(entry)), `${label} holds no macro project`).toBe(false);
            expect(await archive.file('[Content_Types].xml')?.async('string'), label).not.toMatch(/macroEnabled|vnd\.ms-office\.vba/);
            expect(await archive.file('[Content_Types].xml')?.async('string'), label).toMatch(/presentationml\.presentation\.main\+xml/);
          }
          const text =
            target === 'pdf' ? (extractTextWithExternalPdftotext(result.buffer) ?? '')
            : target === 'html' ? result.buffer.toString('utf-8').replace(/<[^>]*>/g, ' ')
            : target === 'txt' ? result.buffer.toString('utf-8')
            : printedText(result.buffer, `out.${target}`);
          expectPhrases(sample.phrases, text, label);
        }
      },
      TIMEOUT_MS
    );
  }
});

describe.skipIf(skipWithoutTools(...OFFICE_TOOLS, 'gs', 'tesseract'))('presentations as PostScript pictures', () => {
  const GOLDEN_DECK = path.join(__dirname, 'fixtures', 'golden', 'office', 'drawingml-shapes-presentation.pptx');
  const CASES = ['pps', 'dps', 'ppsx', 'pptm', 'odp'] as const;

  async function expectEps(bytes: Buffer, extension: string, name: string, phrase: string): Promise<void> {
    const label = `${name} as .${extension} -> eps`;
    const printed = pdfPages(printedPdf(bytes, `in.${extension}`));
    const result = await dispatchConversion(bytes, extension, 'eps', {}, name);
    const pictures = await pagePictures(result.buffer);
    expect({ label, pages: pictures.length }).toEqual({ label, pages: printed.count });
    for (const picture of pictures) {
      expect(picture.subarray(0, 23).toString('latin1'), `${label} is encapsulated PostScript`).toBe('%!PS-Adobe-3.0 EPSF-3.0');
      expect(picture.toString('latin1', 0, 400), `${label} names its bounding box`).toMatch(/%%BoundingBox: 0 0 \d+ \d+/);
    }
    expectPhrases([phrase], recognizedText(drawnByGhostscript(pictures[0])), `${label} (drawn by Ghostscript, read by Tesseract)`);
  }

  for (const name of CASES) {
    const sample = SAMPLES[name];
    it(
      `.${sample.extension} (${sample.id}) is one PostScript picture for each page of its PDF, and the first draws the first slide`,
      async (ctx) => {
        await expectEps(await loadSample(ctx, sample), sample.extension, sample.id, sample.phrases[0]);
      },
      TIMEOUT_MS
    );
  }

  it(
    'a PowerPoint deck (.pptx) is one PostScript picture for each slide',
    async () => {
      await expectEps(fs.readFileSync(GOLDEN_DECK), 'pptx', 'drawingml-shapes-presentation.pptx', 'enterprise architecture');
    },
    TIMEOUT_MS
  );

  it(
    'a PowerPoint 97-2003 deck (.ppt) is one PostScript picture for each slide',
    async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, 'govdocs1-000160.ppt');
      await expectEps(bytes, 'ppt', 'govdocs1-000160.ppt', 'optimum routes');
    },
    TIMEOUT_MS
  );
});

describe.skipIf(skipWithoutTools(...OFFICE_TOOLS))('presentations as Markdown', () => {
  const GOLDEN_DECK = path.join(__dirname, 'fixtures', 'golden', 'office', 'drawingml-shapes-presentation.pptx');

  function expectMarkdownOf(markdown: string, bytes: Buffer, extension: string, phrases: readonly string[], label: string): void {
    // The words of the deck as the office suite prints them are all in the Markdown, and the phrases pinned from the deck are there whole.
    const reference = [...new Set(wordsOf(extractTextWithExternalPdftotext(printedPdf(bytes, `in.${extension}`)) ?? ''))];
    const have = new Set(wordsOf(markdown));
    const missing = reference.filter((word) => !have.has(word));
    expect({ label, missing: missing.slice(0, 8), within: missing.length <= reference.length * 0.1 }).toEqual({ label, missing: missing.slice(0, 8), within: true });
    expectPhrases(phrases, markdown, label);
  }

  for (const name of ['pps', 'dps', 'ppsx', 'pptm', 'odp'] as const) {
    const sample = SAMPLES[name];
    it(
      `.${sample.extension} (${sample.id}) to .md holds the words of the slides`,
      async (ctx) => {
        const bytes = await loadSample(ctx, sample);
        const result = await dispatchConversion(bytes, sample.extension, 'md', {}, sample.id);
        expect(result.filename.endsWith('.md')).toBe(true);
        expect(result.mimeType).toMatch(/markdown/);
        expectMarkdownOf(result.buffer.toString('utf-8'), bytes, sample.extension, sample.phrases, `${sample.id} as .${sample.extension} -> md`);
      },
      TIMEOUT_MS
    );
  }

  it(
    'a PowerPoint deck (.pptx) to .md holds the words of the slides, and a PowerPoint 97-2003 deck (.ppt) does too',
    async (ctx) => {
      const pptx = fs.readFileSync(GOLDEN_DECK);
      const fromPptx = await dispatchConversion(pptx, 'pptx', 'md', {}, 'drawingml-shapes-presentation.pptx');
      expectMarkdownOf(fromPptx.buffer.toString('utf-8'), pptx, 'pptx', ['enterprise architecture', 'differential verification engine'], 'pptx -> md');
      const { bytes } = await requireRealworldSample(ctx, 'govdocs1-000160.ppt');
      const fromPpt = await dispatchConversion(bytes, 'ppt', 'md', {}, 'govdocs1-000160.ppt');
      expectMarkdownOf(fromPpt.buffer.toString('utf-8'), bytes, 'ppt', ['optimum routes for lax hkg within russian airspace', 'analysis objective'], 'ppt -> md');
    },
    TIMEOUT_MS
  );
});

describe('the pairs of entry 185 in the registry', () => {
  const ADDED: Readonly<Record<string, readonly string[]>> = {
    csv: ['jpg', 'png'],
    dps: ['eps', 'md'],
    key: ['jpg', 'png', 'ppt'],
    odp: ['eps', 'md'],
    pot: ['jpg', 'png', 'ppt'],
    potx: ['jpg', 'odp', 'png', 'ppt'],
    pps: ['eps', 'md'],
    ppsx: ['eps', 'jpg', 'md', 'png', 'ppt'],
    ppt: ['eps', 'md'],
    pptm: ['eps', 'html', 'jpg', 'md', 'odp', 'pdf', 'png', 'ppt', 'pptx', 'txt'],
    pptx: ['eps', 'md'],
    xlsm: ['jpg', 'png'],
  };
  /** Entry 185 leaves these out: no engine of the worker writes them (XPS, SWF), the metafile encoders refuse a page (EMF), or the source's application cannot export them (Word, Excel, PowerPoint across applications). */
  const LEFT_OUT: Readonly<Record<string, readonly string[]>> = {
    dps: ['swf'],
    key: ['doc', 'xls'],
    numbers: ['doc', 'ppt'],
    odp: ['swf'],
    pot: ['emf', 'xps'],
    potx: ['emf', 'xps'],
    pps: ['swf'],
    ppsx: ['swf'],
    ppt: ['emf', 'swf', 'xps'],
    pptm: ['emf', 'swf', 'xps'],
    pptx: ['emf', 'swf', 'xps'],
    xls: ['xps'],
    xlsx: ['xps'],
  };

  it.each(Object.entries(ADDED))('%s offers the targets of the entry', (source, targets) => {
    expect(targets.filter((target) => !FORMAT_REGISTRY[source].targetFormats.includes(target))).toEqual([]);
  });

  it.each(Object.entries(LEFT_OUT))('%s does not offer the targets the entry leaves out', (source, targets) => {
    expect(targets.filter((target) => FORMAT_REGISTRY[source].targetFormats.includes(target))).toEqual([]);
  });
});
