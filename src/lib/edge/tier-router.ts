/**
 * Tier Capability Router & Runtime Probing Engine
 *
 * Implements 5-Tier Adaptive Edge routing across:
 * - Level 0: Pure Isomorphic Fast-Path (0 MB Wasm, pure TS/Data/CAD/Audio/Canvas)
 * - Level 1: WebCodecs Hardware Media (GPU/VPU)
 * - Level 2: Zero-COOP SIMD Wasm (Wasm-vips, Tesseract OCR, pdf-lib)
 * - Level 3: OPFS Streaming VFS (100MB+ ~ GB large files)
 * - Level 4: Serverless API Fallback (Cloud Zero-Retention)
 */

import { ConversionOptions } from '../types';
import { isPureDataConvertible } from './pure/pure-data';
import { isPureCadConvertible } from './pure/pure-cad';
import { isPureAudioConvertible } from './pure/pure-audio';
import { isPureCanvasConvertible, isCanvasSupported } from './pure/pure-canvas';

export type ConversionTier = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

export interface EdgeCapabilities {
  hasWebCodecsVideo: boolean;
  hasWebCodecsAudio: boolean;
  hasOpfsSyncAccess: boolean;
  hasWasmSimd: boolean;
  hasCanvas: boolean;
  isCrossOriginIsolated: boolean;
  hardwareConcurrency: number;
  supportedVideoEncoders: string[];
  supportedAudioEncoders: string[];
}

export interface TierResolution {
  tier: ConversionTier;
  tierName: string;
  isClientEdge: boolean;
  reason: string;
}

/**
 * Checks browser WebAssembly SIMD-128 bytecode execution support.
 */
export function checkWasmSimdSupport(): boolean {
  if (typeof WebAssembly === 'undefined' || typeof WebAssembly.validate !== 'function') {
    return false;
  }
  try {
    // 0xfd 0x11 = i32x4.splat
    return WebAssembly.validate(
      new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60,
        0x00, 0x01, 0x7b, 0x03, 0x02, 0x01, 0x00, 0x0a, 0x0a, 0x01, 0x08, 0x00,
        0xfd, 0x11, 0x00, 0x00, 0x00, 0x0b,
      ])
    );
  } catch {
    return false;
  }
}

/**
 * Checks Origin Private File System (OPFS) support.
 */
export function checkOpfsSupport(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'storage' in navigator &&
    typeof navigator.storage?.getDirectory === 'function'
  );
}

/**
 * Probes browser WebCodecs hardware encoder/decoder capabilities.
 */
export async function checkWebCodecsSupport(): Promise<{
  video: boolean;
  audio: boolean;
  supportedVideoEncoders: string[];
  supportedAudioEncoders: string[];
}> {
  const video =
    typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
  const audio =
    typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined';
  const supportedVideoEncoders: string[] = [];
  const supportedAudioEncoders: string[] = [];

  if (video && typeof VideoEncoder.isConfigSupported === 'function') {
    const candidates = ['avc1.42001e', 'avc1.4d002a', 'vp09.00.10.08', 'av01.0.04M.08'];
    for (const codec of candidates) {
      try {
        const res = await VideoEncoder.isConfigSupported({
          codec,
          width: 1280,
          height: 720,
          bitrate: 1_000_000,
          framerate: 30,
        });
        if (res.supported) supportedVideoEncoders.push(codec);
      } catch {
        // Ignored in unsupported test/browser environments
      }
    }
  }

  if (audio && typeof AudioEncoder.isConfigSupported === 'function') {
    const candidates = ['mp4a.40.2', 'opus'];
    for (const codec of candidates) {
      try {
        const res = await AudioEncoder.isConfigSupported({
          codec,
          sampleRate: 44100,
          numberOfChannels: 2,
          bitrate: 128_000,
        });
        if (res.supported) supportedAudioEncoders.push(codec);
      } catch {
        // Ignored
      }
    }
  }

  return { video, audio, supportedVideoEncoders, supportedAudioEncoders };
}

/**
 * Probes complete runtime capabilities of current environment.
 */
export async function probeEdgeCapabilities(): Promise<EdgeCapabilities> {
  const hasWasmSimd = checkWasmSimdSupport();
  const hasOpfsSyncAccess = checkOpfsSupport();
  const hasCanvas = isCanvasSupported();
  const isCrossOriginIsolated =
    typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false;
  const hardwareConcurrency =
    typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;

  const webcodecs = await checkWebCodecsSupport();

  return {
    hasWebCodecsVideo: webcodecs.video,
    hasWebCodecsAudio: webcodecs.audio,
    hasOpfsSyncAccess,
    hasWasmSimd,
    hasCanvas,
    isCrossOriginIsolated,
    hardwareConcurrency,
    supportedVideoEncoders: webcodecs.supportedVideoEncoders,
    supportedAudioEncoders: webcodecs.supportedAudioEncoders,
  };
}

/**
 * Resolves the optimal conversion tier given format pair, file size, options, and capabilities.
 */
export function resolveConversionTier(
  sourceFormat: string,
  targetFormat: string,
  fileSize: number,
  options: ConversionOptions = {},
  capabilities?: Partial<EdgeCapabilities>
): TierResolution {
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();

  // 1. Explicit user opt-out to server
  if (options.clientEdgeMode === false) {
    return {
      tier: 'L4',
      tierName: 'Cloud (Zero-Retention)',
      isClientEdge: false,
      reason: 'Client edge mode disabled by user options',
    };
  }

  // 2. High-volume streaming file (> 100 MB)
  const isLargeFile = fileSize > 100 * 1024 * 1024;
  if (isLargeFile) {
    const opfsAvailable =
      capabilities?.hasOpfsSyncAccess ?? checkOpfsSupport();
    if (opfsAvailable) {
      return {
        tier: 'L3',
        tierName: 'Edge L3 (OPFS Stream)',
        isClientEdge: true,
        reason: 'Large file stream routed to OPFS VFS memory-bounded pipeline',
      };
    }
    return {
      tier: 'L4',
      tierName: 'Cloud (Zero-Retention)',
      isClientEdge: false,
      reason: 'Large file exceeds client RAM and OPFS is unavailable in this browser',
    };
  }

  // 3. Level 0: Pure Isomorphic Fast-Path (0 MB Wasm, instant execution)
  if (isPureDataConvertible(src, tgt)) {
    return {
      tier: 'L0',
      tierName: 'Edge L0 (Instant)',
      isClientEdge: true,
      reason: 'Pure isomorphic structured data conversion (CSV/TSV/JSON/YAML)',
    };
  }

  if (isPureCadConvertible(src, tgt)) {
    return {
      tier: 'L0',
      tierName: 'Edge L0 (Instant)',
      isClientEdge: true,
      reason: 'Pure mathematical CAD B-spline tessellation (STEP/IGES to STL/OBJ)',
    };
  }

  if (isPureAudioConvertible(src, tgt)) {
    return {
      tier: 'L0',
      tierName: 'Edge L0 (Instant)',
      isClientEdge: true,
      reason: 'Pure TypedArray WAV/PCM/MP3 audio encoding',
    };
  }

  const canvasAvailable = capabilities?.hasCanvas ?? isCanvasSupported();
  if (isPureCanvasConvertible(src, tgt) && canvasAvailable) {
    return {
      tier: 'L0',
      tierName: 'Edge L0 (Instant)',
      isClientEdge: true,
      reason: 'Browser Canvas 2D rasterization (PNG/JPEG/WebP/BMP)',
    };
  }

  // 4. Level 2: Wasm SIMD OCR & PDF document pipeline
  if (options.ocrEnabled || src === 'pdf') {
    return {
      tier: 'L2',
      tierName: 'Edge L2 (SIMD Wasm)',
      isClientEdge: true,
      reason: 'Client Wasm OCR and PDF memory vector processing',
    };
  }

  // 5. Level 1: WebCodecs Hardware Media
  const isVideoOrAudio = ['mp4', 'webm', 'mov', 'm4a', 'aac', 'opus'].includes(tgt);
  if (isVideoOrAudio && (capabilities?.hasWebCodecsVideo || capabilities?.hasWebCodecsAudio)) {
    return {
      tier: 'L1',
      tierName: 'Edge L1 (Hardware VPU)',
      isClientEdge: true,
      reason: 'WebCodecs GPU/VPU hardware-accelerated media pipeline',
    };
  }

  // 6. Level 4: Serverless API fallback (Fail-closed or Zero-Data Retention cloud)
  return {
    tier: 'L4',
    tierName: 'Cloud (Zero-Retention)',
    isClientEdge: false,
    reason: 'Format conversion requires cloud serverless engine',
  };
}
