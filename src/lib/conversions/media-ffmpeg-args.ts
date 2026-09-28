import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ConversionOptions } from '../types';

export interface HardwareAccelerationCapabilities {
  nvenc: boolean;
  vaapi: boolean;
  qsv: boolean;
  videotoolbox: boolean;
  supportedEncoders: Set<string>;
  probedAt: number;
}

let cachedHwCapabilities: HardwareAccelerationCapabilities | null = null;
let lastProbeTime = 0;
const PROBE_CACHE_TTL_MS = 60000;

export function resetHardwareAccelerationCache(): void {
  cachedHwCapabilities = null;
  lastProbeTime = 0;
}

/**
 * Dynamically probes FFmpeg binary for hardware-accelerated video encoders.
 * Caches results in-memory with a 60-second TTL to avoid redundant CLI executions.
 */
export function probeHardwareAcceleration(ffmpegPath?: string | null): HardwareAccelerationCapabilities {
  const now = Date.now();
  if (cachedHwCapabilities && now - lastProbeTime < PROBE_CACHE_TTL_MS) {
    return cachedHwCapabilities;
  }

  const defaultCaps: HardwareAccelerationCapabilities = {
    nvenc: false,
    vaapi: false,
    qsv: false,
    videotoolbox: false,
    supportedEncoders: new Set<string>(),
    probedAt: now,
  };

  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    cachedHwCapabilities = defaultCaps;
    lastProbeTime = now;
    return defaultCaps;
  }

  try {
    const output = execFileSync(ffmpegPath, ['-hide_banner', '-encoders'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });

    const supported = new Set<string>();
    const lines = output.split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*[VAF.S]{6}\s+([a-zA-Z0-9_-]+)/);
      if (match) {
        supported.add(match[1]);
      }
    }

    const hasDri = fs.existsSync('/dev/dri/renderD128') || fs.existsSync('/dev/dri/card0');
    const isDarwin = process.platform === 'darwin';

    const caps: HardwareAccelerationCapabilities = {
      nvenc: supported.has('h264_nvenc') || supported.has('hevc_nvenc'),
      vaapi: (supported.has('h264_vaapi') || supported.has('hevc_vaapi')) && hasDri,
      qsv: supported.has('h264_qsv') || supported.has('hevc_qsv'),
      videotoolbox: isDarwin && (supported.has('h264_videotoolbox') || supported.has('hevc_videotoolbox')),
      supportedEncoders: supported,
      probedAt: now,
    };

    cachedHwCapabilities = caps;
    lastProbeTime = now;
    return caps;
  } catch {
    cachedHwCapabilities = defaultCaps;
    lastProbeTime = now;
    return defaultCaps;
  }
}

/**
 * Builds optimized, compliant FFmpeg argument array with hardware acceleration,
 * faststart atom layout, and explicit codec mappings.
 */
export function buildFfmpegArguments(
  inputPath: string,
  outputPath: string,
  src: string,
  tgt: string,
  options: ConversionOptions = {},
  ffmpegBin?: string | null
): string[] {
  const globalArgs: string[] = ['-y'];
  const inputArgs: string[] = ['-i', inputPath];
  const outputArgs: string[] = [];

  const isVideo = ['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(tgt);
  const isAudioOnly = ['mp3', 'wav', 'aac', 'ogg', 'opus', 'flac', 'm4a', 'wma'].includes(tgt);

  if (isVideo) {
    const hw = probeHardwareAcceleration(ffmpegBin);
    const disableHw = Boolean(options.disableHwaccel);
    const driDev = fs.existsSync('/dev/dri/renderD128')
      ? '/dev/dri/renderD128'
      : fs.existsSync('/dev/dri/card0')
      ? '/dev/dri/card0'
      : null;

    if (tgt === 'mp4' || tgt === 'mov' || tgt === 'mkv') {
      const codec = options.videoCodec || 'h264';
      if (codec === 'h264') {
        if (!disableHw && hw.nvenc && hw.supportedEncoders.has('h264_nvenc')) {
          outputArgs.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '23');
        } else if (!disableHw && hw.vaapi && driDev && hw.supportedEncoders.has('h264_vaapi')) {
          globalArgs.push('-vaapi_device', driDev);
          outputArgs.push('-filter_hw_device', driDev, '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-qp', '24');
        } else if (!disableHw && hw.videotoolbox && hw.supportedEncoders.has('h264_videotoolbox')) {
          outputArgs.push('-c:v', 'h264_videotoolbox', '-q:v', '65');
        } else if (!disableHw && hw.qsv && hw.supportedEncoders.has('h264_qsv')) {
          outputArgs.push('-c:v', 'h264_qsv', '-global_quality', '23');
        } else {
          outputArgs.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23');
        }
      } else if (codec === 'hevc') {
        if (!disableHw && hw.nvenc && hw.supportedEncoders.has('hevc_nvenc')) {
          outputArgs.push('-c:v', 'hevc_nvenc', '-preset', 'p4', '-cq', '26');
        } else if (!disableHw && hw.vaapi && driDev && hw.supportedEncoders.has('hevc_vaapi')) {
          globalArgs.push('-vaapi_device', driDev);
          outputArgs.push('-filter_hw_device', driDev, '-vf', 'format=nv12,hwupload', '-c:v', 'hevc_vaapi', '-qp', '26');
        } else if (!disableHw && hw.videotoolbox && hw.supportedEncoders.has('hevc_videotoolbox')) {
          outputArgs.push('-c:v', 'hevc_videotoolbox', '-q:v', '65');
        } else {
          outputArgs.push('-c:v', 'libx265', '-preset', 'fast', '-crf', '26');
        }
      } else if (codec === 'vp9') {
        outputArgs.push('-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0');
      } else if (codec === 'av1') {
        outputArgs.push('-c:v', 'libaom-av1', '-crf', '32', '-b:v', '0');
      }

      if (tgt === 'mp4' || tgt === 'mov') {
        outputArgs.push('-movflags', '+faststart');
      }

      outputArgs.push('-c:a', 'aac');
      if (options.audioBitrate && /^\d+[kK]?$/.test(options.audioBitrate)) {
        outputArgs.push('-b:a', options.audioBitrate);
      } else {
        outputArgs.push('-b:a', '192k');
      }
    } else if (tgt === 'webm') {
      outputArgs.push('-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0');
      outputArgs.push('-c:a', 'libopus', '-b:a', '128k');
    } else if (tgt === 'avi') {
      outputArgs.push('-c:v', 'mpeg4', '-vtag', 'XVID');
      outputArgs.push('-c:a', 'libmp3lame', '-b:a', '192k');
    }
  } else if (isAudioOnly) {
    switch (tgt) {
      case 'mp3':
        outputArgs.push('-c:a', 'libmp3lame');
        break;
      case 'aac':
      case 'm4a':
        outputArgs.push('-c:a', 'aac');
        if (tgt === 'm4a') outputArgs.push('-movflags', '+faststart');
        break;
      case 'ogg':
        outputArgs.push('-c:a', 'libvorbis');
        break;
      case 'opus':
        outputArgs.push('-c:a', 'libopus');
        break;
      case 'flac':
        outputArgs.push('-c:a', 'flac');
        break;
      case 'wav':
        outputArgs.push('-c:a', 'pcm_s16le');
        break;
    }
    if (options.audioBitrate && /^\d+[kK]?$/.test(options.audioBitrate)) {
      outputArgs.push('-b:a', options.audioBitrate);
    }
  }

  // Audio channels
  if (options.audioChannels && ['mono', 'stereo', '5.1'].includes(options.audioChannels)) {
    outputArgs.push('-ac', options.audioChannels === 'mono' ? '1' : options.audioChannels === '5.1' ? '6' : '2');
  }

  // Audio sample rate
  if (typeof options.audioSampleRate === 'number' && Number.isFinite(options.audioSampleRate) && options.audioSampleRate >= 8000 && options.audioSampleRate <= 192000) {
    outputArgs.push('-ar', String(options.audioSampleRate));
  }

  // Audio volume
  if (typeof options.audioVolume === 'number' && Number.isFinite(options.audioVolume) && options.audioVolume >= 0 && options.audioVolume <= 200 && options.audioVolume !== 100) {
    const vol = options.audioVolume / 100;
    outputArgs.push('-filter:a', `volume=${vol}`);
  }

  // Video resolution
  if (options.videoResolution && options.videoResolution !== 'original') {
    const resMap: Record<string, string> = {
      '4k': '3840:2160',
      '1080p': '1920:1080',
      '720p': '1280:720',
      '480p': '854:480',
      '360p': '640:360',
    };
    if (resMap[options.videoResolution]) {
      const scaleFilter = `scale=${resMap[options.videoResolution]}:force_original_aspect_ratio=decrease`;
      const existingVfIdx = outputArgs.indexOf('-vf');
      if (existingVfIdx !== -1 && existingVfIdx + 1 < outputArgs.length) {
        outputArgs[existingVfIdx + 1] = `${scaleFilter},${outputArgs[existingVfIdx + 1]}`;
      } else {
        outputArgs.push('-vf', scaleFilter);
      }
    }
  }

  // Video frame rate
  if (typeof options.videoFps === 'number' && Number.isFinite(options.videoFps) && options.videoFps > 0 && options.videoFps <= 240) {
    outputArgs.push('-r', options.videoFps.toString());
  }

  // Video bitrate override
  if (typeof options.videoBitrate === 'number' && Number.isFinite(options.videoBitrate) && options.videoBitrate > 0) {
    outputArgs.push('-b:v', `${Math.floor(options.videoBitrate)}k`);
  }

  // Ensure odd video dimensions are normalized for H.264/HEVC/yuv420p to avoid encoder crashes
  if (isVideo && (tgt === 'mp4' || tgt === 'mov' || tgt === 'mkv')) {
    const codec = options.videoCodec || 'h264';
    if (codec === 'h264' || codec === 'hevc') {
      const vfIdx = outputArgs.indexOf('-vf');
      if (vfIdx === -1) {
        outputArgs.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
      }
      if (!outputArgs.includes('-pix_fmt')) {
        outputArgs.push('-pix_fmt', 'yuv420p');
      }
    }
  }

  return [...globalArgs, ...inputArgs, ...outputArgs, outputPath];
}
