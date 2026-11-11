import fs from 'node:fs';
import path from 'node:path';
import {
  CpuTaskTimeoutError,
  EngineUnavailableError,
  UnprocessableMediaInputError,
  type ConversionOptions,
} from '../types';
import {
  SandboxedBufferLimitError,
  SandboxedMemoryLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
  cleanupWorkerSandboxDir,
  createWorkerSandboxDir,
  executeSandboxedBinary,
  rethrowSandboxUnavailable,
} from '../../worker/sandbox';
import { stageTimeoutMs, type JobDeadlined } from './job-time';
import { resolveBinaryPath } from './pdf-postprocess/utils';
import { parseWavPcmHeader, type WavPcmInfo } from './wav-header';

/**
 * MIDI sources. A Standard MIDI File holds notes, not sound, and FFmpeg has no reader for it, so the worker renders the
 * file to a WAV with FluidSynth (LGPL-2.1, run unmodified as a separate sandboxed process) and a General MIDI SoundFont, and
 * the audio pipeline encodes that WAV to the requested target. A missing synthesizer or SoundFont is an error: no other
 * path can make sound of these files.
 */

const MIDI_SOURCES: ReadonlySet<string> = new Set(['mid', 'midi']);

const PROGRAM_NAME = 'fluidsynth';
const PROGRAM_PATH_VARIABLE = 'FLUIDSYNTH_PATH';
const PROGRAM_CANDIDATES = ['/usr/bin/fluidsynth', '/usr/local/bin/fluidsynth', '/opt/homebrew/bin/fluidsynth'];
/** The SoundFont an operator names; the first existing candidate otherwise. `default-GM.sf2` is the Debian alternatives link to the installed General MIDI SoundFont. */
const SOUNDFONT_PATH_VARIABLE = 'MIDI_SOUNDFONT_PATH';
const SOUNDFONT_CANDIDATES = [
  '/usr/share/sounds/sf2/default-GM.sf2',
  '/usr/share/sounds/sf2/FluidR3_GM.sf2',
  '/usr/share/sounds/sf2/TimGM6mb.sf2',
  '/usr/share/soundfonts/default.sf2',
  '/opt/homebrew/share/soundfonts/default.sf2',
];

/** Sample rate of the render: the CD rate, which the audio targets take as they are or resample by their own rules. */
const RENDER_SAMPLE_RATE = 44_100;
/** The renderer is several times faster than real time; a piece may take this long at most. */
const RENDER_DEFAULT_TIMEOUT_MS = 120_000;
const RENDER_MEMORY_LIMIT_MB = 2048;
/** Largest render accepted: 16-bit stereo at 44.1 kHz makes 176 400 bytes a second, so this is about 25 minutes of sound. */
const RENDER_MAX_BYTES = 256 * 1024 * 1024;
const RENDER_MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
const SHELL_NOT_EXECUTABLE = 126;
const SHELL_NOT_FOUND = 127;
const MAX_DETAIL_CHARS = 200;
const UNPRINTABLE = /[^\x20-\x7e]/g;
const ERROR_LINE = /^fluidsynth: error: (.*)$/m;

const SMF_MAGIC = 'MThd';
const RIFF_MAGIC = 'RIFF';
const RMID_FORM = 'RMID';
const RIFF_FORM_OFFSET = 8;
const WAV_FORMAT_PCM = 1;
const BYTES_PER_SAMPLE = 2;
const PCM16_FULL_SCALE = 32768;
/** The loudest sample of a delivered render, in dBFS: below full scale so that the encoders downstream do not clip. */
const TARGET_PEAK_DBFS = -1;
const TARGET_PEAK = Math.floor(PCM16_FULL_SCALE * 10 ** (TARGET_PEAK_DBFS / 20));

export type MidiRenderOptions = Pick<ConversionOptions, 'signal' | 'timeoutMs'> & JobDeadlined;

/** Whether the format is a MIDI source the audio pipeline renders before it encodes. */
export function isMidiSource(format: string): boolean {
  return MIDI_SOURCES.has(format);
}

function programBinary(): string {
  const binary = resolveBinaryPath(PROGRAM_PATH_VARIABLE, PROGRAM_CANDIDATES, PROGRAM_NAME);
  if (binary === null) {
    throw new EngineUnavailableError(PROGRAM_NAME, 'fluidsynth is not installed or not in PATH');
  }
  return binary;
}

function soundFontPath(): string {
  const named = process.env[SOUNDFONT_PATH_VARIABLE];
  if (named !== undefined) {
    if (named !== '' && fs.existsSync(named)) return named;
    throw new EngineUnavailableError(PROGRAM_NAME, `the General MIDI SoundFont named by ${SOUNDFONT_PATH_VARIABLE} does not exist`);
  }
  const found = SOUNDFONT_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (found === undefined) {
    throw new EngineUnavailableError(PROGRAM_NAME, 'no General MIDI SoundFont is installed (set MIDI_SOUNDFONT_PATH)');
  }
  return found;
}

/** The Standard MIDI File inside `input`: the file itself, or the data of an RMID wrapper. */
function standardMidiFile(input: Buffer): Buffer {
  if (input.toString('latin1', 0, SMF_MAGIC.length) === SMF_MAGIC) return input;
  const isRmid = input.toString('latin1', 0, RIFF_MAGIC.length) === RIFF_MAGIC && input.toString('latin1', RIFF_FORM_OFFSET, RIFF_FORM_OFFSET + RMID_FORM.length) === RMID_FORM;
  const start = isRmid ? input.indexOf(SMF_MAGIC) : -1;
  if (start < 0) throw new UnprocessableMediaInputError('The file is not a Standard MIDI File: it does not start with the MThd header.');
  return input.subarray(start);
}

/** The error line the program printed, with the scratch directory and every unprintable character removed. */
function diagnostic(stderr: string, sandboxDir: string): string {
  const line = ERROR_LINE.exec(stderr.replaceAll(sandboxDir, '<tmp>'))?.[1];
  return line === undefined ? '' : ` (${line.replace(UNPRINTABLE, '?').slice(0, MAX_DETAIL_CHARS)})`;
}

function toRenderError(error: unknown, sandboxDir: string, timeoutMs: number): unknown {
  rethrowSandboxUnavailable(error);
  if (error instanceof SandboxedTimeoutError) return new CpuTaskTimeoutError('MIDI renderer', timeoutMs);
  if (error instanceof SandboxedMemoryLimitError) return new UnprocessableMediaInputError('The MIDI renderer ran out of memory or crashed on this file.');
  if (error instanceof SandboxedBufferLimitError) {
    return new UnprocessableMediaInputError('The MIDI file plays longer than the renderer may write: about 25 minutes of sound at most.');
  }
  if (error instanceof SandboxedProcessError) {
    if (error.exitCode === SHELL_NOT_FOUND || error.exitCode === SHELL_NOT_EXECUTABLE) {
      return new EngineUnavailableError(PROGRAM_NAME, 'fluidsynth could not be started');
    }
    const how = error.signal ? `was stopped by ${error.signal}` : `exited with status ${error.exitCode}`;
    return new UnprocessableMediaInputError(`The MIDI renderer could not render this file: it ${how}${diagnostic(error.stderr, sandboxDir)}.`);
  }
  return error;
}

/** The sample data of a 16-bit integer PCM WAV, or null for any other layout. */
function pcm16Data(info: WavPcmInfo | null): { start: number; end: number } | null {
  if (info === null || info.formatTag !== WAV_FORMAT_PCM || info.bitsPerSample !== BYTES_PER_SAMPLE * 8) return null;
  return { start: info.dataOffset, end: info.dataOffset + info.dataBytes };
}

/**
 * Scales a 16-bit PCM WAV by one linear gain so that its loudest sample is at -1 dBFS. FluidSynth renders at a gain that leaves
 * a piece 15 to 23 dB below full scale; the gain is applied here, where the peak is known, because a higher synthesizer gain
 * clips dense files. A file whose peak is already at or above -1 dBFS, a silent one and any other WAV layout are returned as they are.
 */
export function normalizeWavPeak(wav: Buffer): Buffer {
  const range = pcm16Data(parseWavPcmHeader(wav, wav.length));
  if (range === null) return wav;
  const samples = Math.floor((range.end - range.start) / BYTES_PER_SAMPLE);
  let peak = 0;
  for (let i = 0; i < samples; i++) peak = Math.max(peak, Math.abs(wav.readInt16LE(range.start + i * BYTES_PER_SAMPLE)));
  if (peak === 0 || peak >= TARGET_PEAK) return wav;
  const gain = TARGET_PEAK / peak;
  const scaled = Buffer.from(wav);
  for (let i = 0; i < samples; i++) {
    const at = range.start + i * BYTES_PER_SAMPLE;
    scaled.writeInt16LE(Math.round(wav.readInt16LE(at) * gain), at);
  }
  return scaled;
}

/**
 * Renders a Standard MIDI File to a 16-bit stereo WAV at 44.1 kHz whose peak is at -1 dBFS. Fails with a typed error for bytes that are not a MIDI
 * file, a file the renderer rejects, one that plays past the length limit, and a render that outruns its time; with an
 * engine-unavailable error (503, retried on another worker) when the synthesizer or the SoundFont is missing. A render that
 * wrote no sound is an error, never an empty file.
 */
export async function renderMidiToWav(input: Buffer, options: MidiRenderOptions = {}): Promise<Buffer> {
  const midi = standardMidiFile(input);
  const binary = programBinary();
  const soundFont = soundFontPath();
  const timeoutMs = stageTimeoutMs(options, RENDER_DEFAULT_TIMEOUT_MS);
  const sandboxDir = createWorkerSandboxDir();
  try {
    const inputPath = path.join(sandboxDir, 'input.mid');
    const outputPath = path.join(sandboxDir, 'output.wav');
    fs.writeFileSync(inputPath, midi, { mode: 0o600 });
    try {
      await executeSandboxedBinary(binary, ['-ni', '-q', '-r', String(RENDER_SAMPLE_RATE), '-T', 'wav', '-F', outputPath, soundFont, inputPath], {
        cwd: sandboxDir,
        timeoutMs,
        maxBuffer: RENDER_MAX_DIAGNOSTIC_BYTES,
        maxFileSize: RENDER_MAX_BYTES,
        memoryLimitMb: RENDER_MEMORY_LIMIT_MB,
        networkIsolated: true,
        signal: options.signal,
      });
    } catch (error) {
      throw toRenderError(error, sandboxDir, timeoutMs);
    }
    // The program exits with status 0 after refusing a file it cannot open, so the output is what proves a render.
    if (!fs.existsSync(outputPath)) {
      throw new UnprocessableMediaInputError('The MIDI renderer wrote no sound: the file is not a MIDI file it can play.');
    }
    const wav = fs.readFileSync(outputPath);
    // The header reader answers null for a data chunk without one whole sample frame, as for any layout it cannot read.
    if (parseWavPcmHeader(wav, wav.length) === null) {
      throw new UnprocessableMediaInputError('The MIDI renderer wrote no sound from this file.');
    }
    return normalizeWavPeak(wav);
  } finally {
    cleanupWorkerSandboxDir(sandboxDir);
  }
}
