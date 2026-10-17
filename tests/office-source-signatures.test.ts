import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { assertNotSpoofedFile, FileExtensionSpoofError, isFormatCompatibleWithMagicBytes } from '../src/lib/registry';
import { HEADER_WINDOW_BYTES } from '../src/lib/format-signatures';

/**
 * The drawings the office suite imports (Visio, CorelDRAW, EMF, WMF, CGM) must open with the signature of their own format
 * before they reach it: the suite sniffs the content, so a Word document or a page of HTML under one of these names would be
 * opened as what it is. The signatures are those of the format specifications (MS-EMF 2.2.9, MS-WMF 2.2.2.6 and 2.3.2.2,
 * ISO 8632-3 and -4, MS-CFB, libcdr's `CDRDocument::isSupported`). Each is written here byte by byte from the specification.
 */

const COMPOUND_FILE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const EMF_SIGNATURE = 0x464d4520;

function emfHeader(): Buffer {
  const header = Buffer.alloc(88);
  header.writeUInt32LE(1, 0);
  header.writeUInt32LE(88, 4);
  header.writeUInt32LE(EMF_SIGNATURE, 40);
  return header;
}

function wmfPlaceableHeader(): Buffer {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(0x9ac6cdd7, 0);
  header.writeUInt16LE(1, 22);
  header.writeUInt16LE(9, 24);
  return header;
}

function wmfStandardHeader(type: number): Buffer {
  const header = Buffer.alloc(18);
  header.writeUInt16LE(type, 0);
  header.writeUInt16LE(9, 2);
  header.writeUInt16LE(0x0300, 4);
  return header;
}

function binaryCgmHeader(parameterLength: number): Buffer {
  // The BEGIN METAFILE command: class 0, id 1, then the length of its parameters.
  const header = Buffer.alloc(40);
  header.writeUInt16BE((0 << 12) | (1 << 5) | parameterLength, 0);
  return header;
}

function visioFile(): Buffer {
  return Buffer.concat([COMPOUND_FILE_MAGIC, Buffer.alloc(504), Buffer.from('VisioDocument', 'utf16le'), Buffer.alloc(64)]);
}

function riff(formType: string): Buffer {
  const header = Buffer.alloc(16);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(8, 4);
  header.write(formType, 8, 'latin1');
  return header;
}

async function zipOf(entries: Record<string, string>, mimetype?: string): Promise<Buffer> {
  const zip = new JSZip();
  if (mimetype !== undefined) zip.file('mimetype', mimetype, { compression: 'STORE' });
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Bytes from a fixed sequence, not random, so a failure reproduces. */
function noise(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  let state = 0x2545f491;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    bytes[i] = state >>> 24;
  }
  return bytes;
}

describe('what each format opens with', () => {
  it.each([
    ['EMF header record with the signature at byte 40', emfHeader(), 'emf'],
    ['WMF placeable header', wmfPlaceableHeader(), 'wmf'],
    ['WMF standard header of a memory metafile', wmfStandardHeader(1), 'wmf'],
    ['WMF standard header of a disk metafile', wmfStandardHeader(2), 'wmf'],
    ['binary CGM BEGIN METAFILE with a short parameter list', binaryCgmHeader(20), 'cgm'],
    ['binary CGM BEGIN METAFILE with the longest short-form list', binaryCgmHeader(30), 'cgm'],
    ['clear-text CGM', Buffer.from('BEGMF "drawing";\nMFVERSION 1;\n'), 'cgm'],
    ['clear-text CGM after white space, in lower case', Buffer.from('\n  begmf "drawing";\n'), 'cgm'],
    ['compound file with a VisioDocument stream', visioFile(), 'vsd'],
    ['RIFF with form type CDR6', riff('CDR6'), 'cdr'],
    ['RIFF with form type cdrX', riff('cdrX'), 'cdr'],
  ])('%s passes under the .%s name', (_name, bytes, extension) => {
    expect(isFormatCompatibleWithMagicBytes(bytes, extension)).toBe(true);
  });

  it.each(['content/riffData.cdr', 'content/root.dat'])('a ZIP package with the CorelDRAW entry %s passes under the .cdr name', async (entry) => {
    expect(isFormatCompatibleWithMagicBytes(await zipOf({ 'metadata/metadata.xml': '<x/>', [entry]: 'data' }), 'cdr')).toBe(true);
  });

  it('a compound file that fills the header window with no stream name in it passes on its container signature, as its directory may lie beyond', () => {
    const window = Buffer.concat([COMPOUND_FILE_MAGIC, Buffer.alloc(HEADER_WINDOW_BYTES - COMPOUND_FILE_MAGIC.length)]);
    expect(isFormatCompatibleWithMagicBytes(window, 'vsd')).toBe(true);
  });

  it('a ZIP that continues past the bytes read and starts in a CorelDRAW folder passes, and one that starts elsewhere does not', () => {
    const header = (name: string): Buffer => {
      const bytes = Buffer.alloc(30);
      bytes.writeUInt32LE(0x04034b50, 0);
      bytes.writeUInt32LE(100_000, 18);
      bytes.writeUInt16LE(name.length, 26);
      return Buffer.concat([bytes, Buffer.from(name)]);
    };
    expect(isFormatCompatibleWithMagicBytes(header('content/data/Bitmaps.dat'), 'cdr')).toBe(true);
    expect(isFormatCompatibleWithMagicBytes(header('word/document.xml'), 'cdr')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(header('[Content_Types].xml'), 'cdr')).toBe(false);
  });
});

describe('what is refused under each name', () => {
  const ODF_FLAT_XML = '<?xml version="1.0" encoding="UTF-8"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:mimetype="application/vnd.oasis.opendocument.graphics"><office:body/></office:document>';
  const HTML = '<!DOCTYPE html><html><head><title>t</title></head><body><p>not a drawing</p></body></html>';
  const WORD_97 = Buffer.concat([COMPOUND_FILE_MAGIC, Buffer.alloc(504), Buffer.from('WordDocument', 'utf16le'), Buffer.alloc(64)]);

  const refusals = async (): Promise<ReadonlyArray<[string, Buffer]>> => [
    ['an HTML page', Buffer.from(HTML)],
    ['a flat OpenDocument XML drawing', Buffer.from(ODF_FLAT_XML)],
    ['a Word document (OOXML package)', await zipOf({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>' })],
    ['an OpenDocument text package', await zipOf({ 'content.xml': '<office:document-content/>' }, 'application/vnd.oasis.opendocument.text')],
    ['a Word 97 compound file', WORD_97],
    ['an SVG drawing', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')],
    ['random bytes', noise(4096)],
    ['a PDF', Buffer.from('%PDF-1.7\n%âãÏÓ\n')],
    ['a ZIP of unrelated files', await zipOf({ 'readme.txt': 'hello', 'data/values.csv': 'a,b' })],
  ];

  it.each(['emf', 'wmf', 'cgm', 'vsd', 'cdr'])('under the .%s name', async (extension) => {
    for (const [name, bytes] of await refusals()) {
      expect(isFormatCompatibleWithMagicBytes(bytes, extension), `${name} under .${extension}`).toBe(false);
    }
  });

  it('a file of another drawing format is refused under each name: EMF as WMF, CGM as EMF, a RIFF WAVE as CorelDRAW, a Visio file as CorelDRAW', () => {
    expect(isFormatCompatibleWithMagicBytes(emfHeader(), 'wmf')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(binaryCgmHeader(20), 'emf')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(riff('WAVE'), 'cdr')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(visioFile(), 'cdr')).toBe(false);
  });

  it('an EMF whose signature is missing, a WMF with a header of the wrong size and a CGM that opens with another command are refused', () => {
    const noSignature = emfHeader();
    noSignature.writeUInt32LE(0, 40);
    const wrongSize = wmfStandardHeader(1);
    wrongSize.writeUInt16LE(8, 2);
    const wrongCommand = binaryCgmHeader(20);
    wrongCommand.writeUInt16BE((3 << 5) | 20, 0);
    expect(isFormatCompatibleWithMagicBytes(noSignature, 'emf')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(wrongSize, 'wmf')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(wrongCommand, 'cgm')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(Buffer.from([0x00, 0x1f, 0, 0]), 'cgm')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(Buffer.from([0x00, 0x40, 0, 0]), 'cgm')).toBe(false);
  });

  it('the refusal is the spoof error of the gate, with the format named', async () => {
    const docx = await zipOf({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>' });
    expect(() => assertNotSpoofedFile(docx, 'cdr', 'drawing.cdr')).toThrow(FileExtensionSpoofError);
    expect(() => assertNotSpoofedFile(docx, 'cdr', 'drawing.cdr')).toThrow(/incompatible with declared format "\.cdr"/);
  });
});
