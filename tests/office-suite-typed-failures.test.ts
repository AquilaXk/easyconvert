import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { withMissingBinary } from './helpers/native-tools';
import { convertOffice } from '../src/lib/conversions/office';
import { buildPptBinary } from './helpers/ppt-binary-builder';
import { buildWordBinary } from './helpers/word-binary-builder';
import { asUnreadableDocument } from '../src/worker/office-suite-route';
import { SandboxedProcessError } from '../src/lib/security/process-sandbox';
import { ConversionFailedError, EngineUnavailableError } from '../src/lib/types';
import { FORMAT_REGISTRY, getFormatByExtension } from '../src/lib/registry';
import { requireRealworldSample } from './helpers/realworld-sample';
import { assertReadableAsText } from '../src/lib/conversions/office/text-source-guard';
import {
  OFFICE_SUITE_SOURCE_FORMATS,
  TEXT_ONLY_TARGETS,
  isOfficeSuiteOnlySource,
  legacyReaderRetryInterchange,
  officeSuiteApplication,
  officeSuiteInterchange,
  officeSuiteWritesText,
} from '../src/lib/conversions/office/office-suite-sources';

/**
 * Formats only the office suite reads must never be taken for text by the in-process engine, and a document the office suite
 * itself stops on is a typed answer that names the reason. Real failures of the real-world corpus (#783) are the inputs.
 */

/** What LibreOffice 24.2 printed when it stopped in the layout of `gd-579820.doc` of the regression corpus (a Word report with embedded Excel objects). */
const LIBREOFFICE_LAYOUT_CRASH = [
  'Warning: failed to launch javaldx - java may not function correctly',
  'Unspecified Application Error',
  '',
  '',
  'Fatal exception: Signal 6',
  'Stack:',
  '/usr/lib/libreoffice/program/libuno_sal.so.3(+0x42dfc)[0xe3bacd2f2dfc]',
  '/usr/lib/libreoffice/program/libswlo.so(_ZN11SwTextFrame6FormatEP12OutputDevicePK13SwBorderAttrs+0x844)[0xe3baaf446b04]',
].join('\n');

describe('formats only the office suite reads, without the office suite', () => {
  const sources = OFFICE_SUITE_SOURCE_FORMATS.filter(isOfficeSuiteOnlySource);

  it.each(sources)('.%s is answered with an unavailable-engine error, never with its bytes read as text', async (source) => {
    const target = FORMAT_REGISTRY[source].targetFormats.find((candidate) => candidate !== 'zip') as string;
    const bytes = Buffer.from('PK\u0003\u0004 a binary package whose bytes are not text \u0000\u0001\u0002', 'latin1');
    const failure = await convertFile(bytes, source, target, {}, `sample.${source}`).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EngineUnavailableError);
    expect((failure as EngineUnavailableError).engineName).toBe('soffice');
    expect((failure as Error).message).toContain(`.${source} files are imported by LibreOffice`);
  });

  it('lists the formats the registry advertises with a source the in-process engine cannot read', () => {
    expect(sources.sort()).toEqual(['cdr', 'cgm', 'emf', 'lrf', 'lwp', 'numbers', 'pdb', 'pub', 'qpw', 'sda', 'sdc', 'sdw', 'sxd', 'sxi', 'sxw', 'vsd', 'wmf', 'wpd', 'wps', 'zabw']);
  });
});

describe('a binary container no reader covers', () => {
  it('is refused with a typed error that names the format', async () => {
    const zip = new JSZip();
    zip.file('content.bin', Buffer.from([0, 1, 2, 3]));
    const container = await zip.generateAsync({ type: 'nodebuffer' });
    const failure = await convertOffice(container, 'lwp', 'docx', {}, 'memo.lwp').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toMatch(/binary\/compressed container for format '\.lwp'/);
  });

  it('and so is a binary file with null bytes', async () => {
    const failure = await convertOffice(Buffer.from([0x4c, 0x00, 0x52, 0x00, 0x46, 0x00]), 'lwp', 'txt', {}, 'memo.lwp').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toMatch(/Binary null bytes detected in source format '\.lwp'/);
  });
});

describe('templates and slide shows are read as the format they are a layout of', () => {
  it('reads a Word template with the Word reader', async () => {
    const template = buildWordBinary({ pieces: [{ text: 'Letter template text.\r', compressed: true }] });
    const converted = await convertFile(template, 'dot', 'txt', {}, 'letter.dot');
    expect(converted.buffer.toString('utf-8')).toBe('Letter template text.');
  });

  it('reads a PowerPoint slide show with the PowerPoint reader', async () => {
    const slideShow = buildPptBinary({ slides: [{ shapes: [{ chars: 'Opening slide title' }] }] });
    const converted = await convertFile(slideShow, 'pps', 'txt', {}, 'show.pps');
    expect(converted.buffer.toString('utf-8').trim()).toBe('Opening slide title');
  });
});

describe('an OpenDocument spreadsheet template without the office suite', () => {
  const TEMPLATE = 'lo-calc.ots';

  /** The text of the cells as the package itself holds them: the `text:p` elements of its content.xml, read without the converter. */
  async function cellTextOf(spreadsheet: Buffer): Promise<string[]> {
    const content = await (await JSZip.loadAsync(spreadsheet)).files['content.xml'].async('string');
    return [...content.matchAll(/<text:p>([^<]*)<\/text:p>/g)].map((match) => match[1]);
  }

  it('is read as the spreadsheet it is a layout of: the cells of the real template reach CSV and the cells of the spreadsheet kept for ods', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, TEMPLATE);
    const cells = await cellTextOf(bytes);
    expect(cells).toEqual(['Calc template’s first cell']);
    const csv = await withMissingBinary('SOFFICE_PATH', () => dispatchConversion(bytes, 'ots', 'csv', {}, TEMPLATE));
    expect(csv.buffer.toString('utf-8').trimEnd()).toBe(cells[0]);
    const spreadsheet = await withMissingBinary('SOFFICE_PATH', () => dispatchConversion(bytes, 'ots', 'ods', {}, TEMPLATE));
    expect(await cellTextOf(spreadsheet.buffer)).toEqual(cells);
  });
});

describe('an office suite that stops on a document', () => {
  it('is answered with a typed error that names the file kind, not with the suite’s stack', () => {
    const stopped = new SandboxedProcessError(`SandboxedProcessError (exit 134): ${LIBREOFFICE_LAYOUT_CRASH}`, 134, LIBREOFFICE_LAYOUT_CRASH, 'SIGABRT');
    const answer = asUnreadableDocument(stopped, 'doc');
    expect(answer).toBeInstanceOf(ConversionFailedError);
    expect((answer as Error).message).toBe(
      'LibreOffice stopped while reading the .doc file: the office suite fails on the content of this document, so it cannot be converted.'
    );
  });

  it('names a damaged file for a format whose file the suite could not load or wrote nothing for', () => {
    const cannotLoad = new SandboxedProcessError('SandboxedProcessError (exit 1): Error: source file could not be loaded', 1, 'Error: source file could not be loaded');
    expect((asUnreadableDocument(cannotLoad, 'wps') as Error).message).toBe(
      'LibreOffice could not read the .wps file: it is damaged, encrypted or not a valid WPS document.'
    );
    const wroteNothing = new Error('LibreOffice execution completed without producing expected output file for target format "txt"');
    expect((asUnreadableDocument(wroteNothing, 'sxw') as Error).message).toBe(
      'LibreOffice could not read the .sxw file: it is damaged or not a valid SXW document.'
    );
  });

  it('leaves the failures of a format it does not read untouched', () => {
    const stopped = new SandboxedProcessError(`SandboxedProcessError (exit 134): ${LIBREOFFICE_LAYOUT_CRASH}`, 134, LIBREOFFICE_LAYOUT_CRASH, 'SIGABRT');
    expect(asUnreadableDocument(stopped, 'pdf')).toBe(stopped);
  });
});

describe('how the office suite reaches the targets it does not write', () => {
  it.each([
    ['wps', 'html', 'docx'],
    ['wpd', 'md', 'docx'],
    ['lwp', 'html', 'docx'],
    ['lwp', 'md', 'docx'],
    ['lrf', 'epub', 'docx'],
    ['lrf', 'azw3', 'txt'],
    ['pdb', 'mobi', 'txt'],
    ['pdb', 'epub', 'docx'],
    ['numbers', 'csv', 'xlsx'],
    ['sxw', 'html', 'docx'],
    ['sdw', 'html', 'docx'],
    ['zabw', 'md', 'docx'],
    ['sdc', 'csv', 'xlsx'],
    ['qpw', 'csv', 'xlsx'],
  ])('.%s to .%s is written from the %s the suite exports', (source, target, interchange) => {
    expect(officeSuiteInterchange(source, target)).toBe(interchange);
  });

  it.each(['sxd', 'pub', 'sda', 'vsd', 'cdr', 'doc', 'dot', 'pdf'])('.%s has no interchange file: the suite writes its targets or the reader does', (source) => {
    expect(officeSuiteInterchange(source, 'html')).toBeUndefined();
  });

  it.each([
    ['wps', 'txt', true],
    ['lwp', 'txt', true],
    ['lrf', 'txt', true],
    ['sxw', 'txt', true],
    ['numbers', 'txt', false],
    ['sxi', 'txt', false],
    ['pub', 'txt', false],
    ['wps', 'html', false],
    ['dot', 'txt', false],
  ])('.%s to .%s: the suite writes the text itself is %s', (source, target, writes) => {
    expect(officeSuiteWritesText(source, target)).toBe(writes);
  });

  it.each([
    ['doc', 'html', 'docx'],
    ['dot', 'md', 'docx'],
    ['doc', 'txt', 'txt'],
    ['dot', 'txt', 'txt'],
    ['doc', 'xps', 'txt'],
    ['dot', 'hwpx', 'txt'],
    ['doc', 'mobi', 'txt'],
    ['doc', 'epub', 'docx'],
    ['xls', 'csv', 'xlsx'],
    ['xlt', 'csv', 'xlsx'],
    ['ppt', 'html', 'pptx'],
    ['pps', 'txt', 'pptx'],
    ['pot', 'html', 'pptx'],
  ])('a refused .%s to .%s is retried through %s', (source, target, interchange) => {
    expect(legacyReaderRetryInterchange(source, target)).toBe(interchange);
  });

  it.each(['docx', 'xlsx', 'pdf', 'wps', 'odt', 'ott'])('a refused .%s is not retried with the office suite', (source) => {
    expect(legacyReaderRetryInterchange(source, 'txt')).toBeUndefined();
  });

  it.each([
    ['wps', 'writer'],
    ['lwp', 'writer'],
    ['numbers', 'calc'],
    ['sxi', 'impress'],
    ['pub', 'draw'],
    ['sxd', 'draw'],
    ['vsd', 'draw'],
    ['cdr', 'draw'],
    ['emf', 'draw'],
    ['wmf', 'draw'],
    ['cgm', 'impress'],
    ['dot', 'writer'],
    ['xlt', 'calc'],
    ['pps', 'impress'],
    ['ott', 'writer'],
    ['otp', 'impress'],
    ['ots', 'calc'],
  ])('.%s is imported by the %s application', (source, application) => {
    expect(officeSuiteApplication(source)).toBe(application);
  });

  it.each([
    ['docx', 'writer'],
    ['rtf', 'writer'],
    ['dotx', 'writer'],
    ['docm', 'writer'],
    ['xlsx', 'calc'],
    ['xlsm', 'calc'],
    ['xltx', 'calc'],
    ['csv', 'calc'],
    ['pptx', 'impress'],
    ['ppsx', 'impress'],
    ['potx', 'impress'],
    ['key', 'impress'],
    ['odg', 'draw'],
    ['odd', 'draw'],
  ])('.%s is opened by the %s application', (format, application) => {
    expect(officeSuiteApplication(format)).toBe(application);
  });

  it('knows no application for a format the office suite does not open', () => {
    expect(officeSuiteApplication('pdf')).toBeUndefined();
    expect(officeSuiteApplication('png')).toBeUndefined();
  });
});

describe('the targets the in-process engine writes from plain text only', () => {
  const TEXT = 'Quarterly report\n\nRevenue grew by four percent.';

  it('are the targets it offers for a text file and not for a Word document, which is why a refused document reaches them through its text', () => {
    const fromText = getFormatByExtension('txt')?.targetFormats ?? [];
    const fromWordDocument = new Set(getFormatByExtension('docx')?.targetFormats);
    const notFromWordDocument = fromText.filter((target) => !fromWordDocument.has(target) && target !== 'docx');
    expect([...notFromWordDocument].sort()).toEqual([...TEXT_ONLY_TARGETS].sort());
  });

  it.each([...TEXT_ONLY_TARGETS])('.%s is written from text, and the engine turns a Word document down for it', async (target) => {
    const written = await convertFile(Buffer.from(TEXT), 'txt', target, {}, 'report.txt');
    expect(written.filename).toBe(`report.${target}`);
    expect(written.buffer.length).toBeGreaterThan(0);
    const wordDocument = (await convertFile(Buffer.from(TEXT), 'txt', 'docx', {}, 'report.txt')).buffer;
    const refusal = await convertFile(wordDocument, 'docx', target, {}, 'report.docx').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ConversionFailedError);
    expect((refusal as Error).message).toMatch(new RegExp(`^Cannot convert from Microsoft Word \\(DOCX\\) \\(\\.docx\\) to target format \\.${target}\\.`));
  });
});

describe('the dispatcher without the office suite', () => {
  /** A compound file header (Works) and an empty ZIP package (OpenOffice.org 1.x and Numbers): enough to pass the signature check. */
  const COMPOUND_FILE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);
  const ZIP_PACKAGE = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]);
  const LOTUS_WORD_PRO_HEADER = Buffer.concat([Buffer.from('WordPro\0'), Buffer.alloc(504)]);

  it.each([
    ['wps', 'docx', COMPOUND_FILE],
    ['wps', 'html', COMPOUND_FILE],
    ['wps', 'txt', COMPOUND_FILE],
    ['lwp', 'docx', LOTUS_WORD_PRO_HEADER],
    ['lwp', 'pdf', LOTUS_WORD_PRO_HEADER],
    ['sxw', 'odt', ZIP_PACKAGE],
    ['numbers', 'csv', ZIP_PACKAGE],
  ])('.%s to .%s is an unavailable-engine answer (503), never a conversion of the bytes', async (source, target, bytes) => {
    const run = withMissingBinary('SOFFICE_PATH', () => dispatchConversion(bytes, source, target, {}, `sample.${source}`));
    await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toMatchObject({ engineName: 'soffice' });
  });
});

describe('a PowerPoint slide show written as a PowerPoint 97-2003 file without the office suite', () => {
  it('is an unavailable-engine answer (503): only the office suite writes the binary format', async () => {
    const slideShow = buildPptBinary({ slides: [{ shapes: [{ chars: 'Opening slide title' }] }] });
    const run = withMissingBinary('SOFFICE_PATH', () => dispatchConversion(slideShow, 'pps', 'ppt', {}, 'show.pps'));
    await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toMatchObject({ engineName: 'soffice' });
  });
});

describe('the guard that keeps binary bytes from being read as text', () => {
  it.each([
    ['a ZIP package', [0x50, 0x4b, 0x03, 0x04]],
    ['an OLE2 compound file', [0xd0, 0xcf, 0x11, 0xe0]],
    ['a 7-Zip archive', [0x37, 0x7a, 0xbc, 0xaf]],
  ])('refuses %s by its signature, naming the format', (_name, signature) => {
    const container = Buffer.from([...signature, 0x41, 0x42]);
    expect(() => assertReadableAsText(container, 'lwp')).toThrow("Cannot extract plain text from binary/compressed container for format '.lwp': fail-closed against mojibake corruption.");
  });

  /** What the guard answers for the bytes: that it accepts them, or the message of its refusal. */
  function verdictOf(input: Buffer): string {
    try {
      assertReadableAsText(input, 'lwp');
      return 'accepted';
    } catch (error) {
      expect(error).toBeInstanceOf(ConversionFailedError);
      return (error as Error).message;
    }
  }

  it('refuses a null byte in the first 4096 bytes and accepts one after them', () => {
    const inside = Buffer.alloc(4096, 0x61);
    inside[4095] = 0;
    expect(verdictOf(inside)).toBe("Binary null bytes detected in source format '.lwp': fail-closed against mojibake corruption.");
    const after = Buffer.alloc(4097, 0x61);
    after[4096] = 0;
    expect(verdictOf(after)).toBe('accepted');
  });

  it('accepts text, and a file shorter than a signature, and refuses the same bytes once a signature starts them', () => {
    const memo = Buffer.from('plain text of a memo\n');
    expect(verdictOf(memo)).toBe('accepted');
    expect(verdictOf(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), memo]))).toMatch(/^Cannot extract plain text from binary\/compressed container/);
    expect(verdictOf(Buffer.from([0x50, 0x4b]))).toBe('accepted');
  });
});

describe('Corel Presentations (.shw), which no office suite filter reads', () => {
  const SHOW = 'office-testcorel.shw';

  it.for(['pdf', 'pptx'])('refuses the real file for %s with a typed error that names the format, not with its bytes read as text', async (target, ctx) => {
    const { bytes } = await requireRealworldSample(ctx, SHOW);
    const failure = await dispatchConversion(bytes, 'shw', target, {}, SHOW).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toMatch(/binary\/compressed container for format '\.shw'/);
  });

  it('packs the real file as it is for zip', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, SHOW);
    const result = await dispatchConversion(bytes, 'shw', 'zip', {}, SHOW);
    const archive = await JSZip.loadAsync(result.buffer);
    const entries = Object.keys(archive.files);
    expect(entries).toHaveLength(1);
    expect(Buffer.from(await archive.files[entries[0]].async('uint8array')).equals(bytes)).toBe(true);
  });
});
