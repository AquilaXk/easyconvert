import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Job } from '@/lib/queue/bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '@/lib/types';
import { PdfPasswordRequiredError } from '@/lib/types';
import { PdfStructureError } from '@/lib/conversions/pdf-values';
import { processGraphNodeJob } from '@/lib/queue/graph/node-executor';
import { graphNodeCharge, graphNodeReservedUnits } from '@/lib/jobs/graph-operations';
import { MetadataFieldError, MetadataWriteUnsupportedError } from '@/lib/jobs/metadata/errors';
import { readMetadata, pdfDateToExif, isoDateToExif } from '@/lib/jobs/metadata/read';
import { writeMetadata } from '@/lib/jobs/metadata/write';
import { readEmbeddedBlocks } from '@/lib/jobs/metadata/image-blocks';
import { s3Storage } from '@/lib/storage/s3-storage';
import { refusalCodeOf } from '@/lib/refusal-codes';
import { skipWithoutTools } from './helpers/strict-skip';
import { runWithoutFileConfinement } from './helpers/unconfined-files';

/**
 * The metadata tasks: `metadata` reads a report in groups with ExifTool's field names; `metadata.write` writes fields into a JPEG,
 * a PNG or a PDF without changing anything else in the file, and refuses every other format with a coded 422.
 */

// The stand-in ffprobe of this suite is read from the temporary directory, outside the job directory the confinement allows.
runWithoutFileConfinement();

const ARTIFACT_TTL_MS = 60 * 60 * 1000;
const SPY_MODE = 0o755;

let seq = 0;

function nodeJob(graphNode: Record<string, unknown>, inputArtifacts: string[]) {
  seq += 1;
  const graphId = `g_meta_${Date.now()}_${seq}`;
  return {
    id: `${graphId}:n1`,
    data: { jobId: `${graphId}:n1`, sourceFormat: 'bin', targetFormat: 'bin', fileSize: 0, options: {}, graphId, graphNodeId: 'n1', graphNode, inputArtifacts },
    opts: { attempts: 1 },
    attemptsMade: 1,
    signal: new AbortController().signal,
    log: async () => {},
    updateProgress: async () => {},
  } as unknown as Job<ConversionJobData, ConversionJobResult>;
}

function seed(name: string, buffer: Buffer, mimeType: string): string {
  const key = `tests/metadata-task/${Date.now()}_${seq}_${name}`;
  s3Storage.saveObject(key, buffer, mimeType, name, ARTIFACT_TTL_MS);
  return key;
}

function output(key: string): Buffer {
  const stored = s3Storage.getObject(key);
  if (!stored) throw new Error(`Output "${key}" is missing`);
  return stored.buffer;
}

async function jpegWithExif(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: '#3a7' } })
    .jpeg({ quality: 90 })
    .withExif({ IFD0: { Make: 'Acme', Model: 'Cam 1' } })
    .toBuffer();
}

const plainPng = (): Promise<Buffer> => sharp({ create: { width: 10, height: 10, channels: 4, background: '#fff' } }).png().toBuffer();

const pixels = (file: Buffer): Promise<Buffer> => sharp(file).raw().toBuffer();

async function pdfBytes(configure?: (doc: PDFDocument) => void): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]).drawText('page one', { x: 20, y: 20 });
  doc.addPage([200, 300]);
  configure?.(doc);
  return Buffer.from(await doc.save({ updateFieldAppearances: false }));
}

describe('reading metadata', () => {
  it('reports a JPEG by group with the names ExifTool prints, GPS as signed degrees', async () => {
    const written = await writeMetadata(await jpegWithExif(), 'a.jpg', {
      Artist: 'Ann',
      DateTimeOriginal: '2026:11:12 10:00:00',
      GPSLatitude: 37.5665,
      GPSLongitude: -126.978,
      GPSAltitude: 38.5,
      'XMP:Title': 'Hello & <bye>',
      'XMP:Creator': ['Ann', 'Bob'],
    });
    const report = await readMetadata(written.buffer, 'a.jpg');
    expect(report).toMatchObject({
      schemaVersion: 1,
      File: { FileName: 'a.jpg', FileSize: written.buffer.length, FileType: 'JPG', MIMEType: 'image/jpeg', Category: 'image' },
      Image: { ImageWidth: 64, ImageHeight: 48, ColorSpace: 'srgb', BitsPerSample: 8 },
      EXIF: { Make: 'Acme', Model: 'Cam 1', Artist: 'Ann', DateTimeOriginal: '2026:11:12 10:00:00' },
      GPS: { GPSLatitude: 37.5665, GPSLongitude: -126.978, GPSAltitude: 38.5 },
      XMP: { Title: 'Hello & <bye>', Creator: ['Ann', 'Bob'] },
    });
    expect(Object.keys(report.File)).not.toContain('storageKey');
  });

  it('gives the same report for the same bytes: nothing in it depends on the time of the call', async () => {
    const png = await plainPng();
    expect(await readMetadata(png, 'x.png')).toEqual(await readMetadata(png, 'x.png'));
  });

  it('reads the properties of a PDF: version, pages, first page size, information dictionary and its dates', async () => {
    const pdf = await pdfBytes((doc) => {
      doc.setTitle('Quarterly');
      doc.setAuthor('Dana');
      doc.setKeywords(['a', 'b']);
      doc.setCreationDate(new Date('2026-01-02T03:04:05Z'));
    });
    const { PDF } = await readMetadata(pdf, 'q.pdf');
    expect(PDF).toMatchObject({ PDFVersion: '1.7', PageCount: 2, PageWidth: 300, PageHeight: 200, Title: 'Quarterly', Author: 'Dana', Keywords: 'a b' });
    expect(PDF).toMatchObject({ CreateDate: '2026:01:02 03:04:05+00:00' });
  });

  it('reads the properties of an OOXML document and of an OpenDocument file', async () => {
    const docx = new JSZip();
    docx.file('docProps/core.xml', '<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><dc:title>Plan</dc:title><dc:creator>Kim</dc:creator><cp:lastModifiedBy>Lee</cp:lastModifiedBy><dcterms:created>2026-03-04T05:06:07Z</dcterms:created><cp:revision>4</cp:revision></cp:coreProperties>');
    docx.file('docProps/app.xml', '<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Writer</Application><Pages>3</Pages><Words>120</Words></Properties>');
    const odt = new JSZip();
    odt.file('meta.xml', '<?xml version="1.0"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><office:meta><dc:title>Notes</dc:title><meta:initial-creator>Kim</meta:initial-creator><meta:creation-date>2026-03-04T05:06:07.123</meta:creation-date><meta:document-statistic meta:page-count="2" meta:word-count="40"/></office:meta></office:document-meta>');
    const docxReport = await readMetadata(await docx.generateAsync({ type: 'nodebuffer' }), 'plan.docx');
    expect(docxReport.Document as object).toEqual({ Title: 'Plan', Creator: 'Kim', LastModifiedBy: 'Lee', CreateDate: '2026:03:04 05:06:07+00:00', RevisionNumber: 4, Application: 'Writer', Pages: 3, Words: 120 });
    const odtReport = await readMetadata(await odt.generateAsync({ type: 'nodebuffer' }), 'notes.odt');
    expect(odtReport.Document as object).toEqual({ Title: 'Notes', Creator: 'Kim', CreateDate: '2026:03:04 05:06:07', Pages: 2, Words: 40 });
  });

  it('says a part could not be read in File.Warning and still reports the file', async () => {
    const report = await readMetadata(Buffer.from('not a jpeg'), 'broken.jpg');
    expect(report.File).toMatchObject({ FileName: 'broken.jpg', FileSize: 10 });
    expect(String(report.File.Warning)).toMatch(/JPG content could not be read/);
    expect(report).not.toHaveProperty('Image');
  });

  it('writes a date the way ExifTool does', () => {
    expect(pdfDateToExif("D:20260102030405+09'00'")).toBe('2026:01:02 03:04:05+09:00');
    expect(pdfDateToExif('D:2026')).toBe('2026:01:01 00:00:00');
    expect(isoDateToExif('2026-01-02T03:04:05.250-0500')).toBe('2026:01:02 03:04:05-05:00');
    expect(isoDateToExif('yesterday')).toBe('yesterday');
  });

  describe('media streams', () => {
    let dir = '';
    beforeAll(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'easyconvert-metadata-ffprobe-'));
      const report = JSON.stringify({
        format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '12.5', bit_rate: '800000', tags: { title: 'Clip', creation_time: '2026-05-06T07:08:09.000000Z' } },
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264', profile: 'High', width: 640, height: 360, r_frame_rate: '30000/1001', bit_rate: '700000', tags: { language: 'und' } },
          { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000', tags: { language: 'eng', title: 'Main' } },
        ],
      });
      const ffprobe = path.join(dir, 'ffprobe');
      writeFileSync(ffprobe, `#!/bin/sh\ncase "$*" in *-show_format*) cat <<'JSON'\n${report}\nJSON\n;; *) echo "ffprobe version stand-in";; esac\n`);
      chmodSync(ffprobe, SPY_MODE);
      vi.stubEnv('FFPROBE_PATH', ffprobe);
    });
    afterAll(() => {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    });

    it('reports the container and each stream of a media file from the probe', async () => {
      const report = await readMetadata(Buffer.from('stand-in video bytes ftypmp42'), 'clip.mp4');
      expect(report.Media).toEqual({ Format: 'mov,mp4,m4a,3gp,3g2,mj2', Duration: 12.5, BitRate: 800000, StreamCount: 2, Title: 'Clip', CreationTime: '2026:05:06 07:08:09+00:00' });
      expect(report.Streams).toEqual([
        { Index: 0, Type: 'video', Codec: 'h264', Profile: 'High', Width: 640, Height: 360, FrameRate: 29.97, BitRate: 700000, Language: 'und' },
        { Index: 1, Type: 'audio', Codec: 'aac', ChannelCount: 2, SampleRate: 48000, Language: 'eng', Title: 'Main' },
      ]);
    });
  });
});

describe('writing metadata', () => {
  it('writes EXIF and XMP into a JPEG and leaves the picture byte for byte what it was', async () => {
    const source = await jpegWithExif();
    const written = await writeMetadata(source, 'photo.jpg', { Artist: 'Ann', Copyright: '(c) 2026', 'XMP:Title': 'Title' });
    expect(written).toMatchObject({ filename: 'photo.jpg', mimeType: 'image/jpeg' });
    expect((await pixels(written.buffer)).equals(await pixels(source))).toBe(true);
    // The scan data after the headers is not touched at all.
    const scan = (file: Buffer): Buffer => file.subarray(file.indexOf(Buffer.from([0xff, 0xda])));
    expect(scan(written.buffer).equals(scan(source))).toBe(true);
    const report = await readMetadata(written.buffer, 'photo.jpg');
    expect(report.EXIF).toMatchObject({ Make: 'Acme', Model: 'Cam 1', Artist: 'Ann', Copyright: '(c) 2026' });
    expect(report.XMP).toEqual({ Title: 'Title' });
  });

  it('writes into a PNG and keeps its pixels, and writing twice keeps one block of each kind', async () => {
    const source = await plainPng();
    const once = await writeMetadata(source, 'p.png', { Artist: 'Zed', 'XMP:Title': 'T' });
    const twice = await writeMetadata(once.buffer, 'p.png', { Artist: 'Yan' });
    expect((await pixels(twice.buffer)).equals(await pixels(source))).toBe(true);
    expect((await readMetadata(twice.buffer, 'p.png')).EXIF).toEqual({ Artist: 'Yan' });
    expect(twice.buffer.toString('latin1').split('eXIf')).toHaveLength(2);
    expect(readEmbeddedBlocks(twice.buffer, 'png').xmp).toContain('<rdf:li xml:lang="x-default">T</rdf:li>');
  });

  it('removes a field set to null', async () => {
    const withArtist = await writeMetadata(await plainPng(), 'p.png', { Artist: 'Zed', Copyright: 'c' });
    const removed = await writeMetadata(withArtist.buffer, 'p.png', { Artist: null });
    expect((await readMetadata(removed.buffer, 'p.png')).EXIF).toEqual({ Copyright: 'c' });
  });

  it('refuses to write XMP into a picture that holds an XMP packet already, since that would drop its other properties', async () => {
    const first = await writeMetadata(await plainPng(), 'p.png', { 'XMP:Title': 'T' });
    const run = writeMetadata(first.buffer, 'p.png', { 'XMP:Description': 'D' });
    await expect(run).rejects.toBeInstanceOf(MetadataWriteUnsupportedError);
    await expect(run).rejects.toThrow(/already carries an XMP packet/);
  });

  it.each(['webp', 'gif', 'tiff', 'heic', 'docx', 'odt', 'mp4', 'mp3', 'txt', 'svg'])('refuses a .%s file with the coded 422 and names the formats it writes', async (ext) => {
    const run = writeMetadata(Buffer.from('bytes'), `file.${ext}`, { Artist: 'x' });
    await expect(run).rejects.toBeInstanceOf(MetadataWriteUnsupportedError);
    await expect(run).rejects.toThrow(/jpg, jpeg, png, pdf/);
    const error = await run.catch((caught: unknown) => caught);
    expect(refusalCodeOf(error)).toBe('metadata_write_unsupported');
    expect((error as { status: number }).status).toBe(422);
  });

  it.each([
    [{ Nonsense: 'x' }, /not a field that can be written/],
    [{ 'PDF:Title': 'x' }, /not a field that can be written/],
    [{ Orientation: 12 }, /Orientation/],
    [{ 'XMP:Title': null }, /takes text/],
    [{ Artist: ['a', 'b'] }, /one value/],
    [{ 'XMP:Title': 'bell\u0007' }, /XML cannot carry/],
    [{}, /sets no field/],
  ])('refuses %j in a JPEG with the field error', async (edits, message) => {
    const run = writeMetadata(await jpegWithExif(), 'a.jpg', edits as Record<string, string>);
    await expect(run).rejects.toBeInstanceOf(MetadataFieldError);
    await expect(run).rejects.toThrow(message);
    expect(refusalCodeOf(await run.catch((caught: unknown) => caught))).toBe('metadata_field_invalid');
  });

  it('refuses a JPEG that is cut short instead of writing into it', async () => {
    const run = writeMetadata((await jpegWithExif()).subarray(0, 30), 'a.jpg', { Artist: 'x' });
    await expect(run).rejects.toBeInstanceOf(MetadataWriteUnsupportedError);
    await expect(run).rejects.toThrow(/cut short.*metadata is not changed/);
  });

  it('sets the information dictionary of a PDF, keeps the pages, and does not stamp its own producer or date', async () => {
    const source = await pdfBytes((doc) => {
      doc.setProducer('Original Producer');
      doc.setModificationDate(new Date('2020-01-01T00:00:00Z'));
    });
    const written = await writeMetadata(source, 'd.pdf', { Title: 'T', Author: 'A', Keywords: ['k1', 'k2'], CreateDate: '2026:03:04 05:06:07+09:00' });
    expect(written.mimeType).toBe('application/pdf');
    const doc = await PDFDocument.load(written.buffer, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(0).getSize()).toEqual({ width: 300, height: 200 });
    const { PDF } = await readMetadata(written.buffer, 'd.pdf');
    expect(PDF).toMatchObject({ Title: 'T', Author: 'A', Keywords: 'k1, k2', Producer: 'Original Producer', CreateDate: '2026:03:03 20:06:07+00:00', ModifyDate: '2020:01:01 00:00:00+00:00' });
  });

  it('writes non-Latin text into a PDF and reads it back', async () => {
    const written = await writeMetadata(await pdfBytes(), 'd.pdf', { Title: '분기 보고서', Subject: '日本語' });
    expect((await readMetadata(written.buffer, 'd.pdf')).PDF).toMatchObject({ Title: '분기 보고서', Subject: '日本語' });
  });

  it('removes a PDF field set to null', async () => {
    const titled = await writeMetadata(await pdfBytes(), 'd.pdf', { Title: 'T', Author: 'A' });
    const removed = await writeMetadata(titled.buffer, 'd.pdf', { Author: null });
    const { PDF } = await readMetadata(removed.buffer, 'd.pdf');
    expect(PDF).toMatchObject({ Title: 'T' });
    expect(PDF).not.toHaveProperty('Author');
  });

  it.each([
    [{ Width: 'x' }, /not a PDF field/],
    [{ 'EXIF:Artist': 'x' }, /not a PDF field/],
    [{ CreateDate: 'last week' }, /takes a date/],
  ])('refuses %j in a PDF', async (edits, message) => {
    const run = writeMetadata(await pdfBytes(), 'd.pdf', edits);
    await expect(run).rejects.toBeInstanceOf(MetadataFieldError);
    await expect(run).rejects.toThrow(message);
  });

  it('refuses a PDF whose structure cannot be read, without writing it', async () => {
    const run = writeMetadata(Buffer.from('%PDF-1.4 nothing'), 'd.pdf', { Title: 'x' });
    await expect(run).rejects.toBeInstanceOf(PdfStructureError);
    await expect(run).rejects.toThrow(/startxref/);
  });
});

describe.skipIf(skipWithoutTools('qpdf'))('writing metadata into an encrypted PDF', () => {
  it('needs the password, as every PDF edit does', async () => {
    const { execFileSync } = await import('node:child_process');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'easyconvert-metadata-qpdf-'));
    try {
      writeFileSync(path.join(dir, 'in.pdf'), await pdfBytes());
      execFileSync('qpdf', ['--encrypt', 'user', 'owner', '256', '--', path.join(dir, 'in.pdf'), path.join(dir, 'out.pdf')]);
      const locked = (await import('node:fs')).readFileSync(path.join(dir, 'out.pdf'));
      await expect(writeMetadata(locked, 'd.pdf', { Title: 'x' })).rejects.toBeInstanceOf(PdfPasswordRequiredError);
      const opened = await writeMetadata(locked, 'd.pdf', { Title: 'x' }, { password: 'user', confirmEditRights: true });
      expect((await readMetadata(opened.buffer, 'd.pdf')).PDF).toMatchObject({ Title: 'x', PageCount: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('metadata nodes of a graph', () => {
  afterEach(() => vi.restoreAllMocks());

  it('metadata writes metadata.json with the grouped report', async () => {
    const input = seed('photo.png', await plainPng(), 'image/png');
    const result = await processGraphNodeJob(nodeJob({ op: 'metadata' }, [input]), undefined, s3Storage);
    expect(result.filename).toBe('metadata.json');
    expect(JSON.parse(output(result.resultKey).toString('utf8'))).toMatchObject({ schemaVersion: 1, File: { FileName: 'photo.png' }, Image: { ImageWidth: 10 } });
  });

  it('metadata.write makes one file for each input, under the name it had', async () => {
    const png = seed('p.png', await plainPng(), 'image/png');
    const pdf = seed('d.pdf', await pdfBytes(), 'application/pdf');
    const result = await processGraphNodeJob(nodeJob({ op: 'metadata.write', options: { metadata: { set: { Artist: 'Ann', 'PDF:Title': 'T' } } } }, [png]), undefined, s3Storage).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(MetadataFieldError);

    const pngResult = await processGraphNodeJob(nodeJob({ op: 'metadata.write', options: { metadata: { set: { Artist: 'Ann' } } } }, [png]), undefined, s3Storage);
    expect(pngResult.filename).toBe('p.png');
    expect((await readMetadata(output(pngResult.resultKey), 'p.png')).EXIF).toEqual({ Artist: 'Ann' });
    const pdfResult = await processGraphNodeJob(nodeJob({ op: 'metadata.write', options: { metadata: { set: { Title: 'T' } } } }, [pdf]), undefined, s3Storage);
    expect(pdfResult.filename).toBe('d.pdf');
    expect((await readMetadata(output(pdfResult.resultKey), 'd.pdf')).PDF).toMatchObject({ Title: 'T' });
  });

  it('metadata.write without fields, and on a format that cannot be written, fails with the coded errors', async () => {
    const png = seed('p.png', await plainPng(), 'image/png');
    const webp = seed('w.webp', await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } }).webp().toBuffer(), 'image/webp');
    await expect(processGraphNodeJob(nodeJob({ op: 'metadata.write' }, [png]), undefined, s3Storage)).rejects.toThrow(/needs "options.metadata.set"/);
    await expect(processGraphNodeJob(nodeJob({ op: 'metadata.write', options: { metadata: { set: { Artist: 'x' } } } }, [webp]), undefined, s3Storage)).rejects.toBeInstanceOf(MetadataWriteUnsupportedError);
  });

  it('charges metadata.write for each output and metadata once', () => {
    expect(graphNodeCharge('metadata.write', { outputs: 3, optimizations: [] })).toBe(3);
    expect(graphNodeCharge('metadata', { outputs: 1, optimizations: [] })).toBe(1);
    expect(graphNodeReservedUnits({ op: 'metadata.write', input: ['a', 'b'] })).toBe(2);
    expect(graphNodeReservedUnits({ op: 'metadata', input: 'a' })).toBe(1);
  });
});
