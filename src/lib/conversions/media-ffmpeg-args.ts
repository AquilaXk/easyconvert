import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ConversionOptions,
  InvalidMediaOptionError,
  AudioCodec,
  MediaLadderRung,
  MediaPackagingOptions,
  MediaPackagingFormat,
} from '../types';

export interface HardwareAccelerationCapabilities {
  nvenc: boolean;
  vaapi: boolean;
  qsv: boolean;
  videotoolbox: boolean;
  supportedEncoders: Set<string>;
  probedAt: number;
}

export const AUDIO_CODEC_MAP: Record<AudioCodec, string> = {
  aac: 'aac',
  mp3: 'libmp3lame',
  opus: 'libopus',
  flac: 'flac',
  vorbis: 'libvorbis',
  pcm_s16le: 'pcm_s16le',
};

/**
 * Escapes file paths for safe inclusion in FFmpeg filter graph strings (e.g. subtitles filter).
 */
export function escapeFfmpegFilterPath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "'\\\\''");
}

let cachedFfprobeBin: string | null = null;
function getInternalFfprobe(): string | null {
  if (cachedFfprobeBin !== null) return cachedFfprobeBin || null;
  const envPath = process.env.FFPROBE_PATH;
  if (envPath && fs.existsSync(envPath)) {
    cachedFfprobeBin = envPath;
    return envPath;
  }
  const fixedLocations = [
    '/usr/bin/ffprobe',
    '/usr/local/bin/ffprobe',
    '/opt/homebrew/bin/ffprobe',
    '/bin/ffprobe',
  ];
  for (const loc of fixedLocations) {
    if (fs.existsSync(loc)) {
      cachedFfprobeBin = loc;
      return loc;
    }
  }
  cachedFfprobeBin = '';
  return null;
}

/**
 * Probes the number of audio channels in the first audio stream of a file.
 */
export function probeAudioChannels(filePath: string, ffprobeBin?: string | null): number {
  const ffprobe = ffprobeBin || getInternalFfprobe();
  if (!ffprobe || !fs.existsSync(filePath)) {
    return 0;
  }
  try {
    const out = execFileSync(
      ffprobe,
      [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=channels',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }
    ).toString('utf-8').trim();
    const parsed = Number.parseInt(out, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
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
  ffmpegBin?: string | null,
  overrideTimestamp?: string
): string[] {
  const globalArgs: string[] = ['-y'];
  const inputArgs: string[] = [];
  const outputArgs: string[] = [];

  // Thumbnail branch: produce a single frame image
  const isThumbnail = Boolean(options.thumbnail) || (['jpg', 'jpeg', 'png'].includes(tgt) && Boolean(options.thumbnail));
  if (isThumbnail) {
    const timestamp = overrideTimestamp || options.thumbnail?.at?.[0] || '00:00:01.000';
    if (options.thumbnail?.accurate) {
      inputArgs.push('-i', inputPath);
      outputArgs.push('-ss', timestamp);
    } else {
      inputArgs.push('-ss', timestamp, '-i', inputPath);
    }

    const videoFilters: string[] = [];
    if (options.thumbnail?.width && options.thumbnail.width > 0) {
      videoFilters.push(`scale=${options.thumbnail.width}:-2`);
    }
    videoFilters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
    outputArgs.push('-vf', videoFilters.join(','));

    outputArgs.push('-frames:v', '1', '-an');
    const imgCodec = (tgt === 'png' || options.thumbnail?.format === 'png') ? 'png' : 'mjpeg';
    outputArgs.push('-c:v', imgCodec);

    return [...globalArgs, ...inputArgs, ...outputArgs, outputPath];
  }

  // Subtitle extraction branch: demux subtitle stream directly
  if (options.subtitles?.mode === 'extract') {
    if (options.trim?.start) {
      inputArgs.push('-ss', options.trim.start);
    }
    if (options.trim?.end) {
      inputArgs.push('-to', options.trim.end);
    }
    inputArgs.push('-i', inputPath);

    outputArgs.push('-vn', '-an');
    const sIdx = typeof options.subtitles.streamIndex === 'number' ? options.subtitles.streamIndex : 0;
    if (sIdx < 0) {
      throw new InvalidMediaOptionError('Subtitle stream index must be non-negative.');
    }
    outputArgs.push('-map', `0:s:${sIdx}`);

    const subFmt = options.subtitles.format || (tgt === 'vtt' ? 'vtt' : tgt === 'ass' ? 'ass' : 'srt');
    const subCodec = subFmt === 'vtt' ? 'webvtt' : subFmt === 'ass' ? 'ass' : 'srt';
    outputArgs.push('-c:s', subCodec);

    return [...globalArgs, ...inputArgs, ...outputArgs, outputPath];
  }

  // Standard video/audio transcoding branch
  if (options.trim?.start) {
    inputArgs.push('-ss', options.trim.start);
  }
  if (options.trim?.end) {
    inputArgs.push('-to', options.trim.end);
  }
  inputArgs.push('-i', inputPath);

  if (options.subtitles?.mode === 'soft') {
    if (!options.subtitles.input) {
      throw new InvalidMediaOptionError("Subtitle 'soft' mode requires an input subtitle file path.");
    }
    inputArgs.push('-i', options.subtitles.input);
  }

  const isVideo = ['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(tgt);
  const isAudioOnly = ['mp3', 'wav', 'aac', 'ogg', 'opus', 'flac', 'm4a', 'wma'].includes(tgt);

  if (options.subtitles?.mode === 'burn' && !isVideo) {
    throw new InvalidMediaOptionError("Subtitle 'burn' mode is only supported for video targets.");
  }
  if (options.subtitles?.mode === 'soft' && !['mp4', 'mov', 'mkv', 'webm'].includes(tgt)) {
    throw new InvalidMediaOptionError(`Container '${tgt}' does not support soft subtitle embedding.`);
  }

  // Audio codec validation and container compatibility gates
  if (options.audio?.codec) {
    const ac = options.audio.codec;
    if (!AUDIO_CODEC_MAP[ac]) {
      throw new InvalidMediaOptionError(`Unsupported audio codec '${ac}'.`);
    }
    if (tgt === 'webm' && ac !== 'opus' && ac !== 'vorbis') {
      throw new InvalidMediaOptionError(
        `WebM container only supports 'opus' or 'vorbis' audio codecs, but '${ac}' was requested.`
      );
    }
    if (tgt === 'ogg' && ac !== 'opus' && ac !== 'vorbis' && ac !== 'flac') {
      throw new InvalidMediaOptionError(
        `Ogg container only supports 'opus', 'vorbis', or 'flac' audio codecs, but '${ac}' was requested.`
      );
    }
    if ((tgt === 'mp4' || tgt === 'mov') && ac === 'vorbis') {
      throw new InvalidMediaOptionError("MP4/MOV container does not support 'vorbis' audio codec.");
    }
  }

  // Stream mapping
  if (options.subtitles?.mode === 'soft') {
    outputArgs.push('-map', '0:v');
    if (options.audio?.track === 'all') {
      outputArgs.push('-map', '0:a');
    } else if (typeof options.audio?.track === 'number') {
      if (options.audio.track < 0) {
        throw new InvalidMediaOptionError('Audio track index must be non-negative.');
      }
      outputArgs.push('-map', `0:a:${options.audio.track}`);
    } else {
      outputArgs.push('-map', '0:a?');
    }
    outputArgs.push('-map', '1:0');
  } else if (options.audio?.track !== undefined) {
    if (isVideo) {
      outputArgs.push('-map', '0:v:0');
    }
    if (options.audio.track === 'all') {
      outputArgs.push('-map', '0:a');
    } else if (typeof options.audio.track === 'number') {
      if (options.audio.track < 0) {
        throw new InvalidMediaOptionError('Audio track index must be non-negative.');
      }
      outputArgs.push('-map', `0:a:${options.audio.track}`);
    }
  }

  if (options.subtitles?.mode === 'soft') {
    if (tgt === 'mp4' || tgt === 'mov') {
      outputArgs.push('-c:s', 'mov_text');
    } else if (tgt === 'webm') {
      outputArgs.push('-c:s', 'webvtt');
    } else if (tgt === 'mkv') {
      outputArgs.push('-c:s', options.subtitles.format === 'ass' ? 'ass' : 'srt');
    } else {
      outputArgs.push('-c:s', 'copy');
    }
  }

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
    // Sequence: yadif -> crop -> transpose -> scale -> fps -> subtitles (burn) -> even parity correction -> format
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

    // Stage 6: subtitles burn (prior to even dimension normalization)
    if (options.subtitles?.mode === 'burn') {
      if (!options.subtitles.input) {
        throw new InvalidMediaOptionError("Subtitle 'burn' mode requires an input subtitle file path.");
      }
      videoFilters.push(`subtitles='${escapeFfmpegFilterPath(options.subtitles.input)}'`);
    }

    // Stage 7: Even dimension normalization (ALWAYS LAST filter before format)
    videoFilters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');

    // Stage 8: Format upload (for VAAPI)
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
    } else if (tgt === 'avi') {
      outputArgs.push('-c:v', 'mpeg4', '-vtag', 'XVID');
    }
  }

  // Unified Audio Encoding & Filter Configuration
  let resolvedAudioCodec: string;
  if (options.audio?.codec) {
    resolvedAudioCodec = AUDIO_CODEC_MAP[options.audio.codec];
  } else if (isVideo) {
    if (tgt === 'webm') {
      resolvedAudioCodec = 'libopus';
    } else if (tgt === 'avi') {
      resolvedAudioCodec = 'libmp3lame';
    } else {
      resolvedAudioCodec = 'aac';
    }
  } else if (isAudioOnly) {
    switch (tgt) {
      case 'mp3':
        resolvedAudioCodec = 'libmp3lame';
        break;
      case 'aac':
      case 'm4a':
        resolvedAudioCodec = 'aac';
        break;
      case 'ogg':
        resolvedAudioCodec = 'libvorbis';
        break;
      case 'opus':
        resolvedAudioCodec = 'libopus';
        break;
      case 'flac':
        resolvedAudioCodec = 'flac';
        break;
      case 'wav':
        resolvedAudioCodec = 'pcm_s16le';
        break;
      default:
        resolvedAudioCodec = 'aac';
    }
  } else {
    resolvedAudioCodec = 'aac';
  }

  outputArgs.push('-c:a', resolvedAudioCodec);

  // Audio bitrate
  if (typeof options.audio?.bitrateK === 'number') {
    if (!Number.isFinite(options.audio.bitrateK) || options.audio.bitrateK <= 0) {
      throw new InvalidMediaOptionError(`Invalid audio bitrate: ${options.audio.bitrateK}k`);
    }
    outputArgs.push('-b:a', `${Math.floor(options.audio.bitrateK)}k`);
  } else if (options.audioBitrate && /^\d+[kK]?$/.test(options.audioBitrate)) {
    outputArgs.push('-b:a', options.audioBitrate.toLowerCase().endsWith('k') ? options.audioBitrate : `${options.audioBitrate}k`);
  } else if (resolvedAudioCodec !== 'flac' && resolvedAudioCodec !== 'pcm_s16le') {
    if (tgt === 'webm' || resolvedAudioCodec === 'libopus') {
      outputArgs.push('-b:a', '128k');
    } else {
      outputArgs.push('-b:a', '192k');
    }
  }

  // Audio filters and ITU-R BS.775 downmix
  const audioFilters: string[] = [];
  if (options.audio?.downmix === 'itu-r-bs775') {
    const is71 = options.audio.channels === 8 || options.audioChannels === '7.1' || probeAudioChannels(inputPath, ffmpegBin) === 8;
    if (is71) {
      audioFilters.push('pan=stereo|FL=0.3204*FL+0.2265*FC+0.2265*BL+0.2265*SL|FR=0.3204*FR+0.2265*FC+0.2265*BR+0.2265*SR');
    } else {
      audioFilters.push('pan=stereo|FL=0.4142*FL+0.2929*FC+0.2929*BL|FR=0.4142*FR+0.2929*FC+0.2929*BR');
    }
    outputArgs.push('-ac', '2');
  } else if (options.audio?.channels) {
    if (![1, 2, 6, 8].includes(options.audio.channels)) {
      throw new InvalidMediaOptionError(`Invalid audio channels: ${options.audio.channels}. Allowed: 1, 2, 6, 8.`);
    }
    outputArgs.push('-ac', String(options.audio.channels));
  } else if (options.audioChannels && ['mono', 'stereo', '5.1', '7.1'].includes(options.audioChannels)) {
    const chMap: Record<string, string> = { mono: '1', stereo: '2', '5.1': '6', '7.1': '8' };
    outputArgs.push('-ac', chMap[options.audioChannels]);
  }

  // Audio sample rate
  if (typeof options.audio?.sampleRate === 'number') {
    if (!Number.isFinite(options.audio.sampleRate) || options.audio.sampleRate < 8000 || options.audio.sampleRate > 192000) {
      throw new InvalidMediaOptionError(`Invalid audio sample rate: ${options.audio.sampleRate}. Allowed range: 8000 to 192000 Hz.`);
    }
    outputArgs.push('-ar', String(options.audio.sampleRate));
  } else if (typeof options.audioSampleRate === 'number' && Number.isFinite(options.audioSampleRate) && options.audioSampleRate >= 8000 && options.audioSampleRate <= 192000) {
    outputArgs.push('-ar', String(options.audioSampleRate));
  }

  // Audio volume
  if (typeof options.audio?.volume === 'number') {
    if (!Number.isFinite(options.audio.volume) || options.audio.volume < 0 || options.audio.volume > 200) {
      throw new InvalidMediaOptionError(`Invalid audio volume: ${options.audio.volume}. Allowed range: 0 to 200%.`);
    }
    if (options.audio.volume !== 100) {
      audioFilters.push(`volume=${options.audio.volume / 100}`);
    }
  } else if (typeof options.audioVolume === 'number' && Number.isFinite(options.audioVolume) && options.audioVolume >= 0 && options.audioVolume <= 200 && options.audioVolume !== 100) {
    audioFilters.push(`volume=${options.audioVolume / 100}`);
  }

  if (audioFilters.length > 0) {
    outputArgs.push('-filter:a', audioFilters.join(','));
  }

  if (tgt === 'm4a') {
    outputArgs.push('-movflags', '+faststart');
  }

  return [...globalArgs, ...inputArgs, ...outputArgs, outputPath];
}

export const DEFAULT_PACKAGING_LADDER: readonly MediaLadderRung[] = [
  { height: 1080, bitrateK: 4500, audioBitrateK: 192 },
  { height: 720, bitrateK: 2500, audioBitrateK: 128 },
  { height: 480, bitrateK: 1000, audioBitrateK: 96 },
] as const;

export const PACKAGING_VIDEO_ENCODERS: Record<string, string> = {
  h264: 'libx264',
  hevc: 'libx265',
  vp9: 'libvpx-vp9',
  av1: 'libsvtav1',
};

export const PACKAGING_AUDIO_ENCODERS: Record<string, string> = {
  aac: 'aac',
  opus: 'libopus',
};

/**
 * Builds FFmpeg command-line arguments for multi-bitrate ABR packaging (HLS and MPEG-DASH).
 */
export function buildHlsDashArguments(
  inputPath: string,
  outputDir: string,
  packaging: MediaPackagingOptions,
  ffmpegBin?: string | null
): string[] {
  if (!packaging || !packaging.format) {
    throw new InvalidMediaOptionError('Packaging format is required ("hls" or "dash").');
  }

  const format = packaging.format.toLowerCase();
  if (format !== 'hls' && format !== 'dash') {
    throw new InvalidMediaOptionError(
      `Unsupported packaging format "${packaging.format}". Allowed: "hls", "dash".`
    );
  }

  // segmentSeconds validation (2..10, integer)
  let segmentSeconds = 4;
  if (packaging.segmentSeconds !== undefined) {
    if (
      typeof packaging.segmentSeconds !== 'number' ||
      !Number.isInteger(packaging.segmentSeconds) ||
      packaging.segmentSeconds < 2 ||
      packaging.segmentSeconds > 10
    ) {
      throw new InvalidMediaOptionError(
        `Invalid segmentSeconds: ${packaging.segmentSeconds}. Allowed range: 2 to 10 seconds integer.`
      );
    }
    segmentSeconds = packaging.segmentSeconds;
  }

  // ladder validation
  let ladder: MediaLadderRung[];
  if (packaging.ladder !== undefined) {
    if (!Array.isArray(packaging.ladder) || packaging.ladder.length === 0) {
      throw new InvalidMediaOptionError('Packaging ladder must be a non-empty array of rungs.');
    }
    for (const rung of packaging.ladder) {
      if (typeof rung.height !== 'number' || !Number.isInteger(rung.height) || rung.height < 144 || rung.height > 4320) {
        throw new InvalidMediaOptionError(
          `Invalid ladder rung height: ${rung.height}. Must be an integer between 144 and 4320.`
        );
      }
      if (typeof rung.bitrateK !== 'number' || !Number.isInteger(rung.bitrateK) || rung.bitrateK < 50 || rung.bitrateK > 50000) {
        throw new InvalidMediaOptionError(
          `Invalid ladder rung bitrateK: ${rung.bitrateK}. Must be an integer between 50 and 50000.`
        );
      }
      if (rung.fps !== undefined) {
        if (typeof rung.fps !== 'number' || !Number.isFinite(rung.fps) || rung.fps <= 0 || rung.fps > 240) {
          throw new InvalidMediaOptionError(
            `Invalid ladder rung fps: ${rung.fps}. Must be a number between 1 and 240.`
          );
        }
      }
      if (rung.audioBitrateK !== undefined) {
        if (
          typeof rung.audioBitrateK !== 'number' ||
          !Number.isInteger(rung.audioBitrateK) ||
          rung.audioBitrateK < 16 ||
          rung.audioBitrateK > 1024
        ) {
          throw new InvalidMediaOptionError(
            `Invalid ladder rung audioBitrateK: ${rung.audioBitrateK}. Must be an integer between 16 and 1024.`
          );
        }
      }
    }
    ladder = packaging.ladder;
  } else {
    ladder = [...DEFAULT_PACKAGING_LADDER];
  }

  // Video codec
  const videoCodecKey = (packaging.videoCodec || 'h264').toLowerCase();
  const vEncoder = PACKAGING_VIDEO_ENCODERS[videoCodecKey];
  if (!vEncoder) {
    throw new InvalidMediaOptionError(
      `Unsupported video codec "${packaging.videoCodec}". Allowed: h264, hevc, vp9, av1.`
    );
  }

  // Audio codec
  const audioCodecKey = (packaging.audioCodec || 'aac').toLowerCase();
  const aEncoder = PACKAGING_AUDIO_ENCODERS[audioCodecKey];
  if (!aEncoder) {
    throw new InvalidMediaOptionError(
      `Unsupported audio codec "${packaging.audioCodec}". Allowed: aac, opus.`
    );
  }

  const hasAudio = !fs.existsSync(inputPath) || probeAudioChannels(inputPath, ffmpegBin) > 0;

  const globalArgs: string[] = ['-y', '-loglevel', 'error'];
  const inputArgs: string[] = ['-i', inputPath];

  // Construct filter_complex
  const filterParts: string[] = [];

  // Video split & scale
  const vSplitOuts = ladder.map((_, i) => `[v_in${i}]`).join('');
  filterParts.push(`[0:v]split=${ladder.length}${vSplitOuts}`);
  for (let i = 0; i < ladder.length; i++) {
    const rung = ladder[i];
    const fpsFilter = rung.fps ? `,fps=${rung.fps}` : '';
    filterParts.push(`[v_in${i}]scale=w=-2:h=${rung.height}${fpsFilter}[v_out${i}]`);
  }

  // Audio split
  if (hasAudio) {
    const aSplitOuts = ladder.map((_, i) => `[a_out${i}]`).join('');
    filterParts.push(`[0:a]asplit=${ladder.length}${aSplitOuts}`);
  }

  const complexFilter = filterParts.join('; ');
  const streamArgs: string[] = ['-filter_complex', complexFilter];

  // Map each rung
  for (let i = 0; i < ladder.length; i++) {
    const rung = ladder[i];
    streamArgs.push(
      '-map', `[v_out${i}]`,
      `-c:v:${i}`, vEncoder,
      `-b:v:${i}`, `${rung.bitrateK}k`
    );

    // GOP / Keyframe alignment for smooth ABR switching
    const fps = rung.fps || 30;
    const gopSize = Math.round(fps * segmentSeconds);
    streamArgs.push(
      `-g:v:${i}`, String(gopSize),
      `-keyint_min:v:${i}`, String(gopSize),
      `-sc_threshold:v:${i}`, '0'
    );

    if (hasAudio) {
      const audioBitrate = rung.audioBitrateK || (i === 0 ? 192 : i === 1 ? 128 : 96);
      streamArgs.push(
        '-map', `[a_out${i}]`,
        `-c:a:${i}`, aEncoder,
        `-b:a:${i}`, `${audioBitrate}k`
      );
    }
  }

  if (format === 'hls') {
    const masterPlaylist = packaging.masterPlaylistName || 'master.m3u8';
    const varStreamMap = ladder
      .map((rung, i) => {
        const streamName = `${rung.height}p`;
        return hasAudio ? `v:${i},a:${i},name:${streamName}` : `v:${i},name:${streamName}`;
      })
      .join(' ');

    const hlsArgs: string[] = [
      '-f', 'hls',
      '-hls_time', String(segmentSeconds),
      '-hls_playlist_type', 'vod',
      '-hls_flags', 'independent_segments',
      '-master_pl_name', masterPlaylist,
      '-hls_segment_filename', path.join(outputDir, 'stream_%v_%03d.ts'),
      '-var_stream_map', varStreamMap,
      path.join(outputDir, 'stream_%v.m3u8'),
    ];

    return [...globalArgs, ...inputArgs, ...streamArgs, ...hlsArgs];
  } else {
    // DASH
    const manifestName = packaging.masterPlaylistName || 'manifest.mpd';
    const adaptationSets = hasAudio
      ? 'id=0,streams=v id=1,streams=a'
      : 'id=0,streams=v';

    const dashArgs: string[] = [
      '-f', 'dash',
      '-seg_duration', String(segmentSeconds),
      '-use_template', '1',
      '-use_timeline', '1',
      '-init_seg_name', 'init_$RepresentationID$.m4s',
      '-media_seg_name', 'chunk_$RepresentationID$_$Number%05d$.m4s',
      '-adaptation_sets', adaptationSets,
      path.join(outputDir, manifestName),
    ];

    return [...globalArgs, ...inputArgs, ...streamArgs, ...dashArgs];
  }
}


