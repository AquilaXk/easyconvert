import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString, decodePDFRawStream } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  formatPdfDate,
  formatXmpDate,
  normalisePdfADates,
  parsePdfDate,
  parseXmpDate,
} from '../src/lib/conversions/pdf-postprocess/pdfa-dates';
import { getOracleToolPath } from './helpers/differential-oracle';
import { buildDocxWithJpeg, makeNoisyJpeg } from './helpers/office-jpeg-fixtures';
import { skipWithoutTools } from './helpers/strict-skip';

function decodeTestPdfDate(raw: string): { epochMs: number; offsetMinutes: number } {
  const m = /^D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:(Z)|([+-])(\d{2})'(\d{2})')$/.exec(raw);
  if (!m) {
    throw new Error(`Invalid PDF date in test oracle: ${raw}`);
  }
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  const offsetMinutes = m[7] === 'Z' ? 0 : (m[8] === '+' ? 1 : -1) * (Number(m[9]) * 60 + Number(m[10]));
  return { epochMs: utc - offsetMinutes * 60_000, offsetMinutes };
}

function decodeTestXmpDate(raw: string): { epochMs: number; offsetMinutes: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:(Z)|([+-])(\d{2}):(\d{2}))$/.exec(raw);
  if (!m) {
    throw new Error(`Invalid XMP date in test oracle: ${raw}`);
  }
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  const offsetMinutes = m[7] === 'Z' ? 0 : (m[8] === '+' ? 1 : -1) * (Number(m[9]) * 60 + Number(m[10]));
  return { epochMs: utc - offsetMinutes * 60_000, offsetMinutes };
}

async function inspectPdfDatesAndMetadata(pdf: Buffer) {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const infoRef = doc.context.trailerInfo.Info;
  const info = infoRef ? doc.context.lookupMaybe(infoRef, PDFDict) : undefined;
  const readInfo = (name: string) => {
    const val = info?.lookup(PDFName.of(name));
    if (val instanceof PDFString || val instanceof PDFHexString) return val.decodeText();
    return undefined;
  };
  const metadata = doc.catalog.lookup(PDFName.of('Metadata'));
  if (!(metadata instanceof PDFRawStream)) {
    throw new Error('Expected uncompressed PDFRawStream /Metadata');
  }
  const hasFilter = Boolean(metadata.dict.lookup(PDFName.of('Filter')));
  const xmp = Buffer.from(decodePDFRawStream(metadata).decode()).toString('utf-8');
  const tag = (name: string) => xmp.match(new RegExp(`<xmp:${name}>([^<]+)<\\/xmp:${name}>`))?.[1];
  const dcDate = xmp.match(/<dc:date>[\s\S]*?<rdf:li>([^<]+)<\/rdf:li>[\s\S]*?<\/dc:date>/)?.[1];

  return {
    infoCreationDate: readInfo('CreationDate'),
    infoModDate: readInfo('ModDate'),
    hasFilter,
    hasTrailerId: Boolean(doc.context.trailerInfo.ID),
    xmpCreateDate: tag('CreateDate'),
    xmpModifyDate: tag('ModifyDate'),
    xmpMetadataDate: tag('MetadataDate'),
    dcDate,
    xmp,
  };
}

async function buildSyntheticLibreOfficePdfA1b(options: {
  infoCreationDate?: string;
  infoModDate?: string;
  xmpCreateDate: string;
  xmpModifyDate: string;
  xmpMetadataDate: string;
  dcDate?: string;
  paddingSpaces?: number;
}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);

  const infoDict = doc.context.obj({});
  if (options.infoCreationDate !== undefined) {
    infoDict.set(PDFName.of('CreationDate'), PDFString.of(options.infoCreationDate));
  }
  if (options.infoModDate !== undefined) {
    infoDict.set(PDFName.of('ModDate'), PDFString.of(options.infoModDate));
  }
  doc.context.trailerInfo.Info = doc.context.register(infoDict);

  const dcBlock = options.dcDate
    ? `  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">\n   <dc:date>\n    <rdf:Seq>\n     <rdf:li>${options.dcDate}</rdf:li>\n    </rdf:Seq>\n   </dc:date>\n  </rdf:Description>\n`
    : '';
  const padding = ' '.repeat(options.paddingSpaces ?? 200);
  const xmp =
    '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n' +
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
    '  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">\n' +
    '   <pdfaid:part>1</pdfaid:part>\n' +
    '   <pdfaid:conformance>B</pdfaid:conformance>\n' +
    '  </rdf:Description>\n' +
    dcBlock +
    '  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">\n' +
    `   <xmp:CreatorTool>Writer</xmp:CreatorTool>\n` +
    `   <xmp:CreateDate>${options.xmpCreateDate}</xmp:CreateDate>\n` +
    `   <xmp:ModifyDate>${options.xmpModifyDate}</xmp:ModifyDate>\n` +
    `   <xmp:MetadataDate>${options.xmpMetadataDate}</xmp:MetadataDate>\n` +
    '  </rdf:Description>\n' +
    ' </rdf:RDF>\n' +
    '</x:xmpmeta>\n' +
    `${padding}\n` +
    '<?xpacket end="w"?>';

  const stream = doc.context.stream(Buffer.from(xmp, 'utf-8'), { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

describe('PDF/A-1b /Info and XMP date normalisation (rule 6.7.3-1)', () => {
  it('validates strict PDF and XMP date calendar and time bounds', () => {
    const valid = parsePdfDate("D:20261105135104+09'00'");
    expect(valid).not.toBeNull();
    expect(formatPdfDate(valid!)).toBe("D:20261105135104+09'00'");
    expect(formatXmpDate(valid!)).toBe('2026-11-05T13:51:04+09:00');
    expect(parseXmpDate('2026-11-05T13:51:04+09:00')?.epochMs).toBe(valid!.epochMs);

    const zOffset = parsePdfDate("D:20260419081530Z00'00'");
    expect(zOffset).not.toBeNull();
    expect(zOffset!.offsetSign).toBe('Z');
    expect(zOffset!.offsetHours).toBe(0);
    expect(zOffset!.offsetMinutes).toBe(0);
    expect(formatPdfDate(zOffset!)).toBe('D:20260419081530Z');
    expect(formatXmpDate(zOffset!)).toBe('2026-04-19T08:15:30Z');

    expect(parsePdfDate('D:20240229120000Z')).not.toBeNull();
    expect(parsePdfDate('D:20260229120000Z')).toBeNull();
    expect(parsePdfDate('D:00000000000000Z')).toBeNull();
    expect(parsePdfDate('D:20261301000000Z')).toBeNull();
    expect(parsePdfDate('D:20261131000000Z')).toBeNull();
    expect(parsePdfDate('D:20261105240000Z')).toBeNull();
    expect(parsePdfDate('D:20261105126000Z')).toBeNull();
    expect(parsePdfDate("D:20261105120000+24'00'")).toBeNull();
    expect(parseXmpDate('0000-00-00T00:00:00+09:00')).toBeNull();
  });

  it('aligns mismatched XMP dates to /Info /CreationDate in-place without changing PDF byte length', async () => {
    const input = await buildSyntheticLibreOfficePdfA1b({
      infoCreationDate: "D:20261105135104+09'00'",
      xmpCreateDate: '2026-01-15T09:30:00+09:00',
      xmpModifyDate: '2026-01-15T09:30:00+09:00',
      xmpMetadataDate: '2026-01-15T09:30:00+09:00',
      dcDate: '2026-01-15T09:30:00+09:00',
    });

    const normalised = await normalisePdfADates(input);
    expect(normalised.length).toBe(input.length);

    const inspected = await inspectPdfDatesAndMetadata(normalised);
    expect(inspected.hasFilter).toBe(false);
    expect(inspected.infoCreationDate).toBe("D:20261105135104+09'00'");
    expect(inspected.xmpCreateDate).toBe('2026-11-05T13:51:04+09:00');
    expect(inspected.xmpModifyDate).toBe('2026-11-05T13:51:04+09:00');
    expect(inspected.xmpMetadataDate).toBe('2026-11-05T13:51:04+09:00');
    expect(inspected.dcDate).toBe('2026-11-05T13:51:04+09:00');

    const pdfDecoded = decodeTestPdfDate(inspected.infoCreationDate!);
    const xmpDecoded = decodeTestXmpDate(inspected.xmpCreateDate!);
    expect(xmpDecoded).toEqual(pdfDecoded);
  });

  it('replaces LibreOffice 24.2 zero XMP dates (0000-00-00) and preserves stream length via XMP padding', async () => {
    const input = await buildSyntheticLibreOfficePdfA1b({
      infoCreationDate: 'D:20261105045104Z',
      xmpCreateDate: '0000-00-00T00:00:00+09:00',
      xmpModifyDate: '0000-00-00T00:00:00+09:00',
      xmpMetadataDate: '0000-00-00T00:00:00+09:00',
      paddingSpaces: 120,
    });

    const normalised = await normalisePdfADates(input);
    expect(normalised.length).toBe(input.length);

    const inspected = await inspectPdfDatesAndMetadata(normalised);
    expect(inspected.hasFilter).toBe(false);
    expect(inspected.infoCreationDate).toBe('D:20261105045104Z');
    expect(inspected.xmpCreateDate).toBe('2026-11-05T04:51:04Z');
    expect(inspected.xmpModifyDate).toBe('2026-11-05T04:51:04Z');
    expect(inspected.xmpMetadataDate).toBe('2026-11-05T04:51:04Z');
    expect(decodeTestXmpDate(inspected.xmpCreateDate!)).toEqual(decodeTestPdfDate(inspected.infoCreationDate!));
  });

  it('adopts the XMP timezone offset and preserves the %PDF-1.4 header when /Info omits a timezone offset', async () => {
    const raw = await buildSyntheticLibreOfficePdfA1b({
      infoCreationDate: 'D:20260419081530',
      xmpCreateDate: '2026-04-19T08:15:30+09:00',
      xmpModifyDate: '2026-04-19T08:15:30+09:00',
      xmpMetadataDate: '2026-04-19T08:15:30+09:00',
    });
    const pdf14 = Buffer.from(raw);
    pdf14.write('%PDF-1.4', 0, 'latin1');

    const normalised = await normalisePdfADates(pdf14);
    expect(normalised.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');

    const inspected = await inspectPdfDatesAndMetadata(normalised);
    expect(inspected.infoCreationDate).toBe("D:20260419081530+09'00'");
    expect(inspected.infoModDate).toBe("D:20260419081530+09'00'");
    expect(inspected.xmpCreateDate).toBe('2026-04-19T08:15:30+09:00');
    expect(inspected.xmpModifyDate).toBe('2026-04-19T08:15:30+09:00');
    expect(decodeTestXmpDate(inspected.xmpCreateDate!)).toEqual(decodeTestPdfDate(inspected.infoCreationDate!));
  });

  it('normalises self-closing rdf:Description XMP packets with attribute or missing xmp:CreateDate', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const infoDict = doc.context.obj({});
    infoDict.set(PDFName.of('CreationDate'), PDFString.of('D:20260419081530Z'));
    infoDict.set(PDFName.of('ModDate'), PDFString.of('D:20260419091530Z'));
    doc.context.trailerInfo.Info = doc.context.register(infoDict);

    const selfClosingXmp =
      '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n' +
      ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
      '  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="1" pdfaid:conformance="B"/>\n' +
      '  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreateDate="2020-01-01T00:00:00Z"/>\n' +
      ' </rdf:RDF>\n' +
      '</x:xmpmeta>\n' +
      '<?xpacket end="w"?>';
    const stream = doc.context.stream(Buffer.from(selfClosingXmp, 'utf-8'), { Type: 'Metadata', Subtype: 'XML' });
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
    const input = Buffer.from(await doc.save({ useObjectStreams: false }));

    const normalised = await normalisePdfADates(input);
    const inspected = await inspectPdfDatesAndMetadata(normalised);
    expect(inspected.xmp).toContain('xmp:CreateDate="2026-04-19T08:15:30Z"');
    expect(inspected.xmp).toContain('xmp:ModifyDate="2026-04-19T09:15:30Z"');
  });

  it('replaces malformed or hostile /Info /CreationDate with the fallback UTC timestamp without throwing', async () => {
    const fallbackNow = new Date('2026-11-05T06:07:08Z');
    for (const hostileDate of ['not-a-pdf-date', 'D:00000000000000Z', 'D:20260230120000Z', `D:${'9'.repeat(400)}`]) {
      const input = await buildSyntheticLibreOfficePdfA1b({
        infoCreationDate: hostileDate,
        infoModDate: 'also-invalid',
        xmpCreateDate: '0000-00-00T00:00:00+09:00',
        xmpModifyDate: '0000-00-00T00:00:00+09:00',
        xmpMetadataDate: '0000-00-00T00:00:00+09:00',
      });

      const normalised = await normalisePdfADates(input, fallbackNow);
      const inspected = await inspectPdfDatesAndMetadata(normalised);
      expect(inspected.hasFilter).toBe(false);
      expect(inspected.hasTrailerId).toBe(true);
      expect(inspected.infoCreationDate).toBe('D:20261105060708Z');
      expect(inspected.infoModDate).toBe('D:20261105060708Z');
      expect(inspected.xmpCreateDate).toBe('2026-11-05T06:07:08Z');
      expect(inspected.xmpModifyDate).toBe('2026-11-05T06:07:08Z');
      expect(decodeTestXmpDate(inspected.xmpCreateDate!)).toEqual(decodeTestPdfDate(inspected.infoCreationDate!));
    }
  });

  it.skipIf(skipWithoutTools('soffice'))(
    'normalises a real LibreOffice PDF/A-1b export while keeping embedded JPEG stream bytes untouched',
    async () => {
      const soffice = getOracleToolPath('soffice')!;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfa-1b-dates-'));
      try {
        const jpeg = await makeNoisyJpeg();
        const docx = await buildDocxWithJpeg(jpeg);
        const inputPath = path.join(dir, 'fixture.docx');
        fs.writeFileSync(inputPath, docx);
        const filter =
          'pdf:writer_pdf_Export:{"ReduceImageResolution":{"type":"boolean","value":"false"},' +
          '"Quality":{"type":"long","value":"100"},"ExportBookmarks":{"type":"boolean","value":"true"},' +
          '"SelectPdfVersion":{"type":"long","value":"1"}}';
        execFileSync(
          soffice,
          [
            '--headless',
            '--norestore',
            `-env:UserInstallation=file://${path.join(dir, 'profile')}`,
            '--convert-to',
            filter,
            '--outdir',
            dir,
            inputPath,
          ],
          { timeout: 60_000, stdio: 'ignore' }
        );
        const rawExport = fs.readFileSync(path.join(dir, 'fixture.pdf'));

        const corruptedXmpExport = Buffer.from(
          rawExport
            .toString('latin1')
            .replace(/<xmp:CreateDate>[^<]{25}<\/xmp:CreateDate>/, '<xmp:CreateDate>0000-00-00T00:00:00+09:00</xmp:CreateDate>')
            .replace(/<xmp:ModifyDate>[^<]{25}<\/xmp:ModifyDate>/, '<xmp:ModifyDate>0000-00-00T00:00:00+09:00</xmp:ModifyDate>'),
          'latin1'
        );

        const normalised = await normalisePdfADates(corruptedXmpExport);
        expect(normalised.length).toBe(rawExport.length);
        expect(normalised.includes(jpeg)).toBe(true);

        const inspected = await inspectPdfDatesAndMetadata(normalised);
        expect(inspected.hasFilter).toBe(false);
        expect(decodeTestXmpDate(inspected.xmpCreateDate!)).toEqual(decodeTestPdfDate(inspected.infoCreationDate!));
        expect(decodeTestXmpDate(inspected.xmpModifyDate!)).toEqual(decodeTestPdfDate(inspected.infoCreationDate!));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000
  );
});
