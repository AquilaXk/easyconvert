import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOracleToolPath } from './differential-oracle';

/**
 * ffprobe as the independent reader of container facts: streams (codec, profile, level, size, rate, channels)
 * and every packet (pts, dts, duration, size, key flag). Nothing here imports the engines under test.
 */

export interface FfprobeStream {
  index: number;
  codec_name: string;
  codec_type: 'video' | 'audio';
  profile?: string;
  level?: number;
  width?: number;
  height?: number;
  sample_rate?: string;
  channels?: number;
  extradata_size?: number;
  time_base: string;
  start_time?: string;
  duration?: string;
  nb_frames?: string;
  codec_tag_string?: string;
  pix_fmt?: string;
  /** Colour description ffprobe read from the file (names, as `bt709` or `smpte170m`); absent or `unknown` when unstated. */
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  /** `tv` (limited) or `pc` (full). */
  color_range?: string;
  /** Pixel aspect ratio as `num:den`. */
  sample_aspect_ratio?: string;
}

export interface FfprobePacket {
  stream_index: number;
  pts?: number;
  pts_time?: string;
  dts?: number;
  dts_time?: string;
  duration?: number;
  duration_time?: string;
  size: string;
  flags: string;
  /** `CRC32:xxxxxxxx` of the packet bytes, present when the probe ran with `-show_data_hash crc32`. */
  data_hash?: string;
}

export interface FfprobeReport {
  streams: FfprobeStream[];
  packets: FfprobePacket[];
  format: { format_name: string; duration?: string };
}

const MAX_PROBE_OUTPUT_BYTES = 128 * 1024 * 1024;

export function requireFfprobe(): string {
  const found = getOracleToolPath('ffprobe');
  if (!found) throw new Error('ffprobe is required by this oracle test but is not installed (ORACLE_STRICT_MODE=1)');
  return found;
}

/** Runs `ffprobe -show_streams -show_packets -show_format` on `bytes` written with the given extension. */
export function ffprobeReport(bytes: Uint8Array, extension: string): FfprobeReport {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ffprobe-json-'));
  try {
    const file = path.join(dir, `input.${extension}`);
    writeFileSync(file, bytes);
    const out = execFileSync(
      requireFfprobe(),
      ['-v', 'error', '-show_streams', '-show_packets', '-show_data_hash', 'crc32', '-show_format', '-of', 'json', file],
      { encoding: 'utf8', maxBuffer: MAX_PROBE_OUTPUT_BYTES }
    );
    const parsed = JSON.parse(out) as Partial<FfprobeReport>;
    return {
      streams: parsed.streams ?? [],
      packets: parsed.packets ?? [],
      format: parsed.format ?? { format_name: '' },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** ISO/IEC 14496-10 profile_idc of the profile names ffprobe prints. */
const AVC_PROFILE_IDC: Readonly<Record<string, number>> = {
  Baseline: 66,
  'Constrained Baseline': 66,
  Main: 77,
  Extended: 88,
  High: 100,
  'High 10': 110,
  'High 4:2:2': 122,
  'High 4:4:4 Predictive': 244,
};

/** The first three bytes after the version byte of avcC, as ffprobe's profile and level imply them. */
export function avcProfileAndLevelHex(stream: FfprobeStream): { profileIdc: string; level: string } {
  const idc = AVC_PROFILE_IDC[stream.profile ?? ''];
  if (idc === undefined || stream.level === undefined) throw new Error(`no AVC profile or level in ${JSON.stringify(stream)}`);
  return { profileIdc: idc.toString(16).padStart(2, '0'), level: stream.level.toString(16).padStart(2, '0') };
}
