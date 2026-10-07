import { describe, it, expect } from 'vitest';
import { convertFile, BitWriter, checkFfmpeg } from '../src/lib/conversions/index';
import { ConversionFailedError, EngineUnavailableError } from '../src/lib/types';
import {
  bestSnrDb,
  decodeAudioWithFfmpeg,
  probeStream,
  sineSamples,
  wavFromSamples,
} from './helpers/media-lossy-oracle';
import { oracleTest } from './helpers/oracle-test';

const MIN_ROUNDTRIP_SNR_DB = 25;

describe('Media Conversion Engine (Audio & Video)', () => {
  // Helper to generate a genuine RIFF WAV buffer
  function createTestWavBuffer(sampleRate = 44100, channels = 2, durationSec = 0.5): Buffer {
    const totalSamples = Math.floor(sampleRate * durationSec * channels);
    const dataSize = totalSamples * 2;
    const buffer = Buffer.alloc(44 + dataSize);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);

    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20); // PCM
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * channels * 2, 28);
    buffer.writeUInt16LE(channels * 2, 32);
    buffer.writeUInt16LE(16, 34);

    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    for (let i = 0; i < totalSamples; i++) {
      const val = Math.round(Math.sin((i / sampleRate) * 440 * 2 * Math.PI) * 16000);
      buffer.writeInt16LE(val, 44 + i * 2);
    }

    return buffer;
  }

  oracleTest('converts WAV to MP3 that the reference decoder reads back as the source tone', ['ffmpeg', 'ffprobe'], async () => {
    const source = sineSamples(44100, 2, 1);
    const wav = wavFromSamples(source, 44100, 2);
    const result = await convertFile(wav, 'wav', 'mp3', { audioBitrate: '192k' }, 'song.wav');

    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.filename).toBe('song.mp3');

    const stream = probeStream(result.buffer, 'mp3', 'a');
    expect(stream.codec_name).toBe('mp3');
    expect(Number(stream.sample_rate)).toBe(44100);
    expect(Number(stream.channels)).toBe(2);
    expect(bestSnrDb(source, decodeAudioWithFfmpeg(result.buffer, 'mp3', 44100, 2), 2)).toBeGreaterThanOrEqual(
      MIN_ROUNDTRIP_SNR_DB
    );
  });

  oracleTest('converts WAV to an ADTS AAC stream that decodes back to the source tone', ['ffmpeg', 'ffprobe'], async () => {
    const source = sineSamples(44100, 2, 1);
    const wav = wavFromSamples(source, 44100, 2);
    const result = await convertFile(wav, 'wav', 'aac', {}, 'recording.wav');

    expect(result.mimeType).toBe('audio/aac');
    expect(result.filename).toBe('recording.aac');
    // ADTS syncword 0xFFF
    expect(result.buffer[0]).toBe(0xff);
    expect(result.buffer[1] & 0xf0).toBe(0xf0);

    const stream = probeStream(result.buffer, 'aac', 'a');
    expect(stream.codec_name).toBe('aac');
    expect(Number(stream.sample_rate)).toBe(44100);
    expect(Number(stream.channels)).toBe(2);
    expect(bestSnrDb(source, decodeAudioWithFfmpeg(result.buffer, 'aac', 44100, 2), 2)).toBeGreaterThanOrEqual(
      MIN_ROUNDTRIP_SNR_DB
    );
  });

  it('enforces Fail-Closed when converting WAV to OGG Vorbis without native FFmpeg engine', async () => {
    const wav = createTestWavBuffer(44100, 2, 0.5);
    const error = await convertFile(wav, 'wav', 'ogg', { disableNativeEngine: true }, 'audio.wav').catch(
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(EngineUnavailableError);
    expect((error as EngineUnavailableError).engineName).toBe('ffmpeg');
    expect((error as EngineUnavailableError).message).toMatch(
      /Native FFmpeg engine is required for authentic lossy OGG compression/i
    );
  });

  it('converts WAV to FLAC with fLaC magic header', async () => {
    const wav = createTestWavBuffer(44100, 2, 0.5);
    const result = await convertFile(wav, 'wav', 'flac', {}, 'lossless.wav');

    expect(result.mimeType).toBe('audio/flac');
    expect(result.filename).toBe('lossless.flac');
    // fLaC magic marker
    expect(result.buffer.toString('ascii', 0, 4)).toBe('fLaC');
  });

  oracleTest('converts audio to an MP4 container whose AAC track decodes back to the source tone', ['ffmpeg', 'ffprobe'], async () => {
    const source = sineSamples(44100, 2, 1);
    const wav = wavFromSamples(source, 44100, 2);
    const result = await convertFile(wav, 'wav', 'mp4', {}, 'video_track.wav');

    expect(result.mimeType).toBe('video/mp4');
    expect(result.filename).toBe('video_track.mp4');
    // MP4 'ftyp' box
    expect(result.buffer.toString('ascii', 4, 8)).toBe('ftyp');

    expect(probeStream(result.buffer, 'mp4', 'a').codec_name).toBe('aac');
    expect(bestSnrDb(source, decodeAudioWithFfmpeg(result.buffer, 'mp4', 44100, 2), 2)).toBeGreaterThanOrEqual(
      MIN_ROUNDTRIP_SNR_DB
    );
  });

  it('converts audio to WebM container with EBML header when FFmpeg available or fails closed', async () => {
    const wav = createTestWavBuffer(44100, 2, 0.5);
    if (checkFfmpeg()) {
      const result = await convertFile(wav, 'wav', 'webm', {}, 'clip.wav');
      expect(result.mimeType).toBe('video/webm');
      expect(result.filename).toBe('clip.webm');
      // WebM EBML marker [0x1A, 0x45, 0xDF, 0xA3]
      expect(result.buffer[0]).toBe(0x1a);
      expect(result.buffer[1]).toBe(0x45);
      expect(result.buffer[2]).toBe(0xdf);
      expect(result.buffer[3]).toBe(0xa3);
    } else {
      await expect(convertFile(wav, 'wav', 'webm', {}, 'clip.wav')).rejects.toThrow(
        ConversionFailedError
      );
    }
  });

  oracleTest('converts an MP4 container to MP3 through the native engine', ['ffmpeg', 'ffprobe'], async () => {
    const wav = wavFromSamples(sineSamples(44100, 2, 1), 44100, 2);
    const mp4Result = await convertFile(wav, 'wav', 'mp4', {}, 'movie.wav');
    const mp3Result = await convertFile(mp4Result.buffer, 'mp4', 'mp3', {}, 'movie.mp4');

    expect(mp3Result.mimeType).toBe('audio/mpeg');
    expect(probeStream(mp3Result.buffer, 'mp3', 'a').codec_name).toBe('mp3');
  });

  it('applies volume and sample rate parameters correctly', async () => {
    const wav = createTestWavBuffer(44100, 2, 0.5);
    const result = await convertFile(
      wav,
      'wav',
      'wav',
      { audioVolume: 50, audioSampleRate: 22050, audioChannels: 'mono' },
      'scaled.wav'
    );

    expect(result.mimeType).toBe('audio/wav');
    expect(result.filename).toBe('scaled.wav');
    // Check sample rate in WAV header at byte 24
    const sampleRate = result.buffer.readUInt32LE(24);
    expect(sampleRate).toBe(22050);
    // Check channels at byte 22
    const channels = result.buffer.readUInt16LE(22);
    expect(channels).toBe(1);
  });

  describe('Pure TypeScript Media Encoders (Zero-Dependency)', () => {
    it('encodes Exp-Golomb and bitfields with BitWriter', () => {
      const writer = new BitWriter();
      writer.writeBits(0b1011, 4);
      writer.writeBit(1);
      writer.writeBit(0);
      writer.writeUe(3); // v=4 -> len 3 -> 00 100
      writer.writeSe(-1); // mapped to 2*1 = 2 -> v=3 -> len 2 -> 0 11
      const buf = writer.toBuffer();
      expect(buf).toHaveLength(2);
      expect(buf[0]).toBe(0b10111000);
      expect(buf[1]).toBe(0b10001100);
    });
  });
});
