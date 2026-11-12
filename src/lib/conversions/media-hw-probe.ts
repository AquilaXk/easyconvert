import fs from 'node:fs';
import { lavfiInputArgs, runFfmpegSync } from './media-process';

export interface HardwareAccelerationCapabilities {
  nvenc: boolean;
  vaapi: boolean;
  qsv: boolean;
  videotoolbox: boolean;
  supportedEncoders: ReadonlySet<string>;
  probedAt: number;
}

/**
 * Probe results per ffmpeg binary (and DRM directory). The probe runs synchronously, so a long
 * lifetime keeps it off the request path; the worker warms it at startup.
 */
const hwCapabilityCache = new Map<string, HardwareAccelerationCapabilities>();
/**
 * The encoders a binary lists, per binary. A conversion that only needs to know whether an encoder exists (every
 * audio target, the AV1 check) reads this and never opens a hardware session, which costs a process per device.
 */
const encoderListCache = new Map<string, { encoders: ReadonlySet<string>; probedAt: number }>();
const PROBE_CACHE_TTL_MS = 10 * 60 * 1000;
const ENCODER_LIST_TIMEOUT_MS = 3000;
const ENCODER_LIST_MAX_BYTES = 1024 * 1024;
/** Directory that holds the DRM nodes Intel Quick Sync needs. */
const DRM_DEVICE_DIR = '/dev/dri';
const DRM_RENDER_NODE = /^renderD\d+$/;
/** Opening a hardware session is quick on a working device; a hung driver must not stall conversions. */
const HW_SESSION_PROBE_TIMEOUT_MS = 5000;
const HW_SESSION_PROBE_MAX_BYTES = 64 * 1024;
const HW_PROBE_FRAME_SIZE = '256x256';
const QSV_ENCODERS = ['h264_qsv', 'hevc_qsv'];
const NVENC_ENCODERS = ['h264_nvenc', 'hevc_nvenc'];
const VAAPI_ENCODERS = ['h264_vaapi', 'hevc_vaapi'];
const VAAPI_DEVICES = ['/dev/dri/renderD128', '/dev/dri/card0'];
const VAAPI_UPLOAD_FILTER = 'format=nv12,hwupload';
/**
 * One `ffmpeg -encoders` row: a type letter (V, A, S) and five capability flags (F, S, X, B, D or
 * a dot), then the encoder name. Most encoders carry the D (direct rendering) flag.
 */
const ENCODER_LISTING_LINE = /^\s*[VAS][.FSXBD]{5}\s+([a-zA-Z0-9_-]+)/;
const HARDWARE_ENCODER_NAME = /_(nvenc|vaapi|qsv|videotoolbox)$/;

/** Test seam for the host facts the probe reads. */
export interface HardwareProbeEnvironment {
  /** Directory scanned for DRM render nodes; defaults to /dev/dri. */
  drmDir?: string;
}

function hasDrmRenderNode(drmDir: string): boolean {
  try {
    return fs.readdirSync(drmDir).some((entry) => DRM_RENDER_NODE.test(entry));
  } catch {
    return false;
  }
}

/**
 * Encodes one black frame with a hardware encoder to a null sink. Listing an encoder only proves
 * it was compiled in; a session can still fail (no device, missing driver or libcuda), so this
 * decides whether the encoder may be selected.
 */
function canOpenEncoderSession(
  ffmpegPath: string,
  encoder: string,
  deviceArgs: readonly string[] = [],
  filter?: string
): boolean {
  const run = runFfmpegSync(
    ffmpegPath,
    [
      '-hide_banner', '-v', 'error', ...deviceArgs,
      ...lavfiInputArgs(`color=c=black:s=${HW_PROBE_FRAME_SIZE}:r=1:d=1`),
      ...(filter ? ['-vf', filter] : []),
      '-frames:v', '1', '-c:v', encoder, '-f', 'null', '-',
    ],
    { timeoutMs: HW_SESSION_PROBE_TIMEOUT_MS, maxBuffer: HW_SESSION_PROBE_MAX_BYTES }
  );
  return run.ok;
}

/** True when the ffmpeg arguments select a hardware video encoder (nvenc, vaapi, qsv, videotoolbox). */
export function usesHardwareVideoEncoder(args: readonly string[]): boolean {
  const idx = args.indexOf('-c:v');
  return idx >= 0 && idx + 1 < args.length && HARDWARE_ENCODER_NAME.test(args[idx + 1]);
}

export function resetHardwareAccelerationCache(): void {
  hwCapabilityCache.clear();
  encoderListCache.clear();
}

/** Names of the encoders `ffmpeg -encoders` lists, cached per binary; empty when the binary cannot be run. */
export function probeSupportedEncoders(ffmpegPath: string | null | undefined): ReadonlySet<string> {
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    // Not cached: a binary installed later must be seen at once, and this check costs one stat.
    return new Set<string>();
  }
  const now = Date.now();
  const cached = encoderListCache.get(ffmpegPath);
  if (cached && now - cached.probedAt < PROBE_CACHE_TTL_MS) {
    return cached.encoders;
  }
  const encoders = new Set<string>();
  const listing = runFfmpegSync(ffmpegPath, ['-hide_banner', '-encoders'], { timeoutMs: ENCODER_LIST_TIMEOUT_MS, maxBuffer: ENCODER_LIST_MAX_BYTES });
  // An unrunnable binary lists nothing; the empty answer is cached with the others for the probe's lifetime.
  for (const line of listing.ok ? listing.stdout.split('\n') : []) {
    const match = line.match(ENCODER_LISTING_LINE);
    if (match) {
      encoders.add(match[1]);
    }
  }
  encoderListCache.set(ffmpegPath, { encoders, probedAt: now });
  return encoders;
}

/**
 * Dynamically probes FFmpeg binary for hardware-accelerated video encoders.
 * Caches results in-memory with a 10-minute TTL to avoid redundant CLI executions.
 */
export function probeHardwareAcceleration(
  ffmpegPath?: string | null,
  env: HardwareProbeEnvironment = {}
): HardwareAccelerationCapabilities {
  const now = Date.now();
  const cacheKey = `${ffmpegPath ?? ''}\0${env.drmDir ?? ''}`;
  const cached = hwCapabilityCache.get(cacheKey);
  if (cached && now - cached.probedAt < PROBE_CACHE_TTL_MS) {
    return cached;
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
    // Not cached: a binary installed later must be seen at once, and this check costs one stat.
    return defaultCaps;
  }

  const supported = probeSupportedEncoders(ffmpegPath);

  const vaapiDevice = VAAPI_DEVICES.find((device) => fs.existsSync(device));
  const isDarwin = process.platform === 'darwin';
  // QSV needs a DRM render node and a session that really opens, not just a compiled-in encoder.
  const qsvEncoder = QSV_ENCODERS.find((enc) => supported.has(enc));
  const qsv =
    qsvEncoder !== undefined &&
    hasDrmRenderNode(env.drmDir ?? DRM_DEVICE_DIR) &&
    canOpenEncoderSession(ffmpegPath, qsvEncoder);
  // NVENC and VAAPI are also only usable when a session really opens (no GPU, no driver, no libcuda).
  const nvencEncoder = NVENC_ENCODERS.find((enc) => supported.has(enc));
  const nvenc = nvencEncoder !== undefined && canOpenEncoderSession(ffmpegPath, nvencEncoder);
  const vaapiEncoder = VAAPI_ENCODERS.find((enc) => supported.has(enc));
  const vaapi =
    vaapiEncoder !== undefined &&
    vaapiDevice !== undefined &&
    canOpenEncoderSession(ffmpegPath, vaapiEncoder, ['-vaapi_device', vaapiDevice], VAAPI_UPLOAD_FILTER);

  const caps: HardwareAccelerationCapabilities = {
    nvenc,
    vaapi,
    qsv,
    videotoolbox: isDarwin && (supported.has('h264_videotoolbox') || supported.has('hevc_videotoolbox')),
    supportedEncoders: supported,
    probedAt: now,
  };

  hwCapabilityCache.set(cacheKey, caps);
  return caps;
}
