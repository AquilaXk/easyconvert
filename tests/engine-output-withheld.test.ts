import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { convertFile } from '../src/lib/conversions';
import { ffmpegFailureReason } from '../src/lib/conversions/media-failure-reason';
import { endOfRun, recordEngineOutput } from '../src/lib/engine-output';
import { SandboxedProcessError } from '../src/lib/security/process-sandbox';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * The output of a program that failed (FFmpeg's build banner and configure line, a Python traceback) is written to the server
 * log and never put in the error a caller reads. The banner below is the one a production FFmpeg prints (Debian build).
 */

const BANNER = [
  'ffmpeg version 9.0.2 Copyright (c) 2000-2026 the FFmpeg developers',
  '  built with gcc 14 (Debian 14.2.0-19)',
  '  configuration: --prefix=/usr --toolchain=hardened --enable-gpl --enable-libx264 --enable-libx265 --disable-stripping',
  '  libavutil      60.  8.100 / 60.  8.100',
].join('\n');

function processError(log: string, exitCode: number | null = 183, signal: NodeJS.Signals | null = null): SandboxedProcessError {
  return new SandboxedProcessError(log, exitCode, log, signal);
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

describe('what a failed FFmpeg run says to the caller', () => {
  it.each([
    ["[AVFormatContext @ 0x780f017700] Unable to choose an output format for 'o.3gpp'; use a standard extension.", 'the target container has no FFmpeg muxer.'],
    ['[mpeg @ 0x752d014280] Unsupported audio codec. Must be one of mp1, mp2.\n[out#0/mpeg] Could not write header (incorrect codec parameters ?)', 'the target container cannot carry a stream of the input.'],
    ['[h263 @ 0x7581015180] The specified picture size of 320x240 is not valid for the H.263 codec.\nError while opening encoder', 'the encoder cannot take the size, rate or channel layout of the stream.'],
  ])('names the cause in a short sentence and keeps the log out: %#', (tail, reason) => {
    const message = ffmpegFailureReason(processError(`${BANNER}\n${tail}`));
    expect(message).toBe(reason);
    expect(message).not.toMatch(/ffmpeg version|configuration|--enable|libavutil|0x[0-9a-f]{6}/);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(warn.mock.calls[0][0])) as { engine: string; output: string };
    expect(line.engine).toBe('ffmpeg');
    expect(line.output).toContain('configuration: --prefix=/usr');
  });

  it('gives the exit status of a failure no rule knows, and the signal of a run that was stopped', () => {
    expect(ffmpegFailureReason(processError(`${BANNER}\nsomething new`, 1))).toBe('FFmpeg exited with status 1.');
    expect(ffmpegFailureReason(processError(BANNER, null, 'SIGKILL'))).toBe('FFmpeg was stopped by SIGKILL.');
  });

  it('quotes an error that is not a run of the program', () => {
    expect(ffmpegFailureReason(new Error('The output has no audio stream.'))).toBe('The output has no audio stream.');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the shared record', () => {
  it('writes the end of a long output as one JSON line and nothing for an empty one', () => {
    recordEngineOutput('calibre', 'chm-to-epub', `${'x'.repeat(10_000)}\nAttributeError: 'NoneType' object has no attribute 'lstrip'`);
    recordEngineOutput('calibre', 'chm-to-epub', '  \n');
    expect(warn).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(warn.mock.calls[0][0])) as { output: string };
    expect(line.output.length).toBe(4000);
    expect(line.output.endsWith("'lstrip'")).toBe(true);
  });

  it('tells how a program ended', () => {
    expect(endOfRun({ exitCode: 2, signal: null })).toBe('it exited with status 2');
    expect(endOfRun({ exitCode: null, signal: 'SIGSEGV' })).toBe('it was stopped by SIGSEGV');
  });
});

describe.skipIf(skipWithoutTools('ffmpeg', 'ffprobe'))('a real run that fails', () => {
  it('answers a damaged MP4 with a sentence and not with the log of ffprobe', async () => {
    const mp4 = fs.readFileSync('bench/corpus/clip.mp4').subarray(0, 3000);
    const failure = await convertFile(mp4, 'mp4', 'avi', {}, 'clip.mp4').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(/ffprobe could not inspect the input media: it is damaged/);
    expect(message).not.toMatch(/moov atom|0x[0-9a-f]{6}|\[mov,mp4/);
  }, 60_000);
});
