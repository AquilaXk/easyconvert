import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { hasMacros, oleApplication, ooxmlApplication, pdfProducer, producerClass, producerOf } from '../bench/realworld/regression/producer';
import { buildCompoundFile } from './helpers/cfb-craft';

/**
 * Producer metadata of the regression corpus: the application that wrote a PDF, an OLE document or an OOXML package. Every
 * input is built here with a writer that is not the reader under test (pdf-lib, JSZip, the compound-file writer of the tests,
 * hand-written bytes), and the expected strings are the ones written into them.
 */

const OLE_PIDSI_APPNAME = 0x12;
const OLE_PIDSI_CODEPAGE = 0x01;
const VT_I2 = 0x02;
const VT_LPSTR = 0x1e;
const SUMMARY_INFORMATION = '\u0005SummaryInformation';
const CFB_SECTOR_BYTES = 512;
const CFB_DIRECTORY_ENTRY_BYTES = 128;

/** A property set stream (MS-OLEPS) with a code page and an application name, written byte by byte. */
function summaryInformation(appName: string, codePage = 1252): Buffer {
  const name = Buffer.concat([Buffer.from(appName, 'latin1'), Buffer.from([0])]);
  const nameValue = Buffer.alloc(8 + name.length);
  nameValue.writeUInt32LE(VT_LPSTR, 0);
  nameValue.writeUInt32LE(name.length, 4);
  name.copy(nameValue, 8);
  const pageValue = Buffer.alloc(8);
  pageValue.writeUInt16LE(VT_I2, 0);
  pageValue.writeUInt16LE(codePage, 4);
  const sectionHeader = 8 + 2 * 8;
  const pageOffset = sectionHeader;
  const nameOffset = pageOffset + pageValue.length;
  const section = Buffer.alloc(sectionHeader);
  section.writeUInt32LE(nameOffset + nameValue.length, 0);
  section.writeUInt32LE(2, 4);
  section.writeUInt32LE(OLE_PIDSI_CODEPAGE, 8);
  section.writeUInt32LE(pageOffset, 12);
  section.writeUInt32LE(OLE_PIDSI_APPNAME, 16);
  section.writeUInt32LE(nameOffset, 20);
  const header = Buffer.alloc(48);
  header.writeUInt16LE(0xfffe, 0);
  header.writeUInt32LE(1, 24);
  header.writeUInt32LE(header.length, 44);
  return Buffer.concat([header, section, pageValue, nameValue]);
}

const pdfWith = (bytes: string): Buffer => Buffer.from(`%PDF-1.4\n${bytes}\n%%EOF\n`, 'latin1');

describe('PDF producer', () => {
  it('reads the Producer a PDF writer put in the Info dictionary', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage();
    doc.setProducer('Acme Print Engine 4.2 (Win32)');
    doc.setCreator('Acme Writer');
    expect(pdfProducer(Buffer.from(await doc.save({ useObjectStreams: false })))).toBe('Acme Print Engine 4.2 (Win32)');
  });

  it('falls back to the Creator when the Producer is empty or absent', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage();
    doc.setCreator('Acme Writer 7');
    expect(pdfProducer(Buffer.from(await doc.save({ useObjectStreams: false })))).toBe('Acme Writer 7');
    expect(pdfProducer(pdfWith('1 0 obj << /Producer () /Creator (Only Creator) >> endobj'))).toBe('Only Creator');
  });

  it('reads escaped and nested parentheses in a literal string', () => {
    expect(pdfProducer(pdfWith(String.raw`1 0 obj << /Producer (Tool \(beta\) (build 7) \\ end) >> endobj`))).toBe(String.raw`Tool (beta) (build 7) \ end`);
  });

  it('reads a hexadecimal string, plain and as UTF-16 with a byte order mark', () => {
    const plain = Buffer.from('Hex Writer 1.0', 'latin1').toString('hex');
    expect(pdfProducer(pdfWith(`1 0 obj << /Producer <${plain}> >> endobj`))).toBe('Hex Writer 1.0');
    const wide = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('Wide Writer', 'utf16le').swap16()]).toString('hex');
    expect(pdfProducer(pdfWith(`1 0 obj << /Producer <${wide}> >> endobj`))).toBe('Wide Writer');
  });

  it('reads a UTF-16 string that ends in half a character without failing', () => {
    const odd = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('Odd', 'utf16le').swap16(), Buffer.from([0x00])]).toString('hex');
    expect(pdfProducer(pdfWith(`1 0 obj << /Producer <${odd}> >> endobj`))).toBe('Odd');
  });

  it('takes the last Info dictionary, which is the one an incremental update wrote', () => {
    const bytes = pdfWith('1 0 obj << /Producer (First Writer) >> endobj\n5 0 obj << /Producer (Second Writer) >> endobj');
    expect(pdfProducer(bytes)).toBe('Second Writer');
  });

  it('reads an octal escape as the byte it names', () => {
    expect(pdfProducer(pdfWith(String.raw`1 0 obj << /Producer (Microsoft\256 Office Word 2007) >> endobj`))).toBe('Microsoft\u00ae Office Word 2007');
  });

  it('reads bytes that are valid UTF-8 as UTF-8 and any other bytes as Latin-1', () => {
    const utf8 = Buffer.from('Microsoft\u00ae Word 2016', 'utf8').toString('latin1');
    expect(pdfProducer(pdfWith(`1 0 obj << /Producer (${utf8}) >> endobj`))).toBe('Microsoft\u00ae Word 2016');
    expect(pdfProducer(pdfWith('1 0 obj << /Producer (Caf\xe9 Writer) >> endobj'))).toBe('Caf\u00e9 Writer');
  });

  it('reads the XMP packet when the Info dictionary names no producer', () => {
    expect(pdfProducer(pdfWith('<x:xmpmeta><rdf:Description><pdf:Producer>XMP Writer 3</pdf:Producer></rdf:Description></x:xmpmeta>'))).toBe('XMP Writer 3');
  });

  it('answers null for a file without producer metadata and for text that is not printable', () => {
    expect(pdfProducer(pdfWith('1 0 obj << /Title (x) >> endobj'))).toBeNull();
    expect(pdfProducer(pdfWith('1 0 obj << /Producer <00010203ff> >> endobj'))).toBeNull();
    expect(pdfProducer(Buffer.from('not a pdf at all'))).toBeNull();
  });

  it('cuts a very long producer to a bounded length', () => {
    const producer = pdfProducer(pdfWith(`1 0 obj << /Producer (${'x'.repeat(500)}) >> endobj`));
    expect(producer).toHaveLength(120);
  });
});

describe('OLE document application', () => {
  it('reads the application name of the SummaryInformation stream', () => {
    const file = buildCompoundFile([
      { name: 'WordDocument', data: Buffer.alloc(5000, 1) },
      { name: SUMMARY_INFORMATION, data: summaryInformation('Microsoft Word 10.0') },
    ]);
    expect(oleApplication(file)).toBe('Microsoft Word 10.0');
  });

  it('decodes a Windows-1252 name', () => {
    const file = buildCompoundFile([{ name: SUMMARY_INFORMATION, data: summaryInformation('Café Writer', 1252) }]);
    expect(oleApplication(file)).toBe('Café Writer');
  });

  it('answers null when the stream or the property is missing and for bytes that are not a compound file', () => {
    expect(oleApplication(buildCompoundFile([{ name: 'WordDocument', data: Buffer.alloc(100, 1) }]))).toBeNull();
    expect(oleApplication(Buffer.from('plain text'))).toBeNull();
    const truncated = buildCompoundFile([{ name: SUMMARY_INFORMATION, data: summaryInformation('Microsoft Excel') }]).subarray(0, 700);
    expect(oleApplication(truncated)).toBeNull();
  });

  it('stops at a sector chain that loops back on itself while the stream claims to be far longer than the file', () => {
    const file = Buffer.from(buildCompoundFile([{ name: SUMMARY_INFORMATION, data: summaryInformation('Looping Writer') }]));
    const fatSector = file.readUInt32LE(76);
    file.writeUInt32LE(0, CFB_SECTOR_BYTES + fatSector * CFB_SECTOR_BYTES);
    const streamEntry = CFB_SECTOR_BYTES + CFB_DIRECTORY_ENTRY_BYTES;
    file.writeUInt32LE(0, streamEntry + 116);
    file.writeUInt32LE(0xfffffff0, streamEntry + 120);
    expect(oleApplication(file)).toBeNull();
  });
});

describe('OOXML package application', () => {
  const appXml = (application: string, version?: string): string =>
    `<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>${application}</Application>${version ? `<AppVersion>${version}</AppVersion>` : ''}</Properties>`;

  async function packageWith(files: Record<string, string>): Promise<Buffer> {
    const zip = new JSZip();
    for (const [name, content] of Object.entries(files)) zip.file(name, content);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  it('reads Application and AppVersion of docProps/app.xml', async () => {
    expect(ooxmlApplication(await packageWith({ 'docProps/app.xml': appXml('Microsoft Office Word', '12.0000') }))).toBe('Microsoft Office Word 12.0000');
    expect(ooxmlApplication(await packageWith({ 'docProps/app.xml': appXml('LibreOffice/7.3 &amp; co') }))).toBe('LibreOffice/7.3 & co');
  });

  it('answers null without app.xml, without an Application and for bytes that are not a zip', async () => {
    expect(ooxmlApplication(await packageWith({ 'word/document.xml': '<w:document/>' }))).toBeNull();
    expect(ooxmlApplication(await packageWith({ 'docProps/app.xml': '<Properties/>' }))).toBeNull();
    expect(ooxmlApplication(Buffer.from('plain text'))).toBeNull();
  });

  it('does not inflate an app.xml that claims to be larger than a property part can be', async () => {
    const huge = `<Properties><Application>X</Application><Comment>${'a'.repeat(3 * 1024 * 1024)}</Comment></Properties>`;
    expect(ooxmlApplication(await packageWith({ 'docProps/app.xml': huge }))).toBeNull();
  });
});

describe('producerOf and hasMacros', () => {
  it('picks the reader by the format of the file', async () => {
    const zip = new JSZip();
    zip.file('docProps/app.xml', '<Properties><Application>Writer X</Application></Properties>');
    expect(producerOf('docx', await zip.generateAsync({ type: 'nodebuffer' }))).toBe('Writer X');
    expect(producerOf('doc', buildCompoundFile([{ name: SUMMARY_INFORMATION, data: summaryInformation('Microsoft Word 9.0') }]))).toBe('Microsoft Word 9.0');
    expect(producerOf('pdf', pdfWith('1 0 obj << /Producer (P) >> endobj'))).toBe('P');
  });

  it('answers null for a format without a reader', () => {
    expect(producerOf('csv', Buffer.from('a,b'))).toBeNull();
  });

  it('finds the Visual Basic storage of an OLE document and the project part of an OOXML package', async () => {
    expect(hasMacros('doc', buildCompoundFile([{ name: 'Macros/VBA/dir', data: Buffer.alloc(40, 1) }, { name: 'WordDocument', data: Buffer.alloc(40, 2) }]))).toBe(true);
    expect(hasMacros('doc', buildCompoundFile([{ name: 'WordDocument', data: Buffer.alloc(40, 2) }]))).toBe(false);
    const zip = new JSZip();
    zip.file('word/vbaProject.bin', 'x');
    zip.file('word/document.xml', '<w:document/>');
    expect(hasMacros('docx', await zip.generateAsync({ type: 'nodebuffer' }))).toBe(true);
    const clean = new JSZip();
    clean.file('word/document.xml', '<w:document/>');
    expect(hasMacros('docx', await clean.generateAsync({ type: 'nodebuffer' }))).toBe(false);
  });

  it('finds script actions in a PDF', () => {
    expect(hasMacros('pdf', pdfWith('1 0 obj << /S /JavaScript /JS (app.alert(1)) >> endobj'))).toBe(true);
    expect(hasMacros('pdf', pdfWith('1 0 obj << /S /Launch /F (cmd.exe) >> endobj'))).toBe(true);
    expect(hasMacros('pdf', pdfWith('1 0 obj << /Type /Catalog >> endobj'))).toBe(false);
  });
});

describe('producer class', () => {
  const cases: Array<[string | null, string]> = [
    ['Microsoft Word 10.0', 'microsoft-word'],
    ['Microsoft Office Word 12.0000', 'microsoft-word'],
    ['Microsoft® Office Word 2007', 'microsoft-word'],
    ['Microsoft Excel', 'microsoft-excel'],
    ['Microsoft PowerPoint 9.0', 'microsoft-powerpoint'],
    ['Adobe PDF Library 15.0', 'adobe-pdf-library'],
    ['Acrobat Distiller 9.0.0 (Windows)', 'acrobat-distiller'],
    ['Adobe Acrobat Distiller 6.0 (Windows)', 'acrobat-distiller'],
    ['Acrobat PDFMaker 8.1 for Word', 'acrobat-pdfmaker'],
    ['Adobe InDesign CC 2015 (Macintosh)', 'adobe-indesign'],
    ['Mac OS X 10.6.8 Quartz PDFContext', 'macos-quartz'],
    ['GPL Ghostscript 9.05', 'ghostscript'],
    ['pdfTeX-1.40.3', 'tex'],
    ['LibreOffice 5.0', 'openoffice-family'],
    ['OpenOffice.org 2.4', 'openoffice-family'],
    ['TCPDF 6.2.11 (http://www.tcpdf.org)', 'tcpdf'],
    ['iText 2.1.7 by 1T3XT', 'itext'],
    ['Skia/PDF m91', 'skia-pdf'],
    ['', 'unknown'],
    [null, 'unknown'],
    ['   ', 'unknown'],
    ['Zeta Press 3.1.4', 'zeta-press'],
    ['Zeta Press 9.0', 'zeta-press'],
    ['ZETA   PRESS v2', 'zeta-press'],
  ];

  it.each(cases)('maps %j to %s', (raw, expected) => {
    expect(producerClass(raw)).toBe(expected);
  });

  it('keeps the class of an unknown writer short and made of safe characters', () => {
    const cls = producerClass('A Very Long Producer Name That Goes On And On And On For Far Too Many Characters 1.0');
    expect(cls.length).toBeLessThanOrEqual(24);
    expect(cls).toMatch(/^[a-z0-9-]+$/);
  });
});
