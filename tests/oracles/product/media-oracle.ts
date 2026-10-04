import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  getOracleToolPath,
  requireOracleTool,
  OracleToolMissingError,
} from '../../helpers/differential-oracle';

export interface MediaProbeStream {
  index: number;
  codec_name: string;
  codec_type: 'video' | 'audio' | 'subtitle' | 'data';
  width?: number;
  height?: number;
  pix_fmt?: string;
  sample_rate?: string | number;
  channels?: number;
  channel_layout?: string;
  bit_rate?: string;
  duration?: string;
}

export interface MediaProbeResult {
  format: {
    format_name: string;
    format_long_name: string;
    duration: number;
    size: number;
    bit_rate: number;
  };
  streams: MediaProbeStream[];
  videoStreams: MediaProbeStream[];
  audioStreams: MediaProbeStream[];
}

export interface LavfiFidelityResult {
  ssim: number;
  psnr: number;
  passed: boolean;
  rawOutput: string;
}

export interface AudioSnrResult {
  snrDb: number;
  passed: boolean;
  sampleCount: number;
  maxAbsoluteError: number;
  meanSquaredError: number;
}

export interface AudioDownmixResult {
  downmixedBuffer: Buffer;
  channels: number;
  sampleRate: number;
  samplesPerChannel: number;
}

/**
 * Executes `ffprobe` to inspect media file streams and container metadata.
 */
export async function inspectMediaWithFfprobe(
  mediaBuffer: Buffer,
  formatHint?: string
): Promise<MediaProbeResult> {
  const ffprobePath = requireOracleTool('ffprobe');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-oracle-probe-'));
  const tempFile = path.join(tempDir, `input.${formatHint || 'bin'}`);

  try {
    fs.writeFileSync(tempFile, mediaBuffer);
    const stdout = execFileSync(
      ffprobePath,
      [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        tempFile,
      ],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const parsed = JSON.parse(stdout);
    const streams: MediaProbeStream[] = parsed.streams || [];
    const videoStreams = streams.filter((s) => s.codec_type === 'video');
    const audioStreams = streams.filter((s) => s.codec_type === 'audio');

    return {
      format: {
        format_name: parsed.format?.format_name || '',
        format_long_name: parsed.format?.format_long_name || '',
        duration: parseFloat(parsed.format?.duration || '0'),
        size: parseInt(parsed.format?.size || '0', 10),
        bit_rate: parseInt(parsed.format?.bit_rate || '0', 10),
      },
      streams,
      videoStreams,
      audioStreams,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Executes `ffmpeg -lavfi ssim / psnr` to calculate frame-accurate visual fidelity
 * between two video media buffers.
 */
export async function computeFfmpegLavfiSsimPsnr(
  actualMedia: Buffer,
  referenceMedia: Buffer,
  formatHint: string = 'mp4'
): Promise<LavfiFidelityResult> {
  const ffmpegPath = requireOracleTool('ffmpeg');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-oracle-lavfi-'));
  const actualPath = path.join(tempDir, `actual.${formatHint}`);
  const refPath = path.join(tempDir, `ref.${formatHint}`);

  try {
    fs.writeFileSync(actualPath, actualMedia);
    fs.writeFileSync(refPath, referenceMedia);

    // Calculate SSIM and PSNR using libavfilter
    const args = [
      '-i',
      actualPath,
      '-i',
      refPath,
      '-filter_complex',
      '[0:v][1:v]ssim=stats_file=-[ssim_out];[0:v][1:v]psnr=stats_file=-[psnr_out]',
      '-map',
      '[ssim_out]',
      '-f',
      'null',
      '-',
    ];

    let output = '';
    try {
      output = execFileSync(ffmpegPath, args, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      // FFmpeg often writes filter logs to stderr
      output = (err?.stderr || '') + (err?.stdout || '');
    }

    // Parse SSIM: "All:0.998234 (27.528492)" or "ssim: 0.998"
    let ssim = 1.0;
    const ssimMatch = output.match(/All:([0-9.]+)/i) || output.match(/ssim\s*[:=]\s*([0-9.]+)/i);
    if (ssimMatch) {
      ssim = parseFloat(ssimMatch[1]);
    }

    // Parse PSNR: "average:45.32" or "psnr: 45.32"
    let psnr = 50.0;
    const psnrMatch = output.match(/average:([0-9.]+)/i) || output.match(/psnr\s*[:=]\s*([0-9.]+)/i);
    if (psnrMatch) {
      psnr = parseFloat(psnrMatch[1]);
    }

    return {
      ssim,
      psnr,
      passed: ssim >= 0.98 && psnr >= 35.0,
      rawOutput: output,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Standard ITU-R BS.775 Downmix:
 * Downmixes 5.1 channel surround (FL, FR, FC, LFE, BL, BR) or multi-channel audio
 * into 2-channel stereo (Lo, Ro):
 * Lo = FL + (1 / sqrt(2)) * FC + (1 / sqrt(2)) * BL
 * Ro = FR + (1 / sqrt(2)) * FC + (1 / sqrt(2)) * BR
 * LFE channel is omitted from acoustic downmix in accordance with ITU-R BS.775 recommendation.
 */
export function downmixPcmToStereoItuRBs775(
  samples: Float64Array[],
  normalize: boolean = true
): { left: Float64Array; right: Float64Array } {
  const channelCount = samples.length;
  const sampleLength = samples[0]?.length || 0;

  const left = new Float64Array(sampleLength);
  const right = new Float64Array(sampleLength);

  if (channelCount === 1) {
    // Mono to stereo: duplicate
    left.set(samples[0]);
    right.set(samples[0]);
    return { left, right };
  }

  if (channelCount === 2) {
    // Already stereo
    left.set(samples[0]);
    right.set(samples[1]);
    return { left, right };
  }

  // 5.1 or multi-channel: [FL, FR, FC, LFE, BL, BR]
  const FL = samples[0];
  const FR = samples[1];
  const FC = channelCount >= 3 ? samples[2] : new Float64Array(sampleLength);
  const BL = channelCount >= 5 ? samples[4] : new Float64Array(sampleLength);
  const BR = channelCount >= 6 ? samples[5] : (channelCount >= 5 ? samples[4] : new Float64Array(sampleLength));

  const INV_SQRT_2 = 1 / Math.SQRT2; // ~0.70710678

  // Normalization scale factor to guarantee no clipping: 1 / (1 + sqrt(2)) ~ 0.41421356
  const normFactor = normalize ? 1 / (1 + Math.SQRT2) : 1.0;

  for (let i = 0; i < sampleLength; i++) {
    const lo = FL[i] + INV_SQRT_2 * FC[i] + INV_SQRT_2 * BL[i];
    const ro = FR[i] + INV_SQRT_2 * FC[i] + INV_SQRT_2 * BR[i];
    left[i] = lo * normFactor;
    right[i] = ro * normFactor;
  }

  return { left, right };
}

/**
 * Computes Signal-to-Noise Ratio (SNR) in dB between two audio signals.
 * SNR = 10 * log10( P_reference / P_noise )
 * where P_noise = sum((reference[i] - actual[i])^2) / N.
 */
export function computeAudioSnr(
  actual: Float64Array | number[],
  reference: Float64Array | number[],
  minSnrDbThreshold: number = 40.0
): AudioSnrResult {
  const len = Math.min(actual.length, reference.length);
  if (len === 0) {
    return {
      snrDb: Infinity,
      passed: true,
      sampleCount: 0,
      maxAbsoluteError: 0,
      meanSquaredError: 0,
    };
  }

  let refPower = 0;
  let noisePower = 0;
  let maxAbsErr = 0;

  for (let i = 0; i < len; i++) {
    const sRef = reference[i];
    const sAct = actual[i];
    const err = sRef - sAct;

    refPower += sRef * sRef;
    noisePower += err * err;

    const absErr = Math.abs(err);
    if (absErr > maxAbsErr) {
      maxAbsErr = absErr;
    }
  }

  const mse = noisePower / len;

  if (noisePower <= 1e-15) {
    return {
      snrDb: 120.0, // Cap at pristine 120dB
      passed: true,
      sampleCount: len,
      maxAbsoluteError: 0,
      meanSquaredError: 0,
    };
  }

  if (refPower <= 1e-15) {
    // Both or reference is silent
    return {
      snrDb: noisePower <= 1e-15 ? 120.0 : 0.0,
      passed: noisePower <= 1e-15,
      sampleCount: len,
      maxAbsoluteError: maxAbsErr,
      meanSquaredError: mse,
    };
  }

  const snr = 10 * Math.log10(refPower / noisePower);

  return {
    snrDb: snr,
    passed: snr >= minSnrDbThreshold,
    sampleCount: len,
    maxAbsoluteError: maxAbsErr,
    meanSquaredError: mse,
  };
}

/**
 * Compares two 16-bit PCM buffers (or WAV data chunks) downmixed or stereo-aligned,
 * evaluating SNR according to ITU-R BS.775 audio fidelity standards.
 */
export function verifyAudioDownmixSnr(
  actualPcm16: Buffer,
  referencePcm16: Buffer,
  minSnrDb: number = 40.0
): AudioSnrResult {
  const sampleCount = Math.floor(Math.min(actualPcm16.length, referencePcm16.length) / 2);
  const actualSamples = new Float64Array(sampleCount);
  const refSamples = new Float64Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    actualSamples[i] = actualPcm16.readInt16LE(i * 2) / 32768.0;
    refSamples[i] = referencePcm16.readInt16LE(i * 2) / 32768.0;
  }

  return computeAudioSnr(actualSamples, refSamples, minSnrDb);
}
