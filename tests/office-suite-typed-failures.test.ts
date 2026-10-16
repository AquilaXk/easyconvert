import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { convertOffice } from '../src/lib/conversions/office';
import { buildPptBinary } from './helpers/ppt-binary-builder';
import { buildWordBinary } from './helpers/word-binary-builder';
import { asUnreadableDocument } from '../src/worker/engines';
import { SandboxedProcessError } from '../src/lib/security/process-sandbox';
import { ConversionFailedError, EngineUnavailableError } from '../src/lib/types';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import {
  OFFICE_SUITE_SOURCE_FORMATS,
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
    expect(sources.sort()).toEqual(['lrf', 'numbers', 'pdb', 'pub', 'rb', 'sxd', 'sxi', 'sxw', 'wpd', 'wps']);
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
    expect(converted.buffer.toString('utf-8')).toContain('Opening slide title');
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

  it('leaves the failures of a format it does not read untouched', () => {
    const stopped = new SandboxedProcessError(`SandboxedProcessError (exit 134): ${LIBREOFFICE_LAYOUT_CRASH}`, 134, LIBREOFFICE_LAYOUT_CRASH, 'SIGABRT');
    expect(asUnreadableDocument(stopped, 'pdf')).toBe(stopped);
  });
});

describe('how the office suite reaches the targets it does not write', () => {
  it.each([
    ['wps', 'html', 'docx'],
    ['wpd', 'md', 'docx'],
    ['lrf', 'epub', 'docx'],
    ['lrf', 'azw3', 'txt'],
    ['pdb', 'mobi', 'txt'],
    ['rb', 'oeb', 'txt'],
    ['rb', 'lrf', 'txt'],
    ['pdb', 'epub', 'docx'],
    ['numbers', 'csv', 'xlsx'],
    ['sxw', 'html', 'docx'],
  ])('.%s to .%s is written from the %s the suite exports', (source, target, interchange) => {
    expect(officeSuiteInterchange(source, target)).toBe(interchange);
  });

  it.each(['sxd', 'pub', 'doc', 'dot', 'pdf'])('.%s has no interchange file: the suite writes its targets or the reader does', (source) => {
    expect(officeSuiteInterchange(source, 'html')).toBeUndefined();
  });

  it.each([
    ['wps', 'txt', true],
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
    ['numbers', 'calc'],
    ['sxi', 'impress'],
    ['pub', 'draw'],
    ['sxd', 'draw'],
    ['dot', 'writer'],
    ['xlt', 'calc'],
    ['pps', 'impress'],
    ['ott', 'writer'],
    ['otp', 'impress'],
  ])('.%s is imported by the %s application', (source, application) => {
    expect(officeSuiteApplication(source)).toBe(application);
  });

  it('knows no application for a format it does not cover', () => {
    expect(officeSuiteApplication('docx')).toBeUndefined();
  });
});
