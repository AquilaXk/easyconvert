import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { ConversionFailedError, EngineUnavailableError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { decodeAudioStream, probeFile, withMediaFile } from './helpers/ffmpeg-measure';
import { craftMidi, fundamentalHz, midiLengthSeconds, noteFrequencyHz } from './helpers/midi-craft';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * MIDI sources rendered to sound. The registry offers WAV and MP3 for .mid and .midi; ffmpeg has no MIDI reader, so the
 * worker renders the file with a General MIDI synthesizer first (src/lib/conversions/midi-render.ts). Three things that this
 * repository does not compute judge the result:
 * - the pitch of a note made by hand is the equal-temperament formula, measured on the decoded output by autocorrelation;
 * - the length of a piece is the sum of its delta times at its tempo, read from the file by a parser in the test helper;
 * - ffmpeg and ffprobe decode the output with -xerror and state its codec, rate and duration.
 * Without fluidsynth or ffmpeg a run that is not strict skips; ORACLE_STRICT_MODE=1 fails.
 */

const skip = skipWithoutTools('fluidsynth', 'ffmpeg', 'ffprobe');

const SAMPLE_RATE = 44_100;
const CONVERSION_TIMEOUT_MS = 120_000;
const TICKS_PER_QUARTER = 480;
const TICKS_PER_SECOND_AT_120_BPM = 960;
const NOTE_SECONDS = 2;
/** Ring-out of the last note (release, reverb and chorus) that the render may add after the file's last event. */
const MAX_TAIL_SECONDS = 6;
const LENGTH_SLACK_SECONDS = 0.25;
const PITCH_TOLERANCE = 0.01;
const PITCH_WINDOW_SECONDS = 0.4;
const PITCH_WINDOW_START_SECONDS = 0.6;
const MIN_RMS_DB = -60;
/** The delivered WAV is peak-normalised to -1 dBFS; this is the tolerance around it. */
const PEAK_DBFS = -1;
const PEAK_TOLERANCE_DB = 0.1;
const PCM16_FULL_SCALE = 32768;
const BYTES_PER_SAMPLE = 2;
const STEREO = 2;
const RIFF_HEADER_BYTES = 44;
const SAMPLE_IDS = ['wc-art-de-la-fugue-exemple04.mid', 'wc-da-jesus-an-dem-kreuze-stund.mid', 'wc-nun-bitten-wir-den-heiligen-geist-eg-.mid'] as const;

interface Decoded {
  channels: number;
  left: Float64Array;
  durationSeconds: number;
  rmsDb: number;
  /** Loudest sample of either channel in dBFS. */
  peakDb: number;
  /** Largest absolute 16-bit sample of either channel. */
  peakSample: number;
  codec: string;
  sampleRate: number;
}

/** Output bytes decoded by the independent tools: stream facts from ffprobe, all samples from ffmpeg with decode errors fatal. */
function decode(bytes: Buffer, extension: string): Decoded {
  return withMediaFile(bytes, extension, (file) => {
    const probed = probeFile(requireOracleTool('ffprobe'), file);
    expect(probed.streams.map((stream) => stream.codec_type)).toEqual(['audio']);
    const pcm = decodeAudioStream(requireOracleTool('ffmpeg'), file, SAMPLE_RATE, STEREO);
    const left = new Float64Array(pcm.samplesPerChannel);
    let energy = 0;
    let peakSample = 0;
    for (let i = 0; i < pcm.samplesPerChannel; i++) {
      left[i] = pcm.pcm.readInt16LE(i * STEREO * BYTES_PER_SAMPLE) / PCM16_FULL_SCALE;
      energy += left[i] * left[i];
      peakSample = Math.max(peakSample, Math.abs(pcm.pcm.readInt16LE(i * STEREO * BYTES_PER_SAMPLE)), Math.abs(pcm.pcm.readInt16LE((i * STEREO + 1) * BYTES_PER_SAMPLE)));
    }
    return {
      channels: probed.streams[0].channels ?? 0,
      left,
      durationSeconds: pcm.samplesPerChannel / SAMPLE_RATE,
      rmsDb: 20 * Math.log10(Math.sqrt(energy / Math.max(1, left.length))),
      peakDb: 20 * Math.log10(peakSample / PCM16_FULL_SCALE),
      peakSample,
      codec: probed.streams[0].codec_name ?? '',
      sampleRate: Number(probed.streams[0].sample_rate),
    };
  });
}

function windowOf(decoded: Decoded): Float64Array {
  const start = Math.round(PITCH_WINDOW_START_SECONDS * SAMPLE_RATE);
  return decoded.left.subarray(start, start + Math.round(PITCH_WINDOW_SECONDS * SAMPLE_RATE));
}

const convert = (bytes: Buffer, source: string, target: string): Promise<Buffer> =>
  dispatchConversion(bytes, source, target, {}, `piece.${source}`).then((result) => result.buffer);

describe.skipIf(skip)('a MIDI file is rendered to sound by a synthesizer and then encoded', () => {
  it.each([
    [57, 'A3'],
    [69, 'A4'],
    [81, 'A5'],
    [64, 'E4'],
  ])('note %i (%s) plays at its equal-temperament pitch for the length the file gives it, as WAV', async (note) => {
    const midi = craftMidi([{ note, startTick: 0, lengthTicks: NOTE_SECONDS * TICKS_PER_SECOND_AT_120_BPM }]);
    expect(midiLengthSeconds(midi)).toBeCloseTo(NOTE_SECONDS, 6);
    const output = await convert(midi, 'mid', 'wav');
    expect(output.toString('latin1', 0, 4)).toBe('RIFF');
    expect(output.length).toBeGreaterThan(RIFF_HEADER_BYTES);
    const decoded = decode(output, 'wav');
    expect(decoded.codec).toBe('pcm_s16le');
    expect(decoded.sampleRate).toBe(SAMPLE_RATE);
    expect(decoded.channels).toBe(STEREO);
    expect(decoded.durationSeconds).toBeGreaterThanOrEqual(NOTE_SECONDS - LENGTH_SLACK_SECONDS);
    expect(decoded.durationSeconds).toBeLessThanOrEqual(NOTE_SECONDS + MAX_TAIL_SECONDS);
    expect(Math.abs(decoded.peakDb - PEAK_DBFS)).toBeLessThanOrEqual(PEAK_TOLERANCE_DB);
    expect(decoded.peakSample).toBeLessThan(PCM16_FULL_SCALE - 1);
    const expected = noteFrequencyHz(note);
    expect(Math.abs(fundamentalHz(windowOf(decoded), SAMPLE_RATE) / expected - 1)).toBeLessThanOrEqual(PITCH_TOLERANCE);
  }, CONVERSION_TIMEOUT_MS);

  it('a tempo of 60 beats per minute doubles the length of the same notes, and the .midi extension renders as the .mid one', async () => {
    const notes = [{ note: 69, startTick: 0, lengthTicks: 2 * TICKS_PER_QUARTER }];
    const fast = craftMidi(notes, { microsecondsPerQuarter: 500_000 });
    const slow = craftMidi(notes, { microsecondsPerQuarter: 1_000_000 });
    expect([midiLengthSeconds(fast), midiLengthSeconds(slow)]).toEqual([1, 2]);
    const fastLength = decode(await convert(fast, 'mid', 'wav'), 'wav').durationSeconds;
    const slowLength = decode(await convert(slow, 'midi', 'wav'), 'wav').durationSeconds;
    expect(slowLength - fastLength).toBeGreaterThan(0.8);
    expect(slowLength - fastLength).toBeLessThan(1.2);
  }, CONVERSION_TIMEOUT_MS);

  it('writes an MP3 that decodes without error at the pitch of the note', async () => {
    const midi = craftMidi([{ note: 69, startTick: 0, lengthTicks: NOTE_SECONDS * TICKS_PER_SECOND_AT_120_BPM }]);
    const decoded = decode(await convert(midi, 'mid', 'mp3'), 'mp3');
    expect(decoded.codec).toBe('mp3');
    expect(decoded.durationSeconds).toBeGreaterThanOrEqual(NOTE_SECONDS - LENGTH_SLACK_SECONDS);
    expect(Math.abs(fundamentalHz(windowOf(decoded), SAMPLE_RATE) / noteFrequencyHz(69) - 1)).toBeLessThanOrEqual(PITCH_TOLERANCE);
  }, CONVERSION_TIMEOUT_MS);

  describe('the real files of the corpus', () => {
    for (const id of SAMPLE_IDS) {
      it(`${id} is as long as its own delta times say and is not silent, as WAV and MP3`, { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const seconds = midiLengthSeconds(bytes);
        expect(seconds).toBeGreaterThan(1);
        for (const target of ['wav', 'mp3']) {
          const decoded = decode(await convert(bytes, 'mid', target), target);
          expect(decoded.durationSeconds, `${target} duration of ${id}`).toBeGreaterThanOrEqual(seconds - LENGTH_SLACK_SECONDS);
          expect(decoded.durationSeconds, `${target} duration of ${id}`).toBeLessThanOrEqual(seconds + MAX_TAIL_SECONDS);
          expect(decoded.rmsDb, `${target} level of ${id}`).toBeGreaterThan(MIN_RMS_DB);
          if (target === 'wav') {
            expect(Math.abs(decoded.peakDb - PEAK_DBFS), `peak of ${id}`).toBeLessThanOrEqual(PEAK_TOLERANCE_DB);
            expect(decoded.peakSample, `full-scale samples of ${id}`).toBeLessThan(PCM16_FULL_SCALE - 1);
          }
        }
      });
    }
  });

  describe('input that is not a piece of music', () => {
    it('refuses bytes that are not a Standard MIDI File with a typed error that names MIDI', async () => {
      const error = await convert(Buffer.from('this is not a MIDI file at all, only text'), 'mid', 'wav').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConversionFailedError);
      expect((error as Error).message).toMatch(/MIDI/);
    });
  });

  describe('the synthesizer is missing', () => {
    it('answers with an engine-unavailable error that names it, not with a generic failure', async () => {
      const previous = process.env.FLUIDSYNTH_PATH;
      process.env.FLUIDSYNTH_PATH = '/nonexistent/fluidsynth';
      try {
        const midi = craftMidi([{ note: 69, startTick: 0, lengthTicks: TICKS_PER_QUARTER }]);
        const error = await convert(midi, 'mid', 'wav').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(EngineUnavailableError);
        expect((error as EngineUnavailableError).engineName).toBe('fluidsynth');
      } finally {
        if (previous === undefined) delete process.env.FLUIDSYNTH_PATH;
        else process.env.FLUIDSYNTH_PATH = previous;
      }
    });
  });
});
