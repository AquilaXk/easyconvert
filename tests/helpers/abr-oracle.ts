import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

/**
 * Independent readers for HLS (RFC 8216) and MPEG-DASH (ISO/IEC 23009-1) output: playlist and manifest
 * parsers written from the specifications, and ffprobe/ffmpeg probes of what each segment starts with.
 * Nothing here imports the packager under test.
 */

export interface MasterVariant {
  bandwidth: number;
  resolution?: string;
  codecs?: string;
  uri: string;
}

/** The variant streams of an HLS master playlist, in file order. */
export function parseMasterPlaylist(text: string): MasterVariant[] {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '#EXTM3U') throw new Error('playlist does not start with #EXTM3U');
  const variants: MasterVariant[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = lines[i].slice('#EXT-X-STREAM-INF:'.length);
    const bandwidth = /(?:^|,)BANDWIDTH=(\d+)/.exec(attrs);
    if (!bandwidth) throw new Error(`variant without BANDWIDTH: ${lines[i]}`);
    const uri = lines[i + 1];
    if (!uri || uri.startsWith('#')) throw new Error('EXT-X-STREAM-INF is not followed by a URI');
    variants.push({
      bandwidth: Number(bandwidth[1]),
      resolution: /RESOLUTION=(\d+x\d+)/.exec(attrs)?.[1],
      codecs: /CODECS="([^"]+)"/.exec(attrs)?.[1],
      uri,
    });
  }
  return variants;
}

export interface MediaPlaylistSegment {
  uri: string;
  /** EXTINF duration in seconds. */
  duration: number;
}

export interface MediaPlaylist {
  targetDuration: number;
  independentSegments: boolean;
  endList: boolean;
  /** URI of the EXT-X-MAP initialization section, when the segments are fMP4. */
  map?: string;
  segments: MediaPlaylistSegment[];
}

export function parseMediaPlaylist(text: string): MediaPlaylist {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '#EXTM3U') throw new Error('playlist does not start with #EXTM3U');
  const playlist: MediaPlaylist = { targetDuration: 0, independentSegments: false, endList: false, segments: [] };
  let pending: number | undefined;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-TARGETDURATION:')) playlist.targetDuration = Number(line.split(':')[1]);
    else if (line === '#EXT-X-INDEPENDENT-SEGMENTS') playlist.independentSegments = true;
    else if (line === '#EXT-X-ENDLIST') playlist.endList = true;
    else if (line.startsWith('#EXT-X-MAP:')) playlist.map = /URI="([^"]+)"/.exec(line)?.[1];
    else if (line.startsWith('#EXTINF:')) pending = Number(line.slice('#EXTINF:'.length).split(',')[0]);
    else if (line !== '' && !line.startsWith('#') && pending !== undefined) {
      playlist.segments.push({ uri: line, duration: pending });
      pending = undefined;
    }
  }
  return playlist;
}

export interface MpdRepresentation {
  id: string;
  bandwidth: number;
  width?: number;
  height?: number;
  codecs?: string;
  timescale: number;
  initialization: string;
  media: string;
  /** SegmentTimeline entries expanded: start time and duration of every segment, in timescale units. */
  segments: Array<{ start: number; duration: number }>;
}

export interface MpdAdaptationSet {
  contentType: string;
  representations: MpdRepresentation[];
}

/** AdaptationSets of the first Period of a static MPD that uses SegmentTemplate with a SegmentTimeline. */
export function parseMpd(xml: string): MpdAdaptationSet[] {
  const sets: MpdAdaptationSet[] = [];
  const setPattern = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/g;
  for (const setMatch of xml.matchAll(setPattern)) {
    const contentType = /contentType="([^"]+)"/.exec(setMatch[1])?.[1] ?? '';
    const representations: MpdRepresentation[] = [];
    for (const rep of setMatch[2].matchAll(/<Representation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Representation>)/g)) {
      const attrs = rep[1];
      const body = rep[2] ?? '';
      const template = /<SegmentTemplate\b([^>]*)>([\s\S]*?)<\/SegmentTemplate>/.exec(body) ?? /<SegmentTemplate\b([^>]*)>([\s\S]*?)<\/SegmentTemplate>/.exec(setMatch[2]);
      if (!template) throw new Error('no SegmentTemplate for a Representation');
      const timescale = Number(/timescale="(\d+)"/.exec(template[1])?.[1] ?? '1');
      const segments: Array<{ start: number; duration: number }> = [];
      let cursor = 0;
      for (const s of template[2].matchAll(/<S\b([^>]*)\/>/g)) {
        const start = /\bt="(\d+)"/.exec(s[1]);
        const duration = Number(/\bd="(\d+)"/.exec(s[1])?.[1]);
        const repeat = Number(/\br="(\d+)"/.exec(s[1])?.[1] ?? '0');
        if (start) cursor = Number(start[1]);
        for (let n = 0; n <= repeat; n++) {
          segments.push({ start: cursor, duration });
          cursor += duration;
        }
      }
      representations.push({
        id: /\bid="([^"]+)"/.exec(attrs)?.[1] ?? '',
        bandwidth: Number(/bandwidth="(\d+)"/.exec(attrs)?.[1]),
        width: Number(/\bwidth="(\d+)"/.exec(attrs)?.[1]) || undefined,
        height: Number(/\bheight="(\d+)"/.exec(attrs)?.[1]) || undefined,
        codecs: /codecs="([^"]+)"/.exec(attrs)?.[1],
        timescale,
        initialization: /initialization="([^"]+)"/.exec(template[1])?.[1] ?? '',
        media: /\bmedia="([^"]+)"/.exec(template[1])?.[1] ?? '',
        segments,
      });
    }
    sets.push({ contentType, representations });
  }
  return sets;
}

/** Extracts a ZIP to a fresh temporary directory and returns it; the caller removes it. */
export async function extractZipToTemp(zipBytes: Buffer): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abr-oracle-'));
  const zip = await JSZip.loadAsync(zipBytes);
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (name.includes('/') || name.includes('..')) throw new Error(`unexpected nested ZIP entry ${name}`);
    fs.writeFileSync(path.join(dir, name), await entry.async('nodebuffer'));
  }
  return dir;
}

export interface FirstVideoPacket {
  /** Presentation time of the first video packet of the file, in seconds. */
  ptsTime: number;
  isKey: boolean;
}

/** The first video packet of a media file as ffprobe reports it (flags carry K for a keyframe). */
export function firstVideoPacket(ffprobe: string, file: string): FirstVideoPacket {
  const out = execFileSync(
    ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-read_intervals', '%+#1', '-of', 'json', file],
    { encoding: 'utf8' }
  );
  const packet = (JSON.parse(out) as { packets?: Array<{ pts_time: string; flags: string }> }).packets?.[0];
  if (!packet) throw new Error(`no video packet in ${file}`);
  return { ptsTime: Number(packet.pts_time), isKey: packet.flags.includes('K') };
}

/**
 * NAL unit types ffmpeg's trace_headers filter reports for the first access unit of a video stream. The
 * first slice type tells an IDR picture (H.264 type 5, HEVC types 19 and 20) from a plain I or P slice.
 */
export function firstSliceNalType(ffmpeg: string, file: string, codec: 'h264' | 'hevc'): number {
  const run = spawnSync(ffmpeg, ['-hide_banner', '-v', 'verbose', '-i', file, '-map', '0:v:0', '-c', 'copy', '-bsf:v', 'trace_headers', '-frames:v', '1', '-f', 'null', '-'], {
    encoding: 'utf8',
  });
  const types = [...(run.stderr ?? '').matchAll(/nal_unit_type\s+[01]+ = (\d+)/g)].map((m) => Number(m[1]));
  const slice = types.find((type) => (codec === 'h264' ? type === 1 || type === 5 : type <= 21));
  if (slice === undefined) throw new Error(`no slice NAL unit found in ${file}: ${run.stderr?.slice(-400)}`);
  return slice;
}

export interface StreamRate {
  avg: string;
  base: string;
}

/** avg_frame_rate and r_frame_rate of the first video stream. */
export function videoFrameRates(ffprobe: string, file: string): StreamRate {
  const out = execFileSync(
    ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate,r_frame_rate', '-of', 'json', file],
    { encoding: 'utf8' }
  );
  const stream = (JSON.parse(out) as { streams: Array<{ avg_frame_rate: string; r_frame_rate: string }> }).streams[0];
  return { avg: stream.avg_frame_rate, base: stream.r_frame_rate };
}

/** Container duration of a file in seconds. */
export function containerDuration(ffprobe: string, file: string): number {
  const out = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Number(out.trim());
}
