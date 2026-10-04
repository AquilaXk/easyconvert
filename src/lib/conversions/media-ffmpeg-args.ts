import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ConversionOptions, InvalidMediaOptionError } from '../types';

export interface HardwareAccelerationCapabilities {
  nvenc: boolean;
  vaapi: boolean;
  qsv: boolean;
  videotoolbox: boolean;
  supportedEncoders: Set<string>;
  probedAt: number;
}

export const H264_ALLOWED_PROFILES = new Set(['baseline', 'main', 'high', 'high10']);
export const H264_ALLOWED_LEVELS = new Set([
  '3.0', '3.1', '3.2', '4.0', '4.1', '4.2', '5.0', '5.1', '5.2',
  '30', '31', '32', '40', '41', '42', '50', '51', '52',
]);
export const HEVC_ALLOWED_PROFILES = new Set(['main', 'main10']);
export const AV1_ALLOWED_PROFILES = new Set(['main', '0']);

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
 * strict filter graph ordering, rate control, and profile/level validation.
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
  const inputArgs: string[] = [];
  const outputArgs: string[] = [];

  // Trim parameters (start seek and stop timestamp before input for speed and precision)
  if (options.trim?.start) {
    inputArgs.push('-ss', options.trim.start);
  }
  if (options.trim?.end) {
    inputArgs.push('-to', options.trim.end);
  }
  inputArgs.push('-i', inputPath);

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

    const videoOpts = options.video;
    const codec = videoOpts?.codec || options.videoCodec || (tgt === 'webm' ? 'vp9' : 'h264');

    // 1. Container Compatibility Gate
    if (tgt === 'webm' && codec !== 'vp9' && codec !== 'av1') {
      throw new InvalidMediaOptionError(
        `WebM container only supports 'vp9' or 'av1' video codecs, but '${codec}' was requested.`
      );
    }
    if (codec === 'prores' && tgt !== 'mov') {
      throw new InvalidMediaOptionError(
        `ProRes video codec is only supported in 'mov' container, but '${tgt}' was requested.`
      );
    }

    // 2. Profile and Level Validation Gate
    if (codec === 'h264') {
      if (videoOpts?.profile && !H264_ALLOWED_PROFILES.has(videoOpts.profile.toLowerCase())) {
        throw new InvalidMediaOptionError(
          `Invalid H.264 profile '${videoOpts.profile}'. Allowed profiles: ${Array.from(H264_ALLOWED_PROFILES).join(', ')}.`
        );
      }
      if (videoOpts?.level && !H264_ALLOWED_LEVELS.has(videoOpts.level.toLowerCase())) {
        throw new InvalidMediaOptionError(
          `Invalid H.264 level '${videoOpts.level}'. Allowed levels: 3.0 to 5.2.`
        );
      }
    } else if (codec === 'hevc') {
      if (videoOpts?.profile && !HEVC_ALLOWED_PROFILES.has(videoOpts.profile.toLowerCase())) {
        throw new InvalidMediaOptionError(
          `Invalid HEVC profile '${videoOpts.profile}'. Allowed profiles: ${Array.from(HEVC_ALLOWED_PROFILES).join(', ')}.`
        );
      }
    } else if (codec === 'av1') {
      if (videoOpts?.profile && !AV1_ALLOWED_PROFILES.has(videoOpts.profile.toLowerCase())) {
        throw new InvalidMediaOptionError(
          `Invalid AV1 profile '${videoOpts.profile}'. Allowed profiles: main.`
        );
      }
    }

    // 3. Rate Control Validation Gate
    const rateControl = videoOpts?.rateControl;
    if (rateControl?.mode === 'crf') {
      const crf = rateControl.crf;
      if (codec === 'h264' || codec === 'hevc') {
        if (typeof crf !== 'number' || !Number.isFinite(crf) || crf < 0 || crf > 51) {
          throw new InvalidMediaOptionError(
            `CRF for ${codec.toUpperCase()} must be between 0 and 51, received ${crf}.`
          );
        }
      } else if (codec === 'vp9' || codec === 'av1') {
        if (typeof crf !== 'number' || !Number.isFinite(crf) || crf < 0 || crf > 63) {
          throw new InvalidMediaOptionError(
            `CRF for ${codec.toUpperCase()} must be between 0 and 63, received ${crf}.`
          );
        }
      } else if (codec === 'prores') {
        throw new InvalidMediaOptionError('CRF rate control is not supported for ProRes codec.');
      }
    }

    // 4. Determine Hardware Acceleration Usage
    let isVaapi = false;
    let isNvenc = false;
    let isVideotoolbox = false;
    let isQsv = false;

    if (!disableHw && (tgt === 'mp4' || tgt === 'mov' || tgt === 'mkv')) {
      if (codec === 'h264') {
        if (hw.nvenc && hw.supportedEncoders.has('h264_nvenc')) isNvenc = true;
        else if (hw.vaapi && driDev && hw.supportedEncoders.has('h264_vaapi')) isVaapi = true;
        else if (hw.videotoolbox && hw.supportedEncoders.has('h264_videotoolbox')) isVideotoolbox = true;
        else if (hw.qsv && hw.supportedEncoders.has('h264_qsv')) isQsv = true;
      } else if (codec === 'hevc') {
        if (hw.nvenc && hw.supportedEncoders.has('hevc_nvenc')) isNvenc = true;
        else if (hw.vaapi && driDev && hw.supportedEncoders.has('hevc_vaapi')) isVaapi = true;
        else if (hw.videotoolbox && hw.supportedEncoders.has('hevc_videotoolbox')) isVideotoolbox = true;
      }
    }

    // 2-pass on hardware acceleration rejection
    if (rateControl?.mode === 'vbr' && rateControl.twoPass && (isVaapi || isNvenc || isVideotoolbox || isQsv)) {
      throw new InvalidMediaOptionError('Hardware accelerated video encoders do not support 2-pass encoding.');
    }

    // 5. Strict Filter Graph Construction
    // Sequence: yadif -> crop -> transpose -> scale -> fps -> even parity correction -> format
    const videoFilters: string[] = [];

    // Stage 1: yadif (deinterlace)
    if (videoOpts?.deinterlace) {
      videoFilters.push('yadif');
    }

    // Stage 2: crop
    if (videoOpts?.crop) {
      const { w, h, x, y } = videoOpts.crop;
      videoFilters.push(`crop=${w}:${h}:${x}:${y}`);
    }

    // Stage 3: transpose (rotation)
    if (typeof videoOpts?.rotate === 'number') {
      const rot = videoOpts.rotate;
      if (rot === 90) {
        videoFilters.push('transpose=1');
      } else if (rot === 180) {
        videoFilters.push('transpose=2,transpose=2');
      } else if (rot === 270) {
        videoFilters.push('transpose=2');
      } else if (rot !== 0) {
        throw new InvalidMediaOptionError(`Invalid rotate angle ${rot}. Allowed values: 0, 90, 180, 270.`);
      }
    }

    // Stage 4: scale
    if (videoOpts?.scale) {
      const { width, height, fit } = videoOpts.scale;
      const w = width && width > 0 ? width : -1;
      const h = height && height > 0 ? height : -1;
      if (fit === 'cover' && width && height) {
        videoFilters.push(`scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${width}:${height}`);
      } else if (fit === 'stretch') {
        videoFilters.push(`scale=${w}:${h}`);
      } else {
        videoFilters.push(`scale=${w}:${h}:force_original_aspect_ratio=decrease`);
      }
    } else if (options.videoResolution && options.videoResolution !== 'original') {
      const resMap: Record<string, string> = {
        '4k': '3840:2160',
        '1080p': '1920:1080',
        '720p': '1280:720',
        '480p': '854:480',
        '360p': '640:360',
      };
      if (resMap[options.videoResolution]) {
        videoFilters.push(`scale=${resMap[options.videoResolution]}:force_original_aspect_ratio=decrease`);
      }
    }

    // Stage 5: fps
    if (typeof videoOpts?.fps === 'number' && Number.isFinite(videoOpts.fps) && videoOpts.fps > 0 && videoOpts.fps <= 240) {
      videoFilters.push(`fps=${videoOpts.fps}`);
    }

    // Stage 6: Even dimension normalization (ALWAYS LAST filter before format)
    videoFilters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');

    // Stage 7: Format upload (for VAAPI)
    if (isVaapi) {
      videoFilters.push('format=nv12,hwupload');
    }

    if (videoFilters.length > 0) {
      outputArgs.push('-vf', videoFilters.join(','));
    }

    // Software pixel format (exclude VAAPI which uses hwupload, and ProRes which has custom 10-bit format)
    if (!isVaapi && codec !== 'prores') {
      outputArgs.push('-pix_fmt', 'yuv420p');
    }

    // 6. Video Encoder Selection and Arguments
    if (tgt === 'mp4' || tgt === 'mov' || tgt === 'mkv') {
      if (codec === 'h264' || codec === 'hevc') {
        const isH264 = codec === 'h264';
        const defaultCrf = isH264 ? '23' : '26';
        const defaultVaapiQp = isH264 ? '24' : '26';
        const swLib = isH264 ? 'libx264' : 'libx265';
        const crfVal = rateControl?.mode === 'crf' ? String(rateControl.crf) : defaultCrf;

        if (isNvenc) {
          outputArgs.push('-c:v', `${codec}_nvenc`, '-preset', videoOpts?.preset || 'p4');
          if (rateControl?.mode === 'crf' || !rateControl) {
            outputArgs.push('-cq', crfVal);
          }
        } else if (isVaapi && driDev) {
          globalArgs.push('-vaapi_device', driDev);
          outputArgs.push('-filter_hw_device', driDev, '-c:v', `${codec}_vaapi`);
          if (rateControl?.mode === 'crf') {
            outputArgs.push('-qp', String(rateControl.crf));
          } else if (!rateControl) {
            outputArgs.push('-qp', defaultVaapiQp);
          }
        } else if (isVideotoolbox) {
          outputArgs.push('-c:v', `${codec}_videotoolbox`);
          if (rateControl?.mode === 'crf') {
            outputArgs.push('-q:v', String(Math.max(1, Math.min(100, Math.round(100 - rateControl.crf * 1.5)))));
          } else if (!rateControl) {
            outputArgs.push('-q:v', '65');
          }
        } else if (isH264 && isQsv) {
          outputArgs.push('-c:v', 'h264_qsv');
          if (rateControl?.mode === 'crf' || !rateControl) {
            outputArgs.push('-global_quality', crfVal);
          }
        } else {
          outputArgs.push('-c:v', swLib, '-preset', videoOpts?.preset || 'fast');
          if (rateControl?.mode === 'crf' || !rateControl) {
            outputArgs.push('-crf', crfVal);
          }
          if (videoOpts?.profile) {
            outputArgs.push('-profile:v', videoOpts.profile.toLowerCase());
          }
          if (isH264 && videoOpts?.level) {
            outputArgs.push('-level', videoOpts.level);
          }
        }
      } else if (codec === 'vp9') {
        outputArgs.push('-c:v', 'libvpx-vp9');
        if (rateControl?.mode === 'crf') {
          outputArgs.push('-crf', String(rateControl.crf), '-b:v', '0');
        } else if (!rateControl) {
          outputArgs.push('-crf', '30', '-b:v', '0');
        }
      } else if (codec === 'av1') {
        outputArgs.push('-c:v', 'libaom-av1');
        if (rateControl?.mode === 'crf') {
          outputArgs.push('-crf', String(rateControl.crf), '-b:v', '0');
        } else if (!rateControl) {
          outputArgs.push('-crf', '32', '-b:v', '0');
        }
        if (videoOpts?.profile) {
          outputArgs.push('-profile:v', '0');
        }
      } else if (codec === 'prores') {
        outputArgs.push('-c:v', 'prores_ks');
        const proresProfileMap: Record<string, string> = {
          proxy: '0',
          '0': '0',
          lt: '1',
          '1': '1',
          standard: '2',
          '2': '2',
          hq: '3',
          '3': '3',
          '4444': '4',
          '4': '4',
        };
        const p = videoOpts?.profile?.toLowerCase();
        const prof = p && proresProfileMap[p] ? proresProfileMap[p] : '3';
        outputArgs.push(
          '-profile:v', prof,
          '-pix_fmt', prof === '4' ? 'yuva444p10le' : 'yuv422p10le'
        );
      }

      // Bitrate rate control (VBR / CBR / legacy)
      if (rateControl?.mode === 'vbr') {
        outputArgs.push('-b:v', `${rateControl.bitrateK}k`);
        if (rateControl.maxrateK) outputArgs.push('-maxrate', `${rateControl.maxrateK}k`);
        if (rateControl.bufsizeK) outputArgs.push('-bufsize', `${rateControl.bufsizeK}k`);
      } else if (rateControl?.mode === 'cbr') {
        outputArgs.push(
          '-b:v', `${rateControl.bitrateK}k`,
          '-minrate', `${rateControl.bitrateK}k`,
          '-maxrate', `${rateControl.bitrateK}k`,
          '-bufsize', `${rateControl.bitrateK}k`
        );
      } else if (typeof options.videoBitrate === 'number' && Number.isFinite(options.videoBitrate) && options.videoBitrate > 0) {
        outputArgs.push('-b:v', `${Math.floor(options.videoBitrate)}k`);
      }

      if (typeof options.videoFps === 'number' && Number.isFinite(options.videoFps) && options.videoFps > 0 && options.videoFps <= 240) {
        outputArgs.push('-r', options.videoFps.toString());
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
      if (codec === 'av1') {
        outputArgs.push('-c:v', 'libaom-av1');
        if (rateControl?.mode === 'crf') {
          outputArgs.push('-crf', String(rateControl.crf), '-b:v', '0');
        } else {
          outputArgs.push('-crf', '32', '-b:v', '0');
        }
      } else {
        outputArgs.push('-c:v', 'libvpx-vp9');
        if (rateControl?.mode === 'crf') {
          outputArgs.push('-crf', String(rateControl.crf), '-b:v', '0');
        } else {
          outputArgs.push('-crf', '30', '-b:v', '0');
        }
      }
      if (rateControl?.mode === 'vbr') {
        outputArgs.push('-b:v', `${rateControl.bitrateK}k`);
      } else if (rateControl?.mode === 'cbr') {
        outputArgs.push('-b:v', `${rateControl.bitrateK}k`, '-minrate', `${rateControl.bitrateK}k`, '-maxrate', `${rateControl.bitrateK}k`);
      } else if (typeof options.videoBitrate === 'number' && Number.isFinite(options.videoBitrate) && options.videoBitrate > 0) {
        outputArgs.push('-b:v', `${Math.floor(options.videoBitrate)}k`);
      }

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

  return [...globalArgs, ...inputArgs, ...outputArgs, outputPath];
}

