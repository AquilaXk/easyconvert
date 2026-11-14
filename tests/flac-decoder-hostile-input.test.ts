import { describe, expect, it } from 'vitest';
import { decodeFlac, decodeWav, MAX_PURE_DECODED_SAMPLES } from '../src/lib/conversions/media-decoder';
import { EngineUnavailableError } from '../src/lib/types';
import { encodeFlacStream } from '../src/lib/conversions/media-encoder';
import { ramp } from './helpers/audio-signals';
import { expectNoHang } from './helpers/timing';

/** A FLAC stream header: the marker and one STREAMINFO block for `channels` at 44.1 kHz, 16 bits. */
function streamHeader(channels: number): Buffer {
  const info = Buffer.alloc(34);
  info.writeUInt16BE(4096, 0);
  info.writeUInt16BE(4096, 2);
  // sample rate 44100 (20 bits), channels-1 (3 bits), bits-1 (5 bits)
  const rate = 44100;
  info[10] = (rate >> 12) & 0xff;
  info[11] = (rate >> 4) & 0xff;
  info[12] = ((rate & 0x0f) << 4) | (((channels - 1) & 0x07) << 1) | ((15 >> 4) & 0x01);
  info[13] = (15 & 0x0f) << 4;
  return Buffer.concat([Buffer.from('fLaC'), Buffer.from([0x80, 0, 0, 34]), info]);
}

describe('the in-process FLAC decoder on hostile input', () => {
  it('ends on bytes after the last frame that hold no sync code, instead of scanning one byte for ever', async () => {
    const tail = Buffer.concat([streamHeader(2), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06])]);
    // Before the fix the scan never moved and this call did not return: the hang guard is what fails then.
    await expectNoHang('trailing bytes', () => expect(() => decodeFlac(tail)).toThrow(/Unsupported audio format/));
  });

  it('still decodes a real stream that has padding and a tag after its frames', () => {
    const pcm = ramp(9000, 2);
    const stream = encodeFlacStream(pcm, 44100, 2);
    const padded = Buffer.concat([stream, Buffer.alloc(64), Buffer.from('TAG'), Buffer.alloc(125)]);
    const decoded = decodeFlac(padded);
    expect(decoded.channels).toBe(2);
    expect(decoded.samples.length).toBe(pcm.length);
  });

  it('refuses frames of more channels than the stream declares before it allocates their samples', async () => {
    // A frame header with a sync code, block size code 15 (32,768 samples) and channel code 7 (8 channels).
    const frame = Buffer.from([0xff, 0xf8, 0xf9, 0x78, 0x00, 0x00]);
    const bomb = Buffer.concat([streamHeader(2), ...Array.from({ length: 2000 }, () => frame)]);
    await expectNoHang('8-channel frames', () => expect(() => decodeFlac(bomb)).toThrow(/Unsupported audio format/));
  });

  it('sends a stream that declares more channels than stereo to the native engine without decoding a frame', () => {
    expect(() => decodeFlac(Buffer.concat([streamHeader(8), Buffer.from([0xff, 0xf8, 0xf9, 0x78, 0, 0])]))).toThrow(EngineUnavailableError);
  });

  it('caps the samples one decode may produce', () => {
    expect(MAX_PURE_DECODED_SAMPLES).toBe(64 * 1024 * 1024);
  });
});

describe('the in-process WAV decoder on a hostile layout', () => {
  function wav(channels: number, sampleRate: number): Buffer {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + 4, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2 * Math.max(channels, 1), 28);
    header.writeUInt16LE(2 * Math.max(channels, 1), 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(4, 40);
    return Buffer.concat([header, Buffer.alloc(4)]);
  }

  it.each([
    ['no channel', 0, 44100],
    ['no sample rate', 2, 0],
  ])('refuses %s instead of answering with an infinite or NaN duration', (_label, channels, rate) => {
    expect(() => decodeWav(wav(channels, rate))).toThrow(/Unsupported audio format/);
  });

  it('sends more channels than stereo to the native engine before decoding a sample', () => {
    expect(() => decodeWav(wav(6, 44100))).toThrow(EngineUnavailableError);
  });

  it('keeps decoding a plain stereo file', () => {
    expect(decodeWav(wav(2, 44100)).channels).toBe(2);
  });
});
