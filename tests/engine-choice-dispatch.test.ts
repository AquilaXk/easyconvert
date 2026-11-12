import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { ENGINE_NAMES, type EngineId } from '../src/lib/conversions/engine-ids';
import { enginesForPair, installedEngineVersion } from '../src/worker/engine-registry';
import { EngineNotOfferedError, EngineVersionNotOfferedError } from '../src/lib/conversions/engine-errors';
import { EngineUnavailableError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import type { ExternalOracleTool } from './helpers/differential-oracle';
import { withMissingBinary } from './helpers/native-tools';

/**
 * Choosing an engine runs that engine. For one sample of each family that lists two engines, and of the families that list one,
 * every listed engine converts the sample, and the result and the engine fields name the engine that was asked for. The oracle
 * of the engine is the worker's documented engine identifiers (`native-*` for a program, `internal-fallback` for the converter),
 * and the output is checked by its own signature, so a result that is another engine's file in the wrong format fails here.
 */

const NATIVE_ENGINE_USED: Readonly<Record<EngineId, readonly string[]>> = {
  easyconvert: ['internal-fallback', 'in-process-raw'],
  libreoffice: ['native-soffice', 'native-soffice-pool', 'native-poppler'],
  ffmpeg: ['native-ffmpeg'],
  poppler: ['native-poppler'],
  '7zip': ['native-7z'],
  ghostscript: ['native-postscript', 'native-poppler'],
  ghostxps: ['native-xps'],
  djvulibre: ['native-djvu'],
  calibre: ['native-calibre'],
  librsvg: ['native-svg'],
  libraw: ['native-raw'],
};

/** The tool each engine needs, for the cases that skip without it (and fail under ORACLE_STRICT_MODE=1). */
const TOOL_OF_ENGINE: Partial<Record<EngineId, ExternalOracleTool>> = {
  libreoffice: 'soffice',
  ffmpeg: 'ffmpeg',
  poppler: 'pdftoppm',
  '7zip': '7z',
  ghostscript: 'ps2pdf',
  librsvg: 'rsvg-convert',
};

async function samplePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 200]).drawText('Engine choice', { x: 20, y: 100, font, size: 18 });
  return Buffer.from(await doc.save());
}

async function sampleZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('hello.txt', 'hello engine choice');
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** One second of 16-bit mono PCM at 8 kHz, so both the FFmpeg path and the in-process encoder have a small valid file. */
function sampleWav(): Buffer {
  const samples = 8000;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) data.writeInt16LE(Math.round(6000 * Math.sin(i / 8)), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="#c33"/><text x="5" y="30">hi</text></svg>');
const RTF = Buffer.from('{\\rtf1\\ansi Engine choice\\par}');
const SRT = Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nHello\n');
const POSTSCRIPT = Buffer.from('%!PS-Adobe-3.0\n%%BoundingBox: 0 0 100 50\n/Helvetica findfont 20 scalefont setfont 10 10 moveto (hi) show showpage\n');

/** What a result of each target starts with. */
const SIGNATURE: Readonly<Record<string, (bytes: Buffer) => boolean>> = {
  pdf: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  png: (b) => b.subarray(1, 4).toString('latin1') === 'PNG',
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8,
  flac: (b) => b.subarray(0, 4).toString('latin1') === 'fLaC',
  tar: (b) => b.subarray(257, 262).toString('latin1') === 'ustar' || b.subarray(0, 9).toString('latin1') === 'hello.txt',
  txt: (b) => b.toString('utf-8').includes('Engine choice'),
  vtt: (b) => b.toString('utf-8').startsWith('WEBVTT'),
  doc: (b) => b.subarray(0, 5).toString('latin1') === '{\\rtf' || (b[0] === 0xd0 && b[1] === 0xcf),
  zip: (b) => b[0] === 0x50 && b[1] === 0x4b,
};

interface Sample {
  src: string;
  tgt: string;
  input: () => Promise<Buffer> | Buffer;
}

/** One pair of each family that lists more than one engine, and of the families whose one engine is a program. */
const SAMPLES: readonly Sample[] = [
  { src: 'txt', tgt: 'pdf', input: () => Buffer.from('Engine choice\n') },
  { src: 'html', tgt: 'pdf', input: () => Buffer.from('<html><body><p>Engine choice</p></body></html>') },
  { src: 'md', tgt: 'pdf', input: () => Buffer.from('# Engine choice\n') },
  { src: 'rtf', tgt: 'pdf', input: () => RTF },
  { src: 'rtf', tgt: 'doc', input: () => RTF },
  { src: 'pdf', tgt: 'png', input: samplePdf },
  { src: 'pdf', tgt: 'txt', input: samplePdf },
  { src: 'txt', tgt: 'jpg', input: () => Buffer.from('Engine choice\n') },
  { src: 'zip', tgt: 'tar', input: sampleZip },
  { src: 'wav', tgt: 'flac', input: sampleWav },
  { src: 'svg', tgt: 'pdf', input: () => SVG },
  { src: 'srt', tgt: 'vtt', input: () => SRT },
  { src: 'eps', tgt: 'pdf', input: () => POSTSCRIPT },
];

function toolsOf(sample: Sample): ExternalOracleTool[] {
  const tools = new Set<ExternalOracleTool>();
  for (const { id } of enginesForPair(sample.src, sample.tgt)) {
    const tool = TOOL_OF_ENGINE[id];
    if (tool) tools.add(tool);
  }
  // Page images and the text layer of a PDF, and the pages of a text source, are drawn by Poppler after the office suite writes the PDF.
  if (sample.tgt === 'jpg' || sample.tgt === 'png') tools.add('pdftoppm');
  return [...tools];
}

describe('choosing each listed engine of a pair runs that engine', () => {
  for (const sample of SAMPLES) {
    for (const { id } of enginesForPair(sample.src, sample.tgt)) {
      oracleTest(`${sample.src} to ${sample.tgt} with ${id}`, toolsOf(sample), async () => {
        const result = await dispatchConversion(await sample.input(), sample.src, sample.tgt, { engine: id }, `engine.${sample.src}`);
        expect(NATIVE_ENGINE_USED[id], `engineUsed ${result.engineUsed}`).toContain(result.engineUsed);
        expect(result.engine).toBe(id);
        expect(result.engineVersion).toBe(await installedEngineVersion(id));
        expect(result.fallbackChain ?? []).toEqual([]);
        const check = SIGNATURE[sample.tgt];
        expect(check?.(result.buffer), `the ${sample.tgt} output of ${id}`).toBe(true);
      });
    }
  }

  it('lists at least two engines for the families that offer a choice, and every sample lists the engine it is run with', () => {
    const choices = SAMPLES.filter((s) => enginesForPair(s.src, s.tgt).length > 1).map((s) => `${s.src}->${s.tgt}`);
    expect(choices).toEqual(expect.arrayContaining(['txt->pdf', 'html->pdf', 'rtf->pdf', 'pdf->txt', 'zip->tar', 'wav->flac', 'svg->pdf']));
  });
});

describe('a conversion that names no engine', () => {
  oracleTest('reports the engine the pair prefers and its version', ['7z'], async () => {
    const result = await dispatchConversion(await sampleZip(), 'zip', 'tar', {}, 'bundle.zip');
    expect(result.engineUsed).toBe('native-7z');
    expect(result.engine).toBe('7zip');
    expect(result.engineVersion).toBe(await installedEngineVersion('7zip'));
  });

  it('reports the in-process converter and its version where no program converts the pair', async () => {
    const png = await (await import('sharp')).default({ create: { width: 4, height: 4, channels: 3, background: '#336699' } }).png().toBuffer();
    const result = await dispatchConversion(png, 'png', 'jpg', {}, 'pic.png');
    expect(result.engine).toBe('easyconvert');
    expect(result.engineVersion).toBe(await installedEngineVersion('easyconvert'));
    expect(result.engineUsed).toBe('internal-fallback');
  });

  it('still falls back to the converter when the program of the default engine is missing, and reports the converter', async () => {
    const result = await withMissingBinary('P7ZIP_PATH', async () => dispatchConversion(await sampleZip(), 'zip', 'tar', {}, 'bundle.zip'));
    expect(result.engineUsed).toBe('internal-fallback');
    expect(result.engine).toBe('easyconvert');
  });
});

describe('a refused choice', () => {
  const rejection = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (err: unknown) => err);

  it('names an engine the pair does not list, before anything runs', async () => {
    const err = await rejection(dispatchConversion(await sampleZip(), 'zip', 'tar', { engine: 'libreoffice' }, 'bundle.zip'));
    expect(err).toBeInstanceOf(EngineNotOfferedError);
    expect((err as EngineNotOfferedError).engines).toEqual(['7zip', 'easyconvert']);
  });

  it('refuses the engine of a pair that has only a program, where the converter is not a choice', async () => {
    const err = await rejection(dispatchConversion(await samplePdf(), 'pdf', 'png', { engine: 'easyconvert' }, 'doc.pdf'));
    expect(err).toBeInstanceOf(EngineNotOfferedError);
    expect((err as EngineNotOfferedError).engines).toEqual(['poppler']);
  });

  it('refuses a version other than the installed one and names the installed one', async () => {
    const err = await rejection(dispatchConversion(await sampleZip(), 'zip', 'tar', { engine: 'easyconvert', engineVersion: '0.0.1' }, 'bundle.zip'));
    expect(err).toBeInstanceOf(EngineVersionNotOfferedError);
    expect((err as EngineVersionNotOfferedError).installedVersion).toBe(await installedEngineVersion('easyconvert'));
  });

  it('accepts the installed version', async () => {
    const version = await installedEngineVersion('easyconvert');
    const result = await dispatchConversion(await sampleZip(), 'zip', 'tar', { engine: 'easyconvert', engineVersion: version }, 'bundle.zip');
    expect(result.engine).toBe('easyconvert');
    expect(result.engineVersion).toBe(version);
  });

  it('does not fall back to the converter when the program of the chosen engine is missing', async () => {
    const zip = await sampleZip();
    const err = await withMissingBinary('P7ZIP_PATH', () => rejection(dispatchConversion(zip, 'zip', 'tar', { engine: '7zip' }, 'bundle.zip')));
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect((err as EngineUnavailableError).engineName).toBe(ENGINE_NAMES['7zip']);
  });
});
