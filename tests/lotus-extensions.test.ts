import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { FORMAT_REGISTRY, assertNotSpoofedFile, FileExtensionSpoofError } from '../src/lib/registry';
import { interchangeFor } from '../src/worker/office-suite-route';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * `.wk3`, `.wk4` and `.123` are inputs of their own (entry 462). LibreOffice Calc lists `wk1 wks 123` for its Lotus filter and `wk1 wk3 wk4 123` for
 * the filter of libwps, and file(1) and Apache Tika type all of them as `application/vnd.lotus-1-2-3`; the revision of the BOF record names the
 * release (0x1000 is release 3, 0x1002 release 4 and 5, 0x1003 and 0x1005 the 97 and later files). The extension is accepted when the file starts
 * with the BOF record of release 3 and later, whatever its revision, and refused for any other content.
 */

const LOTUS_EXTENSIONS = ['wk3', 'wk4', '123'] as const;
const sofficeMissing = skipWithoutTools('soffice');
const CONVERSION_TIMEOUT_MS = 180_000;

function bof(length: number, revision: number): Buffer {
  const buf = Buffer.alloc(8 + length);
  buf.writeUInt16LE(length, 2);
  buf.writeUInt16LE(revision, 4);
  return buf;
}

function verdict(buf: Buffer, extension: string): 'accepted' | 'refused' {
  try {
    assertNotSpoofedFile(buf, extension, `book.${extension}`);
    return 'accepted';
  } catch (error) {
    if (error instanceof FileExtensionSpoofError) return 'refused';
    throw error;
  }
}

describe('the registry entries of the later Lotus 1-2-3 extensions', () => {
  it.each(LOTUS_EXTENSIONS)('.%s offers the targets of .wks as a spreadsheet of the Lotus type', (extension) => {
    const entry = FORMAT_REGISTRY[extension];
    expect({ id: entry.id, extension: entry.extension, category: entry.category, mimeType: entry.mimeType, targets: entry.targetFormats }).toEqual({
      id: extension,
      extension,
      category: 'spreadsheet',
      mimeType: FORMAT_REGISTRY.wks.mimeType,
      targets: FORMAT_REGISTRY.wks.targetFormats,
    });
  });
});

describe('the content check of the later Lotus 1-2-3 extensions', () => {
  it.each(LOTUS_EXTENSIONS.flatMap((extension) => [0x1000, 0x1002, 0x1003, 0x1005].map((revision) => [extension, revision] as const)))(
    '.%s accepts the 0x1A byte BOF record of revision %d',
    (extension, revision) => {
      expect(verdict(bof(0x1a, revision), extension)).toBe('accepted');
    }
  );

  it.each(LOTUS_EXTENSIONS)('.%s refuses a release 1 or 2 record, a revision past the last release and other content', (extension) => {
    expect([
      verdict(bof(2, 0x0406), extension),
      verdict(bof(0x1a, 0x0404), extension),
      verdict(bof(0x1a, 0x1006), extension),
      verdict(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), extension),
      verdict(Buffer.from('d0cf11e0a1b11ae1', 'hex'), extension),
    ]).toEqual(['refused', 'refused', 'refused', 'refused', 'refused']);
  });
});

describe('the route of the later Lotus 1-2-3 extensions', () => {
  it.each([
    ['wk3', 'csv', 'xlsx'],
    ['wk4', 'csv', 'xlsx'],
    ['123', 'csv', 'xlsx'],
    ['wk3', 'xlsx', undefined],
    ['wk4', 'pdf', undefined],
    ['123', 'zip', undefined],
  ])('writes .%s as .%s through %s', (src, tgt, interchange) => {
    const request = { input: bof(0x1a, 0x1000), src, tgt, options: {}, originalFilename: `book.${src}` };
    expect(interchangeFor(request, tgt === 'zip' || tgt === 'pdf')).toBe(interchange);
  });
});

interface Sample {
  id: string;
  extension: (typeof LOTUS_EXTENSIONS)[number];
  /** Rows of the CSV; the CSV of the file read as `.wks` has the same rows (lotus-release3.test.ts pins their content). */
  rowCount: number;
  /** The first rows, or a label the rows hold, in the file's own bytes. */
  label: string;
}

const SAMPLES: readonly Sample[] = [
  { id: 'opf-peytrend.wk3', extension: 'wk3', rowCount: 223, label: 'VMC15_20' },
  { id: 'lo-solve.wk3', extension: 'wk3', rowCount: 104, label: 'Introducing Solver' },
  { id: 'opf-testlotus123-lotusftp.wk4', extension: 'wk4', rowCount: 16, label: 'Mordocs' },
  { id: 'opf-testlotus123-lotusftp.123', extension: '123', rowCount: 515, label: 'PREFECTURE' },
  { id: 'lo-lotus123_3.123', extension: '123', rowCount: 37, label: 'align across column' },
  { id: 'lo-lotus123_98.123', extension: '123', rowCount: 25, label: 'feuille 2' },
];

describe.skipIf(sofficeMissing)('a real Lotus 1-2-3 file converted under its own extension', () => {
  it.for(SAMPLES)('$id: .$extension reads the rows that .wks reads', { timeout: CONVERSION_TIMEOUT_MS }, async (sample, ctx) => {
    const { bytes } = await requireRealworldSample(ctx, sample.id);
    expect(bytes.includes(Buffer.from(sample.label, 'latin1'))).toBe(true);
    const own = (await dispatchConversion(bytes, sample.extension, 'csv', {}, `book.${sample.extension}`)).buffer.toString('utf-8');
    const asWks = (await dispatchConversion(bytes, 'wks', 'csv', {}, 'book.wks')).buffer.toString('utf-8');
    expect(own).toBe(asWks);
    expect(own.split('\n')).toHaveLength(sample.rowCount);
    expect(own.split(/,|\n|### Sheet: /)).toContain(sample.label);
  });
});
