import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { convertMedia } from '../src/lib/conversions/media';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { craftWav, int16Bytes, sineSamples } from './helpers/wav-craft';

/**
 * The bytes an Opus file holds beyond the encoder's packets. The oracle is ffmpeg driven directly with libopus at the
 * same rate: for a source with no tags the project's file must have the reference's size to the byte (the Ogg
 * pages, OpusHead and OpusTags are the muxer's, with nothing of ours added), and for a source with tags the file
 * grows by the tags alone, the same as the reference's default metadata copy. The tags of the source stay in the
 * file: they are the user's data, and a converter that drops them would be smaller by the same bytes.
 */

const TEST_TIMEOUT_MS = 120_000;
const FFMPEG_TIMEOUT_MS = 60_000;
const SAMPLE_RATE = 8000;
const SECONDS = 3;
const AMPLITUDE = 8000;
const TONE_HZ = 440;
const BITRATE_K = 12;
const TAGS: ReadonlyArray<readonly [string, string]> = [
  ['INAM', 'Female Speech (English)'],
  ['IART', 'A Sound Quality Assessment Material'],
  ['ICMT', 'Not for commercial use'],
  ['IGNR', 'Other'],
];

let workDir: string;
beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-opus-tags-'));
});
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** A `LIST` chunk of type `INFO` holding the given sub-chunks, each padded to an even length. */
function infoList(tags: ReadonlyArray<readonly [string, string]>): Uint8Array {
  const parts: Uint8Array[] = [new TextEncoder().encode('INFO')];
  for (const [id, text] of tags) {
    const value = new TextEncoder().encode(`${text}\0`);
    const sub = new Uint8Array(8 + value.length + (value.length % 2));
    sub.set(new TextEncoder().encode(id), 0);
    new DataView(sub.buffer).setUint32(4, value.length, true);
    sub.set(value, 8);
    parts.push(sub);
  }
  const body = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    body.set(part, at);
    at += part.length;
  }
  return body;
}

function writeWav(name: string, tags: ReadonlyArray<readonly [string, string]>): string {
  const samples = sineSamples(SAMPLE_RATE * SECONDS, 1, SAMPLE_RATE, TONE_HZ, AMPLITUDE);
  const file = path.join(workDir, name);
  fs.writeFileSync(
    file,
    craftWav({ sampleRate: SAMPLE_RATE, channels: 1, bitsPerSample: 16, data: int16Bytes(samples), before: tags.length > 0 ? [{ id: 'LIST', body: infoList(tags) }] : [] })
  );
  return file;
}

function tool(name: 'ffmpeg' | 'ffprobe'): string {
  const found = getOracleToolPath(name);
  if (found === null) throw new Error(`${name} is not installed`);
  return found;
}

async function oursSize(source: string): Promise<{ bytes: number; file: string }> {
  const converted = await convertMedia(fs.readFileSync(source), 'wav', 'opus', { audio: { codec: 'opus', bitrateK: BITRATE_K } }, path.basename(source));
  const file = path.join(workDir, `ours-${path.basename(source)}.opus`);
  fs.writeFileSync(file, converted.buffer);
  return { bytes: converted.buffer.length, file };
}

function referenceSize(source: string, metadataArgs: string[]): number {
  const file = path.join(workDir, `ref-${metadataArgs.length}-${path.basename(source)}.opus`);
  execFileSync(tool('ffmpeg'), ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', source, '-vn', ...metadataArgs, '-c:a', 'libopus', '-b:a', `${BITRATE_K}k`, file], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: FFMPEG_TIMEOUT_MS,
  });
  return fs.statSync(file).size;
}

function streamTags(file: string): Record<string, string> {
  const out = execFileSync(tool('ffprobe'), ['-v', 'error', '-show_entries', 'stream_tags', '-of', 'json', file], { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS });
  const parsed = JSON.parse(out) as { streams: Array<{ tags?: Record<string, string> }> };
  const found: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.streams[0]?.tags ?? {})) found[key.toLowerCase()] = value;
  return found;
}

describe('an Opus file holds the packets, the muxer headers and the source tags, and nothing else', () => {
  oracleTest('a source with no tags gives the size of the reference encode with its metadata removed', ['ffmpeg', 'ffprobe'], async () => {
    const source = writeWav('plain.wav', []);
    const ours = await oursSize(source);
    expect(ours.bytes).toBe(referenceSize(source, ['-map_metadata', '-1']));
    expect(ours.bytes).toBe(referenceSize(source, []));
  }, TEST_TIMEOUT_MS);

  oracleTest('the tags of the source are written to the file, which then equals the reference encode that copies them', ['ffmpeg', 'ffprobe'], async () => {
    const source = writeWav('tagged.wav', TAGS);
    const ours = await oursSize(source);
    const stripped = referenceSize(source, ['-map_metadata', '-1']);
    expect(ours.bytes).toBe(referenceSize(source, []));
    expect(ours.bytes).toBeGreaterThan(stripped);
    const tags = streamTags(ours.file);
    expect(tags.title).toBe(TAGS[0][1]);
    expect(tags.artist).toBe(TAGS[1][1]);
    expect(tags.comment).toBe(TAGS[2][1]);
    expect(tags.genre).toBe(TAGS[3][1]);
  }, TEST_TIMEOUT_MS);
});
