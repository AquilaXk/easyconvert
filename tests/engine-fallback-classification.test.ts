import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { executeWorkerConversion } from '../src/worker/engines';

describe('Worker Native Engine Fallback Classification', () => {
  let tmpDir: string;
  const origFfmpeg = process.env.FFMPEG_PATH;
  const origSoffice = process.env.SOFFICE_PATH;
  const origP7zip = process.env.P7ZIP_PATH;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-fallback-test-'));
  });

  afterEach(() => {
    if (origFfmpeg !== undefined) process.env.FFMPEG_PATH = origFfmpeg;
    else delete process.env.FFMPEG_PATH;

    if (origSoffice !== undefined) process.env.SOFFICE_PATH = origSoffice;
    else delete process.env.SOFFICE_PATH;

    if (origP7zip !== undefined) process.env.P7ZIP_PATH = origP7zip;
    else delete process.env.P7ZIP_PATH;

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // Helper to create a valid minimal 44-byte WAV buffer for testing
  function createTestWav(): Buffer {
    const buf = Buffer.alloc(44);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20); // PCM
    buf.writeUInt16LE(1, 22); // mono
    buf.writeUInt32LE(44100, 24); // sample rate
    buf.writeUInt32LE(88200, 28); // byte rate
    buf.writeUInt16LE(2, 32); // block align
    buf.writeUInt16LE(16, 34); // bits per sample
    buf.write('data', 36);
    buf.writeUInt32LE(0, 40);
    return buf;
  }

  it('fails closed and rethrows when a native engine crashes or exits with non-zero status', async () => {
    const crashingFfmpeg = path.join(tmpDir, 'failing-ffmpeg.sh');
    fs.writeFileSync(crashingFfmpeg, '#!/bin/sh\necho "Transcoding failed: corrupted bitstream" >&2\nexit 1\n');
    fs.chmodSync(crashingFfmpeg, 0o755);
    process.env.FFMPEG_PATH = crashingFfmpeg;

    const wav = createTestWav();

    // Must NOT fall back silently to internal engine; must throw the native error
    await expect(
      executeWorkerConversion(wav, 'wav', 'mp3', {}, 'input.wav')
    ).rejects.toThrow(/Transcoding failed: corrupted bitstream/);
  });

  it('records fallbackChain and gracefully delegates to internal fallback when native binary is absent', async () => {
    process.env.FFMPEG_PATH = path.join(tmpDir, 'nonexistent-ffmpeg');

    const wav = createTestWav();
    const result = await executeWorkerConversion(wav, 'wav', 'flac', {}, 'input.wav');

    expect(result.engineUsed).toBe('internal-fallback');
    expect(result.fallbackChain).toBeDefined();
    expect(Array.isArray(result.fallbackChain)).toBe(true);
    expect(result.fallbackChain!.length).toBeGreaterThan(0);
    expect(result.fallbackChain![0]).toContain('native-ffmpeg');
  });

  it('fails closed when native engine completes without producing output', async () => {
    const noOutputFfmpeg = path.join(tmpDir, 'no-output-ffmpeg.sh');
    fs.writeFileSync(noOutputFfmpeg, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(noOutputFfmpeg, 0o755);
    process.env.FFMPEG_PATH = noOutputFfmpeg;

    const wav = createTestWav();

    // When the binary exits 0 but does not produce the expected output file
    await expect(
      executeWorkerConversion(wav, 'wav', 'mp3', {}, 'input.wav')
    ).rejects.toThrow(/without producing expected output/i);
  });
});
