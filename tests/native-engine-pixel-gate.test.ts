import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import {
  DEFAULT_MAX_INPUT_PIXELS,
  InputPixelLimitError,
  QUANTIZER_PIXEL_BUDGET,
  RAW_SENSOR_PIXEL_BUDGET,
} from '../src/lib/conversions/image-input-limits';
import { convertMedia } from '../src/lib/conversions/media';
import { resetInputProbeCache } from '../src/lib/conversions/media-ffprobe';
import {
  convertWithHeadlessOffice,
  convertWithNativeFfmpeg,
  convertWithNativeRaw,
} from '../src/worker/engines';
import { TAG } from '../src/worker/raw-dng-image-data';
import { pptxWithPicture } from './helpers/embedded-image-docs';
import { bombBmp, bombGif, bombPng, bombTiff, bombWebp } from './helpers/image-bombs';
import { expectNoHang } from './helpers/timing';

const HTTP_PAYLOAD_TOO_LARGE = 413;
const SPY_MODE = 0o755;

let spyDir = '';
let spyLog = '';

function writeSpyBinary(name: string, stdout = ''): string {
  const file = path.join(spyDir, name);
  const body = stdout
    ? `#!/bin/sh\necho "${name}" >> "${spyLog}"\nprintf '%s\\n' '${stdout}'\nexit 0\n`
    : `#!/bin/sh\necho "${name}" >> "${spyLog}"\nexit 1\n`;
  writeFileSync(file, body);
  chmodSync(file, SPY_MODE);
  return file;
}

function invocationsOf(name: string): string[] {
  if (!existsSync(spyLog)) return [];
  return readFileSync(spyLog, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() === name);
}

function mp4Box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

function bombMp4(width: number, height: number): Buffer {
  const ftyp = mp4Box('ftyp', Buffer.from('isom\x00\x00\x02\x00isomiso2', 'latin1'));
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(1000, 16);
  const tkhd = Buffer.alloc(84);
  const mdhd = Buffer.alloc(24);
  const hdlr = Buffer.alloc(24);
  hdlr.write('vide', 8, 4, 'latin1');
  const stts = Buffer.alloc(16);
  stts.writeUInt32BE(1, 4);
  stts.writeUInt32BE(1, 8);
  stts.writeUInt32BE(1000, 12);
  const stsz = Buffer.alloc(12);
  stsz.writeUInt32BE(1, 8);
  const stsc = Buffer.alloc(20);
  stsc.writeUInt32BE(1, 4);
  stsc.writeUInt32BE(1, 8);
  stsc.writeUInt32BE(1, 12);
  stsc.writeUInt32BE(1, 16);
  const stco = Buffer.alloc(12);
  stco.writeUInt32BE(1, 4);
  const sps = Buffer.from([0x67, 66, 0, 30, 0xff, 0x00]);
  const avcc = Buffer.alloc(8 + sps.length);
  avcc[0] = 1;
  avcc[5] = 1;
  avcc.writeUInt16BE(sps.length, 6);
  sps.copy(avcc, 8);
  const videoPrefix = Buffer.alloc(78);
  videoPrefix.writeUInt16BE(width, 24);
  videoPrefix.writeUInt16BE(height, 26);
  const avc1 = mp4Box('avc1', Buffer.concat([videoPrefix, mp4Box('avcC', avcc)]));
  const stsdPrefix = Buffer.alloc(8);
  stsdPrefix.writeUInt32BE(1, 4);
  const stsd = mp4Box('stsd', Buffer.concat([stsdPrefix, avc1]));
  const stbl = mp4Box('stbl', Buffer.concat([stsd, mp4Box('stts', stts), mp4Box('stsz', stsz), mp4Box('stsc', stsc), mp4Box('stco', stco)]));
  const minf = mp4Box('minf', stbl);
  const mdia = mp4Box('mdia', Buffer.concat([mp4Box('mdhd', mdhd), mp4Box('hdlr', hdlr), minf]));
  const trak = mp4Box('trak', Buffer.concat([mp4Box('tkhd', tkhd), mdia]));
  const moov = mp4Box('moov', Buffer.concat([mp4Box('mvhd', mvhd), trak]));
  const mdat = mp4Box('mdat', Buffer.alloc(16));
  return Buffer.concat([ftyp, moov, mdat]);
}

function bombEbmlMkv(): Buffer {
  return Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82, 0x88, 0x6d, 0x61, 0x74, 0x72, 0x6f, 0x73, 0x6b, 0x61]);
}

function bombTiffWithPanasonicFlag(width: number, height: number): Buffer {
  const entries: Array<[number, number, number, number]> = [
    [TAG.panasonicFlag, 1, 4, 1],
    [TAG.imageWidth, 4, 1, width],
    [TAG.imageLength, 4, 1, height],
  ];
  const out = Buffer.alloc(8 + 2 + entries.length * 12 + 4);
  out.write('II', 0, 'ascii');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(8, 4);
  out.writeUInt16LE(entries.length, 8);
  entries.forEach(([tag, type, count, value], i) => {
    const at = 10 + i * 12;
    out.writeUInt16LE(tag, at);
    out.writeUInt16LE(type, at + 2);
    out.writeUInt32LE(count, at + 4);
    out.writeUInt32LE(value, at + 8);
  });
  return out;
}

function bombTiffWith3872PreviewAndSubIfd(subWidth: number, subHeight: number): Buffer {
  const ifd0Entries = 3;
  const subIfdOffset = 8 + 2 + ifd0Entries * 12 + 4;
  const subIfdEntries = 2;
  const out = Buffer.alloc(subIfdOffset + 2 + subIfdEntries * 12 + 4);
  out.write('II', 0, 'ascii');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(8, 4);
  out.writeUInt16LE(ifd0Entries, 8);
  const rootEntries: Array<[number, number, number, number]> = [
    [TAG.imageWidth, 4, 1, 3_872],
    [TAG.imageLength, 4, 1, 2_592],
    [TAG.subIfds, 4, 1, subIfdOffset],
  ];
  rootEntries.forEach(([tag, type, count, value], i) => {
    const at = 10 + i * 12;
    out.writeUInt16LE(tag, at);
    out.writeUInt16LE(type, at + 2);
    out.writeUInt32LE(count, at + 4);
    out.writeUInt32LE(value, at + 8);
  });
  out.writeUInt16LE(subIfdEntries, subIfdOffset);
  const childEntries: Array<[number, number, number, number]> = [
    [TAG.imageWidth, 4, 1, subWidth],
    [TAG.imageLength, 4, 1, subHeight],
  ];
  childEntries.forEach(([tag, type, count, value], i) => {
    const at = subIfdOffset + 2 + i * 12;
    out.writeUInt16LE(tag, at);
    out.writeUInt16LE(type, at + 2);
    out.writeUInt32LE(count, at + 4);
    out.writeUInt32LE(value, at + 8);
  });
  return out;
}

async function expectFastPixelLimitRejection(
  run: () => Promise<unknown> | unknown,
  expectedLimit: number,
  expectedWidth: number,
  expectedHeight: number
): Promise<void> {
  let caught: unknown;
  await expectNoHang('pixel limit rejection', async () => {
    try {
      await run();
    } catch (err) {
      caught = err;
    }
  });
  expect(caught).toBeInstanceOf(InputPixelLimitError);
  expect(caught).toMatchObject({
    status: HTTP_PAYLOAD_TOO_LARGE,
    limit: expectedLimit,
    width: expectedWidth,
    height: expectedHeight,
  });
}

beforeAll(() => {
  spyDir = mkdtempSync(path.join(os.tmpdir(), 'easyconvert-pixel-gate-spy-'));
  spyLog = path.join(spyDir, 'invocations.log');
  writeSpyBinary('dcraw_emu');
  writeSpyBinary('soffice');
  writeSpyBinary('ffmpeg');
  writeSpyBinary(
    'ffprobe',
    JSON.stringify({
      streams: [{ index: 0, codec_type: 'video', codec_name: 'vp9', width: 15_000, height: 15_000 }],
      format: { start_time: '0.0', duration: '1.0' },
      chapters: [],
    })
  );
});

afterAll(() => {
  rmSync(spyDir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(spyLog, { force: true });
  vi.stubEnv('DCRAW_EMU_PATH', path.join(spyDir, 'dcraw_emu'));
  vi.stubEnv('SOFFICE_PATH', path.join(spyDir, 'soffice'));
  vi.stubEnv('FFMPEG_PATH', path.join(spyDir, 'ffmpeg'));
  vi.stubEnv('FFPROBE_PATH', path.join(spyDir, 'ffprobe'));
  resetInputProbeCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetInputProbeCache();
});

describe('native RAW pre-decode sensor pixel gate', () => {
  it('refuses a declared 10000x10001 RAW bomb before spawning dcraw_emu', async () => {
    const raw = bombTiff(10_000, 10_001);
    await expectFastPixelLimitRejection(
      () => convertWithNativeRaw(raw, 'dng', 'png', { throwOnUnavailable: true }, 'bomb.dng'),
      DEFAULT_MAX_INPUT_PIXELS,
      10_000,
      10_001
    );
    expect(invocationsOf('dcraw_emu')).toEqual([]);
  });

  it('refuses an 8200x8200 RAW sensor over the 64 MP sensor budget before spawning dcraw_emu', async () => {
    const raw = bombTiff(8_200, 8_200);
    await expectFastPixelLimitRejection(
      () => convertWithNativeRaw(raw, 'dng', 'png', { throwOnUnavailable: true }, 'sensor.dng'),
      RAW_SENSOR_PIXEL_BUDGET.maxPixels,
      8_200,
      8_200
    );
    expect(invocationsOf('dcraw_emu')).toEqual([]);
  });

  it('refuses an over-budget RAW sensor even when an unmodelled vendor tag precedes ImageWidth', async () => {
    const raw = bombTiffWithPanasonicFlag(8_200, 8_200);
    await expectFastPixelLimitRejection(
      () => convertWithNativeRaw(raw, 'rw2', 'png', { throwOnUnavailable: true }, 'panasonic.rw2'),
      RAW_SENSOR_PIXEL_BUDGET.maxPixels,
      8_200,
      8_200
    );
    expect(invocationsOf('dcraw_emu')).toEqual([]);
  });

  it('refuses an over-budget RAW SubIFD when IFD0 has width 3872 before spawning dcraw_emu', async () => {
    const raw = bombTiffWith3872PreviewAndSubIfd(8_200, 8_200);
    await expectFastPixelLimitRejection(
      () => convertWithNativeRaw(raw, 'dng', 'png', { throwOnUnavailable: true }, 'preview3872.dng'),
      RAW_SENSOR_PIXEL_BUDGET.maxPixels,
      8_200,
      8_200
    );
    expect(invocationsOf('dcraw_emu')).toEqual([]);
  });
});

describe('native LibreOffice embedded picture pixel gate', () => {
  it('refuses a PPTX with an over-limit PNG picture before spawning soffice', async () => {
    const pptx = await pptxWithPicture('bomb.png', bombPng(15_000, 15_000));
    await expectFastPixelLimitRejection(
      () => convertWithHeadlessOffice(pptx, 'pptx', 'pdf', { throwOnUnavailable: true }, 'deck.pptx'),
      DEFAULT_MAX_INPUT_PIXELS,
      15_000,
      15_000
    );
    expect(invocationsOf('soffice')).toEqual([]);
  });

  it('refuses a PPTX with an over-limit WebP or BMP picture before spawning soffice', async () => {
    const webpPptx = await pptxWithPicture('bomb.webp', bombWebp(16_383, 16_383));
    await expectFastPixelLimitRejection(
      () => convertWithHeadlessOffice(webpPptx, 'pptx', 'pdf', { throwOnUnavailable: true }, 'deck.pptx'),
      DEFAULT_MAX_INPUT_PIXELS,
      16_383,
      16_383
    );
    const bmpPptx = await pptxWithPicture('bomb.bmp', bombBmp(15_000, 15_000));
    await expectFastPixelLimitRejection(
      () => convertWithHeadlessOffice(bmpPptx, 'pptx', 'pdf', { throwOnUnavailable: true }, 'deck.pptx'),
      DEFAULT_MAX_INPUT_PIXELS,
      15_000,
      15_000
    );
    const dibPptx = await pptxWithPicture('bomb.dib', bombBmp(15_000, 15_000).subarray(14));
    await expectFastPixelLimitRejection(
      () => convertWithHeadlessOffice(dibPptx, 'pptx', 'pdf', { throwOnUnavailable: true }, 'deck.pptx'),
      DEFAULT_MAX_INPUT_PIXELS,
      15_000,
      15_000
    );
    expect(invocationsOf('soffice')).toEqual([]);
  });
});

describe('native FFmpeg image and video stream pixel gate', () => {
  it('refuses an over-limit GIF or BMP in convertWithNativeFfmpeg and convertMedia without spawning ffmpeg', async () => {
    const gif = bombGif(15_000, 15_000);
    await expectFastPixelLimitRejection(
      () => convertWithNativeFfmpeg(gif, 'gif', 'mp4', { throwOnUnavailable: true }, 'bomb.gif'),
      DEFAULT_MAX_INPUT_PIXELS,
      15_000,
      15_000
    );
    await expectFastPixelLimitRejection(
      () => convertMedia(gif, 'gif', 'mp4', {}, 'bomb.gif'),
      DEFAULT_MAX_INPUT_PIXELS,
      15_000,
      15_000
    );
    const bmp = bombBmp(15_000, 15_000);
    await expectFastPixelLimitRejection(
      () => convertWithNativeFfmpeg(bmp, 'bmp', 'mp4', { throwOnUnavailable: true }, 'bomb.bmp'),
      DEFAULT_MAX_INPUT_PIXELS,
      15_000,
      15_000
    );
    await expectFastPixelLimitRejection(
      () => convertMedia(bmp, 'bmp', 'mp4', {}, 'bomb.bmp'),
      DEFAULT_MAX_INPUT_PIXELS,
      15_000,
      15_000
    );
    expect(invocationsOf('ffmpeg')).toEqual([]);
  });

  it('refuses an over-limit WebP in convertWithNativeFfmpeg and convertMedia without spawning ffmpeg', async () => {
    const webp = bombWebp(16_383, 16_383);
    await expectFastPixelLimitRejection(
      () => convertWithNativeFfmpeg(webp, 'webp', 'mp4', { throwOnUnavailable: true }, 'bomb.webp'),
      DEFAULT_MAX_INPUT_PIXELS,
      16_383,
      16_383
    );
    await expectFastPixelLimitRejection(
      () => convertMedia(webp, 'webp', 'mp4', {}, 'bomb.webp'),
      DEFAULT_MAX_INPUT_PIXELS,
      16_383,
      16_383
    );
    expect(invocationsOf('ffmpeg')).toEqual([]);
  });

  it('refuses an MP4 video stream over maxInputPixels from its header without spawning ffmpeg', async () => {
    const mp4 = bombMp4(15_000, 15_000);
    await expectFastPixelLimitRejection(
      () => convertWithNativeFfmpeg(mp4, 'mp4', 'webm', { throwOnUnavailable: true }, 'bomb.mp4'),
      DEFAULT_MAX_INPUT_PIXELS,
      15_000,
      15_000
    );
    await expectFastPixelLimitRejection(
      () => convertMedia(mp4, 'mp4', 'webm', {}, 'bomb.mp4'),
      DEFAULT_MAX_INPUT_PIXELS,
      15_000,
      15_000
    );
    await expectFastPixelLimitRejection(
      () => convertMedia(mp4, 'mp4', 'jpg', { thumbnail: { at: ['00:00:01.000'] } }, 'bomb.mp4'),
      DEFAULT_MAX_INPUT_PIXELS,
      15_000,
      15_000
    );
    await expectFastPixelLimitRejection(
      () => convertWithNativeFfmpeg(mp4, 'mp4', 'gif', { duration: 5, throwOnUnavailable: true }, 'bomb.mp4'),
      DEFAULT_MAX_INPUT_PIXELS,
      15_000,
      15_000
    );
    await expectFastPixelLimitRejection(
      () => convertMedia(mp4, 'mp4', 'hls', {}, 'bomb.mp4'),
      DEFAULT_MAX_INPUT_PIXELS,
      15_000,
      15_000
    );
    expect(invocationsOf('ffmpeg')).toEqual([]);
  });

  it('refuses a probed video stream over maxInputPixels without spawning ffmpeg', async () => {
    const mkv = bombEbmlMkv();
    await expectFastPixelLimitRejection(
      () => convertWithNativeFfmpeg(mkv, 'mkv', 'mp4', { throwOnUnavailable: true }, 'bomb.mkv'),
      DEFAULT_MAX_INPUT_PIXELS,
      15_000,
      15_000
    );
    expect(invocationsOf('ffmpeg')).toEqual([]);
  });
});

describe('palette quantizer pixel budget', () => {
  it('refuses a 25 MP BMP 8-bit conversion with InputPixelLimitError under 500 ms', async () => {
    const source = await sharp({
      create: { width: 5_000, height: 5_000, channels: 3, background: { r: 40, g: 90, b: 160 } },
    })
      .png()
      .toBuffer();
    await expectFastPixelLimitRejection(
      () => convertImage(source, 'bmp', { colorDepth: 8 }, 'big.png', 'png'),
      QUANTIZER_PIXEL_BUDGET.maxPixels,
      5_000,
      5_000
    );
  });

  it('quantizes an in-budget image to 8-bit BMP', async () => {
    const source = await sharp({
      create: { width: 128, height: 128, channels: 3, background: { r: 40, g: 180, b: 90 } },
    })
      .png()
      .toBuffer();
    const result = await expectNoHang('8-bit BMP quantization', () =>
      convertImage(source, 'bmp', { colorDepth: 8 }, 'ok.png', 'png')
    );
    expect(result.buffer.subarray(0, 2).toString('ascii')).toBe('BM');
    expect(result.buffer.readUInt16LE(28)).toBe(8);
  });
});
