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
  const args: string[] = ['-y', '-i', inputPath];

  const isVideo = ['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(tgt);
  const isAudioOnly = ['mp3', 'wav', 'aac', 'ogg', 'opus', 'flac', 'm4a', 'wma'].includes(tgt);

  if (isVideo) {
    const hw = probeHardwareAcceleration(ffmpegBin);
    const disableHw = Boolean(options.disableHwaccel);

    if (tgt === 'mp4' || tgt === 'mov' || tgt === 'mkv') {
      const codec = options.videoCodec || 'h264';
      if (codec === 'h264') {
        if (!disableHw && hw.nvenc && hw.supportedEncoders.has('h264_nvenc')) {
          args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '23');
        } else if (!disableHw && hw.vaapi && hw.supportedEncoders.has('h264_vaapi')) {
          const driDev = fs.existsSync('/dev/dri/renderD128') ? '/dev/dri/renderD128' : '/dev/dri/card0';
          args.push('-vaapi_device', driDev, '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-qp', '24');
        } else if (!disableHw && hw.videotoolbox && hw.supportedEncoders.has('h264_videotoolbox')) {
          args.push('-c:v', 'h264_videotoolbox', '-q:v', '65');
        } else if (!disableHw && hw.qsv && hw.supportedEncoders.has('h264_qsv')) {
          args.push('-c:v', 'h264_qsv', '-global_quality', '23');
        } else {
          args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23');
        }
      } else if (codec === 'hevc') {
        if (!disableHw && hw.nvenc && hw.supportedEncoders.has('hevc_nvenc')) {
          args.push('-c:v', 'hevc_nvenc', '-preset', 'p4', '-cq', '26');
        } else if (!disableHw && hw.vaapi && hw.supportedEncoders.has('hevc_vaapi')) {
          const driDev = fs.existsSync('/dev/dri/renderD128') ? '/dev/dri/renderD128' : '/dev/dri/card0';
          args.push('-vaapi_device', driDev, '-vf', 'format=nv12,hwupload', '-c:v', 'hevc_vaapi', '-qp', '26');
        } else if (!disableHw && hw.videotoolbox && hw.supportedEncoders.has('hevc_videotoolbox')) {
          args.push('-c:v', 'hevc_videotoolbox', '-q:v', '65');
        } else {
          args.push('-c:v', 'libx265', '-preset', 'fast', '-crf', '26');
        }
      } else if (codec === 'vp9') {
        args.push('-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0');
      } else if (codec === 'av1') {
        args.push('-c:v', 'libaom-av1', '-crf', '32', '-b:v', '0');
      }

      if (tgt === 'mp4' || tgt === 'mov') {
        args.push('-movflags', '+faststart');
      }

      args.push('-c:a', 'aac');
      if (options.audioBitrate && /^\d+[kK]?$/.test(options.audioBitrate)) {
        args.push('-b:a', options.audioBitrate);
      } else {
        args.push('-b:a', '192k');
      }
    } else if (tgt === 'webm') {
      args.push('-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0');
      args.push('-c:a', 'libopus', '-b:a', '128k');
    } else if (tgt === 'avi') {
      args.push('-c:v', 'mpeg4', '-vtag', 'XVID');
      args.push('-c:a', 'libmp3lame', '-b:a', '192k');
    }
  } else if (isAudioOnly) {
    switch (tgt) {
      case 'mp3':
        args.push('-c:a', 'libmp3lame');
        break;
      case 'aac':
      case 'm4a':
        args.push('-c:a', 'aac');
        if (tgt === 'm4a') args.push('-movflags', '+faststart');
        break;
      case 'ogg':
        args.push('-c:a', 'libvorbis');
        break;
      case 'opus':
        args.push('-c:a', 'libopus');
        break;
      case 'flac':
        args.push('-c:a', 'flac');
        break;
      case 'wav':
        args.push('-c:a', 'pcm_s16le');
        break;
    }
    if (options.audioBitrate && /^\d+[kK]?$/.test(options.audioBitrate)) {
      args.push('-b:a', options.audioBitrate);
    }
  }

  // Audio channels
  if (options.audioChannels && ['mono', 'stereo', '5.1'].includes(options.audioChannels)) {
    args.push('-ac', options.audioChannels === 'mono' ? '1' : options.audioChannels === '5.1' ? '6' : '2');
  }

  // Audio sample rate
  if (typeof options.audioSampleRate === 'number' && Number.isFinite(options.audioSampleRate) && options.audioSampleRate >= 8000 && options.audioSampleRate <= 192000) {
    args.push('-ar', String(options.audioSampleRate));
  }

  // Audio volume
  if (typeof options.audioVolume === 'number' && Number.isFinite(options.audioVolume) && options.audioVolume >= 0 && options.audioVolume <= 200 && options.audioVolume !== 100) {
    const vol = options.audioVolume / 100;
    args.push('-filter:a', `volume=${vol}`);
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
      args.push('-vf', `scale=${resMap[options.videoResolution]}:force_original_aspect_ratio=decrease`);
    }
  }

  // Video frame rate
  if (typeof options.videoFps === 'number' && Number.isFinite(options.videoFps) && options.videoFps > 0 && options.videoFps <= 240) {
    args.push('-r', options.videoFps.toString());
  }

  // Video bitrate override
  if (typeof options.videoBitrate === 'number' && Number.isFinite(options.videoBitrate) && options.videoBitrate > 0) {
    args.push('-b:v', `${Math.floor(options.videoBitrate)}k`);
  }

  args.push(outputPath);
  return args;
}
