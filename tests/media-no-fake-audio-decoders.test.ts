import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convertMedia, encodeOggContainer, encodeOpusContainer } from '../src/lib/conversions/media';
import { decodeAudioBuffer } from '../src/lib/conversions/media-decoder';
import { EngineUnavailableError } from '../src/lib/types';

/**
 * MP3 and Ogg (Vorbis, Opus) sources are decoded by FFmpeg or not at all. No in-process decoder stands in: a request
 * that cannot reach FFmpeg gets EngineUnavailableError (HTTP 503) and no output, whatever the bytes hold. The sources
 * below are well-formed at the container level and carry payloads that no real codec decoder would accept as audio,
 * so a result for any of them could only be made up.
 */

const MISSING_TOOL_PATH = '/nonexistent/easyconvert-missing-tool';
const MPEG1_LAYER3_HEADER = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
const MPEG1_LAYER3_FRAME_BYTES = 417;
const MP3_FRAMES = 6;
const LCG_MULTIPLIER = 1103515245;
const LCG_INCREMENT = 12345;
const BYTE_SHIFT = 16;
const ID3V2_HEADER = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const OGG_PAGE_HEADER_BYTES = 27;
const TARGETS = ['wav', 'flac'] as const;

/** Bytes from a fixed generator: the same on every run, and never silence. */
function pseudoRandomBytes(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, LCG_MULTIPLIER) + LCG_INCREMENT) >>> 0;
    out[i] = (state >>> BYTE_SHIFT) & 0xff;
  }
  return out;
}

function mp3Frames(): Buffer {
  const frames: Buffer[] = [];
  for (let i = 0; i < MP3_FRAMES; i++) {
    const payload = pseudoRandomBytes(MPEG1_LAYER3_FRAME_BYTES - MPEG1_LAYER3_HEADER.length, i + 1);
    frames.push(Buffer.concat([MPEG1_LAYER3_HEADER, payload]));
  }
  return Buffer.concat(frames);
}

function audioPackets(): Buffer[] {
  return [0, 1, 2, 3].map((i) => pseudoRandomBytes(120, 100 + i));
}

/** An Ogg page header with a segment table that runs past the end of the data: a stream cut off mid-page. */
function truncatedOgg(): Buffer {
  const page = Buffer.alloc(OGG_PAGE_HEADER_BYTES + 1);
  page.write('OggS', 0, 'ascii');
  page[26] = 1;
  page[27] = 200;
  return page;
}

/** One Ogg page whose only packet starts with the Vorbis identification marker and ends 10 bytes in. */
function shortVorbisIdentification(): Buffer {
  const packet = Buffer.from([0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, 0x00, 0x00, 0x00]);
  const page = Buffer.alloc(OGG_PAGE_HEADER_BYTES + 1 + packet.length);
  page.write('OggS', 0, 'ascii');
  page[26] = 1;
  page[27] = packet.length;
  packet.copy(page, OGG_PAGE_HEADER_BYTES + 1);
  return page;
}

interface Source {
  label: string;
  src: string;
  bytes: () => Buffer;
}

const mp3Sources: Source[] = [
  { label: 'MPEG-1 Layer III frames', src: 'mp3', bytes: mp3Frames },
  { label: 'MPEG-1 Layer III frames behind an ID3v2 tag', src: 'mp3', bytes: () => Buffer.concat([ID3V2_HEADER, mp3Frames()]) },
];

const oggSources: Source[] = [
  { label: 'Ogg Vorbis with audio packets', src: 'ogg', bytes: () => encodeOggContainer(audioPackets(), 44100, 2, 'tone') },
  { label: 'Ogg Opus with audio packets', src: 'opus', bytes: () => encodeOpusContainer(audioPackets(), 48000, 2, 'tone') },
  { label: 'Ogg Vorbis with headers and no audio packet', src: 'ogg', bytes: () => encodeOggContainer([], 44100, 2, 'tone') },
  { label: 'Ogg Opus with headers and no audio packet', src: 'opus', bytes: () => encodeOpusContainer([], 48000, 2, 'tone') },
  { label: 'an Ogg Vorbis stream whose identification packet is shorter than its header', src: 'ogg', bytes: shortVorbisIdentification },
  { label: 'an Ogg stream cut off inside its first page', src: 'ogg', bytes: truncatedOgg },
  { label: 'bytes that are not Ogg, named as Ogg', src: 'ogg', bytes: () => Buffer.from('definitely not an ogg stream') },
];

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('conversion resolved with an output but was expected to fail closed');
}

function captureSyncError(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  throw new Error('call returned a result but was expected to fail closed');
}

function expectEngineUnavailable(err: unknown): void {
  expect(err).toBeInstanceOf(EngineUnavailableError);
  expect((err as EngineUnavailableError).engineName).toBe('ffmpeg');
}

describe('with the native engine disabled, an MP3 or Ogg source is a 503 for every pure target', () => {
  for (const target of TARGETS) {
    it.each([...mp3Sources, ...oggSources])(`$label -> ${target}`, async ({ src, bytes }) => {
      const err = await captureError(convertMedia(bytes(), src, target, { disableNativeEngine: true }, `source.${src}`));
      expectEngineUnavailable(err);
    });
  }
});

describe('with FFmpeg missing from the host, an MP3 or Ogg source is a 503 for every pure target', () => {
  const savedPath = process.env.FFMPEG_PATH;

  beforeEach(() => {
    process.env.FFMPEG_PATH = MISSING_TOOL_PATH;
    vi.resetModules();
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = savedPath;
    vi.resetModules();
  });

  for (const target of TARGETS) {
    it.each([...mp3Sources, ...oggSources])(`$label -> ${target}`, async ({ src, bytes }) => {
      // The module caches the resolved FFmpeg path, so it is loaded fresh with the tool hidden.
      const engine = await import('../src/lib/conversions/media');
      const types = await import('../src/lib/types');
      const err = await captureError(engine.convertMedia(bytes(), src, target, {}, `source.${src}`));
      expect(err).toBeInstanceOf(types.EngineUnavailableError);
      expect((err as EngineUnavailableError).engineName).toBe('ffmpeg');
    });
  }
});

describe('decodeAudioBuffer never returns samples for an MP3 or Ogg source', () => {
  it.each(mp3Sources)('refuses $label recognised without a hint', ({ bytes }) => {
    expectEngineUnavailable(captureSyncError(() => decodeAudioBuffer(bytes())));
  });

  it.each(oggSources.filter((source) => source.label !== 'bytes that are not Ogg, named as Ogg'))(
    'refuses $label recognised by its OggS magic',
    ({ bytes }) => {
      expectEngineUnavailable(captureSyncError(() => decodeAudioBuffer(bytes())));
    }
  );

  it.each(['mp3', 'ogg', 'oga', 'opus', 'vorbis'])('refuses the %s hint even when the bytes are not audio at all', (hint) => {
    expectEngineUnavailable(captureSyncError(() => decodeAudioBuffer(Buffer.from('definitely not audio data'), hint)));
  });
});

describe('the library index no longer exports an MP3 or Ogg decoder', () => {
  it('has no decodeMp3 or decodeOgg', async () => {
    const library = await import('../src/lib/conversions/index');
    const removed = ['decodeMp3', 'decodeOgg'];
    expect(Object.keys(library).filter((name) => removed.includes(name))).toEqual([]);
  });
});
