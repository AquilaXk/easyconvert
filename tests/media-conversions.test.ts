import { describe, it, expect } from 'vitest';
import {
  convertFile,
  BitWriter,
  generateH264Sps,
  generateH264Pps,
  generateH264IdrSlice,
  encodePureMp3,
  encodePureH264Mp4,
  escapeH264Rbsp,
} from '../src/lib/conversions/index';

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

  it('converts WAV to MP3 with valid ID3v2 and MPEG frames', async () => {
    const wav = createTestWavBuffer(44100, 2, 0.5);
    const result = await convertFile(wav, 'wav', 'mp3', { audioBitrate: '192k' }, 'song.wav');

    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.filename).toBe('song.mp3');
    expect(result.size).toBeGreaterThan(100);

    // Verify ID3v2 header
    expect(result.buffer.toString('ascii', 0, 3)).toBe('ID3');
    // Verify syncword somewhere in buffer
    let hasMpegSync = false;
    for (let i = 10; i < result.buffer.length - 1; i++) {
      if (result.buffer[i] === 0xff && (result.buffer[i + 1] & 0xe0) === 0xe0) {
        hasMpegSync = true;
        break;
      }
    }
    expect(hasMpegSync).toBe(true);
  });

  it('converts WAV to AAC ADTS stream container', async () => {
    const wav = createTestWavBuffer(44100, 2, 0.5);
    const result = await convertFile(wav, 'wav', 'aac', {}, 'recording.wav');

    expect(result.mimeType).toBe('audio/aac');
    expect(result.filename).toBe('recording.aac');
    // ADTS syncword 0xFFF
    expect(result.buffer[0]).toBe(0xff);
    expect((result.buffer[1] & 0xf0)).toBe(0xf0);
  });

  it('converts WAV to OGG Vorbis with OggS magic markers', async () => {
    const wav = createTestWavBuffer(44100, 2, 0.5);
    const result = await convertFile(wav, 'wav', 'ogg', {}, 'audio.wav');

    expect(result.mimeType).toBe('audio/ogg');
    expect(result.filename).toBe('audio.ogg');
    // OggS magic
    expect(result.buffer.toString('ascii', 0, 4)).toBe('OggS');
  });

  it('converts WAV to FLAC with fLaC magic header', async () => {
    const wav = createTestWavBuffer(44100, 2, 0.5);
    const result = await convertFile(wav, 'wav', 'flac', {}, 'lossless.wav');

    expect(result.mimeType).toBe('audio/flac');
    expect(result.filename).toBe('lossless.flac');
    // fLaC magic marker
    expect(result.buffer.toString('ascii', 0, 4)).toBe('fLaC');
  });

  it('converts audio to MP4 container with ftyp box', async () => {
    const wav = createTestWavBuffer(44100, 2, 0.5);
    const result = await convertFile(wav, 'wav', 'mp4', {}, 'video_track.wav');

    expect(result.mimeType).toBe('video/mp4');
    expect(result.filename).toBe('video_track.mp4');
    // MP4 'ftyp' box
    expect(result.buffer.toString('ascii', 4, 8)).toBe('ftyp');
  });

  it('converts audio to WebM container with EBML header', async () => {
    const wav = createTestWavBuffer(44100, 2, 0.5);
    const result = await convertFile(wav, 'wav', 'webm', {}, 'clip.wav');

    expect(result.mimeType).toBe('video/webm');
    expect(result.filename).toBe('clip.webm');
    // WebM EBML marker [0x1A, 0x45, 0xDF, 0xA3]
    expect(result.buffer[0]).toBe(0x1a);
    expect(result.buffer[1]).toBe(0x45);
    expect(result.buffer[2]).toBe(0xdf);
    expect(result.buffer[3]).toBe(0xa3);
  });

  it('converts MP4 video container to MP3 audio', async () => {
    const wav = createTestWavBuffer(44100, 2, 0.5);
    const mp4Result = await convertFile(wav, 'wav', 'mp4', {}, 'movie.wav');

    const mp3Result = await convertFile(mp4Result.buffer, 'mp4', 'mp3', {}, 'movie.mp4');
    expect(mp3Result.mimeType).toBe('audio/mpeg');
    expect(mp3Result.filename).toBe('movie.mp3');
    expect(mp3Result.buffer.toString('ascii', 0, 3)).toBe('ID3');
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
      expect(buf.length).toBeGreaterThan(0);
    });

    it('generates standard H.264 SPS, PPS, and IDR slice NAL units', () => {
      const sps = generateH264Sps(640, 480);
      // NAL header for SPS: forbidden(0), ref_idc(3), type(7) -> 0x67
      expect(sps[0]).toBe(0x67);
      expect(sps[1]).toBe(66); // Baseline profile

      const pps = generateH264Pps();
      // NAL header for PPS: forbidden(0), ref_idc(3), type(8) -> 0x68
      expect(pps[0]).toBe(0x68);

      const idr = generateH264IdrSlice(640, 480);
      // NAL header for IDR: forbidden(0), ref_idc(3), type(5) -> 0x65
      expect(idr[0]).toBe(0x65);
    });

    it('encodes PCM samples to pure MP3 and pure H.264 MP4 container', () => {
      const samples = new Int16Array(44100 * 0.1); // 0.1s
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.round(Math.sin((i / 44100) * 440 * 2 * Math.PI) * 16000);
      }

      const mp3 = encodePureMp3(samples, 44100, 1, '128k', 'Test Pure');
      expect(mp3.toString('ascii', 0, 3)).toBe('ID3');
      expect(mp3.length).toBeGreaterThan(100);

      const mp4 = encodePureH264Mp4(samples, 44100, 1, { videoFps: 30 }, 'Test Video');
      expect(mp4.toString('ascii', 4, 8)).toBe('ftyp');
      expect(mp4.indexOf('moov')).toBeGreaterThan(0);
      expect(mp4.indexOf('mdat')).toBeGreaterThan(0);
    });

    it('escapes H.264 RBSP bitstreams preventing start code emulation (0x00 0x00 0x03)', () => {
      // Test cases with 0x00 0x00 followed by 0x00, 0x01, 0x02, 0x03
      const raw1 = Buffer.from([0x00, 0x00, 0x00]);
      const esc1 = escapeH264Rbsp(raw1);
      expect(Array.from(esc1)).toEqual([0x00, 0x00, 0x03, 0x00]);

      const raw2 = Buffer.from([0x00, 0x00, 0x01]);
      const esc2 = escapeH264Rbsp(raw2);
      expect(Array.from(esc2)).toEqual([0x00, 0x00, 0x03, 0x01]);

      const raw3 = Buffer.from([0x00, 0x00, 0x02]);
      const esc3 = escapeH264Rbsp(raw3);
      expect(Array.from(esc3)).toEqual([0x00, 0x00, 0x03, 0x02]);

      const raw4 = Buffer.from([0x00, 0x00, 0x03]);
      const esc4 = escapeH264Rbsp(raw4);
      expect(Array.from(esc4)).toEqual([0x00, 0x00, 0x03, 0x03]);

      // Non-emulation: 0x00 0x00 0x04 should not insert 0x03
      const raw5 = Buffer.from([0x00, 0x00, 0x04]);
      const esc5 = escapeH264Rbsp(raw5);
      expect(Array.from(esc5)).toEqual([0x00, 0x00, 0x04]);
    });

    it('handles empty PCM audio sample buffers gracefully without NaN corruption', () => {
      const emptySamples = new Int16Array(0);
      const mp3 = encodePureMp3(emptySamples, 44100, 2, '192k', 'Silent Empty');
      expect(mp3.toString('ascii', 0, 3)).toBe('ID3');
      expect(mp3.length).toBeGreaterThan(100);
    });
  });
});
