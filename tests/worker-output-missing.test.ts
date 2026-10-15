import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertWithNativeFfmpeg, createConversionResult } from '../src/worker/engines';
import { LibreOfficePoolManager, type SandboxedProcessRunner } from '../src/worker/libreoffice-pool';
import { ConversionFailedError, WorkerOutputMissingError } from '../src/lib/types';
import { classifyJobFailure } from '../src/lib/queue/job-failure';
import { oracleTest } from './helpers/oracle-test';

/**
 * Issue #484: the lazy `buffer` of a worker result used to answer `Buffer.alloc(0)` once the persisted
 * output file was gone, so a vanished artifact was stored and served as a successful 0-byte result.
 */

const PCM_SAMPLE_RATE_HZ = 8000;
const PCM_BYTES_PER_SAMPLE = 2;
const PCM_SAMPLE_COUNT = 4000;
const WAV_HEADER_BYTES = 44;
const WAV_FMT_CHUNK_BYTES = 16;
const WAV_FORMAT_PCM = 1;
const WAV_CHANNELS = 1;
const BITS_PER_BYTE = 8;
const HTTP_INTERNAL_SERVER_ERROR = 500;

/** RIFF/WAVE container with 16-bit mono PCM silence, laid out by hand from the WAVE format definition. */
function silentWav(): Buffer {
  const dataBytes = PCM_SAMPLE_COUNT * PCM_BYTES_PER_SAMPLE;
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(WAV_HEADER_BYTES - 8 + dataBytes, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(WAV_FMT_CHUNK_BYTES, 16);
  header.writeUInt16LE(WAV_FORMAT_PCM, 20);
  header.writeUInt16LE(WAV_CHANNELS, 22);
  header.writeUInt32LE(PCM_SAMPLE_RATE_HZ, 24);
  header.writeUInt32LE(PCM_SAMPLE_RATE_HZ * PCM_BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(PCM_BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(PCM_BYTES_PER_SAMPLE * BITS_PER_BYTE, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

/** Reads `.buffer` and reports the typed error, or the buffer length when nothing was thrown. */
function readBuffer(result: { buffer: Buffer }): { error?: unknown; length?: number } {
  try {
    return { length: result.buffer.length };
  } catch (error) {
    return { error };
  }
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-output-missing-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('a persisted worker output that disappeared', () => {
  oracleTest('fails a real ffmpeg result with WorkerOutputMissingError instead of a 0-byte buffer', ['ffmpeg'], async () => {
    const outputPath = path.join(tempDir(), 'tone.mp3');
    // The engine function itself: the aggregate executeWorkerConversion spreads the result, which reads the file at once.
    const result = await convertWithNativeFfmpeg(silentWav(), 'wav', 'mp3', { outputPath, throwOnUnavailable: true }, 'tone.wav');
    expect(result).not.toBeNull();

    expect(result!.engineUsed).toBe('native-ffmpeg');
    expect(result!.filePath).toBe(outputPath);
    expect(result!.size).toBe(fs.statSync(outputPath).size);
    expect(result!.size).toBeGreaterThan(0);

    fs.rmSync(outputPath);

    const read = readBuffer(result!);
    expect(read.length).toBeUndefined();
    expect(read.error).toBeInstanceOf(WorkerOutputMissingError);
    expect(read.error).toBeInstanceOf(ConversionFailedError);
    expect((read.error as WorkerOutputMissingError).name).toBe('WorkerOutputMissingError');
  });

  it('fails a LibreOffice pool result with WorkerOutputMissingError instead of a 0-byte buffer', async () => {
    const outputPath = path.join(tempDir(), 'report.pdf');
    const pdfBytes = Buffer.from('%PDF-1.7\n%%EOF\n', 'latin1');
    // Stands in for the sandboxed soffice process: it writes the converted file where soffice would.
    const executor: SandboxedProcessRunner = async (_bin, args, options) => {
      if (options?.cwd && args.includes('--convert-to')) {
        fs.writeFileSync(path.join(options.cwd, 'input.pdf'), pdfBytes);
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 } as never;
    };
    const pool = new LibreOfficePoolManager({
      sofficePath: '/usr/bin/soffice',
      minWorkers: 1,
      maxWorkers: 1,
      executor,
      enabled: true,
    });
    try {
      const result = await pool.convert({ inputBuffer: Buffer.from('x'), outputPath }, 'docx', 'pdf', {}, 'report.docx');
      expect(result).not.toBeNull();
      expect(result!.engineUsed).toBe('native-soffice-pool');
      expect(fs.readFileSync(outputPath).equals(pdfBytes)).toBe(true);
      expect(result!.size).toBe(pdfBytes.length);

      fs.rmSync(outputPath);

      const read = readBuffer(result!);
      expect(read.length).toBeUndefined();
      expect(read.error).toBeInstanceOf(WorkerOutputMissingError);
    } finally {
      await pool.shutdown();
    }
  });

  it('keeps answering with the stored bytes while the persisted file exists', () => {
    const outputPath = path.join(tempDir(), 'result.json');
    const payload = '{"result": true}';
    fs.writeFileSync(outputPath, payload);

    const result = createConversionResult(outputPath, 'json', 'result', 'internal-fallback', 1);
    expect(result.buffer.toString('utf-8')).toBe(payload);
  });

  it('never exposes the persisted path in the error and classifies it as a non-retryable server fault', () => {
    const outputPath = path.join(tempDir(), 'secret-location-result.json');
    fs.writeFileSync(outputPath, '{}');
    const result = createConversionResult(outputPath, 'json', 'result', 'internal-fallback', 1);
    fs.rmSync(outputPath);

    const { error } = readBuffer(result);
    expect(error).toBeInstanceOf(WorkerOutputMissingError);
    const typed = error as WorkerOutputMissingError;
    expect(typed.message).not.toContain(outputPath);
    expect(typed.message).not.toContain(path.dirname(outputPath));
    expect(typed.status).toBe(HTTP_INTERNAL_SERVER_ERROR);
    // A server fault, not a verdict on the input and not a missing tool: the job fails with 500 and is not retried.
    expect(classifyJobFailure(typed)).toEqual({
      code: 'WorkerOutputMissingError',
      status: HTTP_INTERNAL_SERVER_ERROR,
      retryable: false,
    });
  });
});
