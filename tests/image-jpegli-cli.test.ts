import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CJPEGLI_CANDIDATES,
  CJPEGLI_MAX_PIXELS,
  CJPEGLI_PATH_ENV,
  JPEG_MAX_SIDE_PX,
  JpegliEncoderFailedError,
  JpegliEncoderFaultError,
  cjpegliArguments,
  findCjpegli,
  isSupportedHelp,
  jpegliFits,
  pnmHeaderOf,
  startJpegli,
  withMetadataSegments,
} from '../src/lib/conversions/jpegli-cli';
import { ConversionFailedError, SERVER_FAULT_STATUS } from '../src/lib/types';
import { DEFAULT_QUALITY_BY_CODEC, jpegliPolicyFor } from '../src/lib/conversions/image-encoder-defaults';
import { isProcessRunning } from './helpers/process-state';

/**
 * The program wrapper of the jpegli encoder (src/lib/conversions/jpegli-cli.ts) without the real program: the arguments it builds, the
 * PNM stream it feeds, how it finds and vets a program, how a program that fails or is stopped is reported, and how the metadata
 * segments of the image library's file are put into the program's file. A stand-in script plays the program, reading the standard
 * input like the real one and writing a JPEG-shaped answer.
 */

const SCRIPT_MODE = 0o755;
const HELP_TEXT = `Usage: cjpegli INPUT OUTPUT [OPTIONS...]
 -q QUALITY, --quality=QUALITY
 --chroma_subsampling=444|440|422|420
 -p N, --progressive_level=N
 --quiet`;
/** SOI, a DQT segment of two payload bytes, SOS and EOI: enough structure for the shape check; the shell writes it with octal escapes (printf has no hex). */
const FAKE_JPEG_HEX = 'ffd8ffdb0004abcdffda000200ffd9';
const FAKE_JPEG_PRINTF = '\\377\\330\\377\\333\\000\\004\\253\\315\\377\\332\\000\\002\\000\\377\\331';

let workDir: string;
const savedPath = process.env[CJPEGLI_PATH_ENV];

beforeAll(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'jpegli-cli-'));
});
afterEach(() => {
  if (savedPath === undefined) delete process.env[CJPEGLI_PATH_ENV];
  else process.env[CJPEGLI_PATH_ENV] = savedPath;
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function script(name: string, body: string): string {
  const file = path.join(workDir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, SCRIPT_MODE);
  return file;
}

const answersHelp = `case "$1" in -v) printf '%s\\n' '${HELP_TEXT}'; exit 0;; esac`;
const jpegAnswer = `printf '${FAKE_JPEG_PRINTF}'`;
const colour = { quality: 70, chroma: '4:2:0' as const, progressive: 2 as const, grey: false };

describe('the arguments of the program', () => {
  it('reads the picture from the standard input and writes the JPEG to the standard output', () => {
    expect(cjpegliArguments(colour).slice(0, 2)).toEqual(['-', '-']);
  });

  it('passes the quality, the scan level and the chroma subsampling of a colour picture', () => {
    expect(cjpegliArguments(colour)).toEqual(['-', '-', '--quiet', '-q', '70', '-p', '2', '--chroma_subsampling', '420']);
    expect(cjpegliArguments({ ...colour, quality: 92, chroma: '4:4:4', progressive: 0 })).toEqual(['-', '-', '--quiet', '-q', '92', '-p', '0', '--chroma_subsampling', '444']);
  });

  it('gives a grey picture no chroma subsampling', () => {
    expect(cjpegliArguments({ ...colour, grey: true })).toEqual(['-', '-', '--quiet', '-q', '70', '-p', '2']);
  });

  it.each([0, 101, 70.5, Number.NaN])('refuses the quality %s before anything is started', (quality) => {
    expect(() => cjpegliArguments({ ...colour, quality })).toThrow(ConversionFailedError);
  });

  it('is told by the policy: the chroma rule of the library encoder and the encoder\'s own progressive script', () => {
    expect(jpegliPolicyFor(89)).toMatchObject({ quality: 89, chroma: '4:2:0', progressive: 2 });
    expect(jpegliPolicyFor(90)).toMatchObject({ quality: 90, chroma: '4:4:4', progressive: 2 });
    expect(jpegliPolicyFor(undefined).quality).toBe(DEFAULT_QUALITY_BY_CODEC.jpeg);
  });
});

describe('the picture stream', () => {
  it('has a P6 header for colour and a P5 header for grey, with the size and the largest sample value', () => {
    expect(pnmHeaderOf(768, 512, 3).toString('latin1')).toBe('P6\n768 512\n255\n');
    expect(pnmHeaderOf(3, 2, 1).toString('latin1')).toBe('P5\n3 2\n255\n');
  });

  it('takes the sides libjpeg allows (65,500, which the program enforces) and the pixel count the program is bounded to', () => {
    expect(jpegliFits(1, 1)).toBe(true);
    expect(jpegliFits(JPEG_MAX_SIDE_PX, 1)).toBe(true);
    expect(jpegliFits(JPEG_MAX_SIDE_PX + 1, 1)).toBe(false);
    expect(jpegliFits(8192, 8192)).toBe(true);
    expect(jpegliFits(8193, Math.ceil(CJPEGLI_MAX_PIXELS / 8193) + 1)).toBe(false);
  });
});

describe('finding the program', () => {
  it('knows a cjpegli by the options it lists and not by its name', () => {
    expect(isSupportedHelp(HELP_TEXT)).toBe(true);
    expect(isSupportedHelp(HELP_TEXT.replace('--progressive_level', '--progressive'))).toBe(false);
    expect(isSupportedHelp('Usage: other INPUT OUTPUT --quality --quiet')).toBe(false);
  });

  it('searches only the pinned build when the environment names none, so that another build never writes the files', () => {
    expect(CJPEGLI_CANDIDATES).toEqual(['/usr/local/bin/cjpegli-pinned']);
  });

  it('takes the program a variable names when it prints the options, and is silent about it otherwise', async () => {
    const good = script('help-good', `${answersHelp}\nexit 1`);
    expect(await findCjpegli({ [CJPEGLI_PATH_ENV]: good })).toBe(good);
    const other = script('help-other', `case "$1" in -v) echo 'Usage: other INPUT OUTPUT'; exit 0;; esac\nexit 1`);
    expect(await findCjpegli({ [CJPEGLI_PATH_ENV]: other })).toBeNull();
  });

  it('means "not installed" when the variable names something that is not an executable file, without looking further', async () => {
    expect(await findCjpegli({ [CJPEGLI_PATH_ENV]: path.join(workDir, 'missing') })).toBeNull();
    expect(await findCjpegli({ [CJPEGLI_PATH_ENV]: 'cjpegli' })).toBeNull();
  });
});

describe('a run of the program', () => {
  const samples = { pixels: Buffer.alloc(2 * 2 * 3, 7), width: 2, height: 2, channels: 3 };

  it('returns the JPEG the program writes after reading the whole picture', async () => {
    const record = path.join(workDir, 'stdin-record');
    const program = script('echoes', `head -c 15 > '${record}'\n${jpegAnswer}`);
    const run = startJpegli(program, colour);
    run.send(samples);
    const jpeg = await run.result;
    expect(jpeg.toString('hex')).toBe(FAKE_JPEG_HEX);
    expect(readFileSync(record).toString('latin1')).toBe('P6\n2 2\n255\n\u0007\u0007\u0007\u0007');
  });

  it('is told the arguments of its settings', async () => {
    const record = path.join(workDir, 'args-record');
    const program = script('records-args', `printf '%s ' "$@" > '${record}'\ncat > /dev/null\n${jpegAnswer}`);
    const run = startJpegli(program, { ...colour, quality: 55, progressive: 0 });
    run.send(samples);
    await run.result;
    expect(readFileSync(record, 'utf-8').trim()).toBe('- - --quiet -q 55 -p 0 --chroma_subsampling 420');
  });

  it('reports a program that exits with a failure as a conversion error that is a fault of the program, not a retry with the library', async () => {
    const program = script('fails', `cat > /dev/null\necho 'boom' >&2\nexit 3`);
    const run = startJpegli(program, colour);
    run.send(samples);
    const error = (await run.result.catch((e: unknown) => e)) as JpegliEncoderFaultError;
    expect(error).toMatchObject({ name: 'JpegliEncoderFaultError', status: SERVER_FAULT_STATUS, message: 'Cannot encode the image as .jpg (the JPEG encoder failed on the picture)' });
  });

  it('reports a program that refuses the picture as a failed conversion of that picture', async () => {
    const program = script('refuses', `cat > /dev/null\necho 'Failed to decode input image' >&2\nexit 1`);
    const run = startJpegli(program, colour);
    run.send(samples);
    const error = (await run.result.catch((e: unknown) => e)) as JpegliEncoderFailedError;
    expect(error).toMatchObject({ name: 'JpegliEncoderFailedError', message: 'Cannot encode the image as .jpg (the JPEG encoder failed on the picture)' });
    expect(error).not.toHaveProperty('status', SERVER_FAULT_STATUS);
  });

  it('does not take output that is not a JPEG file', async () => {
    const program = script('writes-text', `cat > /dev/null\necho not-a-jpeg`);
    const run = startJpegli(program, colour);
    run.send(samples);
    await expect(run.result).rejects.toThrow(/produced no JPEG file/);
  });

  it('is stopped by cancel while it waits for its picture, and leaves no process', async () => {
    const pidFile = path.join(workDir, 'waiting-pid');
    const program = script('waits', `echo $$ > '${pidFile}'\ncat > /dev/null\n${jpegAnswer}`);
    const run = startJpegli(program, colour);
    const started = Date.now() + 10_000;
    while (!existsSync(pidFile) && Date.now() < started) await new Promise((resolve) => setTimeout(resolve, 10));
    const pid = Number(readFileSync(pidFile, 'utf-8'));
    await run.cancel();
    await expect(run.result).rejects.toBeDefined();
    const deadline = Date.now() + 5000;
    while (isProcessRunning(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(isProcessRunning(pid)).toBe(false);
  });

  it('refuses samples that are not the picture it was started for', async () => {
    const program = script('never-fed', `cat > /dev/null\n${jpegAnswer}`);
    const grey = startJpegli(program, { ...colour, grey: true });
    grey.send(samples);
    await expect(grey.result).rejects.toThrow(/do not match the picture/);
    const short = startJpegli(program, colour);
    short.send({ ...samples, pixels: Buffer.alloc(3) });
    await expect(short.result).rejects.toThrow(/do not match the picture/);
  });
});

describe('putting the metadata segments of the library file into the program file', () => {
  const soi = Buffer.from('ffd8', 'hex');
  const segment = (marker: number, payload: string): Buffer => {
    const body = Buffer.from(payload, 'latin1');
    const header = Buffer.alloc(4);
    header[0] = 0xff;
    header[1] = marker;
    header.writeUInt16BE(body.length + 2, 2);
    return Buffer.concat([header, body]);
  };
  const tail = Buffer.concat([segment(0xdb, 'tables'), segment(0xc2, 'frame'), Buffer.from('ffda0002', 'hex'), Buffer.from('00ffd9', 'hex')]);

  it('puts the application and comment segments of the template, in their order, in front of the tables of the program file', () => {
    const encoded = Buffer.concat([soi, tail]);
    const template = Buffer.concat([soi, segment(0xe0, 'JFIF'), segment(0xe1, 'Exif'), segment(0xe1, 'xmp'), segment(0xe2, 'ICC_PROFILE'), segment(0xfe, 'note'), segment(0xdb, 'other tables'), Buffer.from('ffda0002ffd9', 'hex')]);
    const joined = withMetadataSegments(encoded, template);
    expect(joined.equals(Buffer.concat([soi, segment(0xe0, 'JFIF'), segment(0xe1, 'Exif'), segment(0xe1, 'xmp'), segment(0xe2, 'ICC_PROFILE'), segment(0xfe, 'note'), tail]))).toBe(true);
  });

  it('leaves the program file as it is when the template has no such segment', () => {
    const encoded = Buffer.concat([soi, tail]);
    const template = Buffer.concat([soi, segment(0xdb, 'other tables'), Buffer.from('ffda0002ffd9', 'hex')]);
    expect(withMetadataSegments(encoded, template).equals(encoded)).toBe(true);
  });

  it('drops segments of its own that the program file carries, so that the template is the only source', () => {
    const encoded = Buffer.concat([soi, segment(0xe1, 'from the program'), tail]);
    const template = Buffer.concat([soi, segment(0xe1, 'Exif'), segment(0xdb, 'x'), Buffer.from('ffda0002ffd9', 'hex')]);
    expect(withMetadataSegments(encoded, template).equals(Buffer.concat([soi, segment(0xe1, 'Exif'), tail]))).toBe(true);
  });

  it('refuses a template or a file that is not a JPEG stream', () => {
    const encoded = Buffer.concat([soi, tail]);
    expect(() => withMetadataSegments(encoded, Buffer.from('not a jpeg'))).toThrow(ConversionFailedError);
    expect(() => withMetadataSegments(Buffer.from('not a jpeg'), encoded)).toThrow(ConversionFailedError);
  });
});
