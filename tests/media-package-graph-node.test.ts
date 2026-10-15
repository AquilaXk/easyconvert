import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { validateJobGraph, type JobGraph } from '@/lib/jobs';
import { GRAPH_OPERATIONS, FIXED_OUTPUT_FORMATS } from '@/lib/jobs/graph-operations';
import { JobGraphSchema } from '@/lib/api/contracts/schemas';
import { resolveNodeResourceClass } from '@/lib/queue/resource-class';
import { processGraphNodeJob } from '@/lib/queue/graph/node-executor';
import { s3Storage } from '@/lib/storage/s3-storage';
import type { Job } from '@/lib/queue/bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '@/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';
import { requireEncoders } from './helpers/ffmpeg-media-fixtures';
import { extractZipToTemp, parseMasterPlaylist, parseMediaPlaylist } from './helpers/abr-oracle';

/**
 * `media.package` is a graph operation: a video goes in, one ZIP with the HLS playlists (or the DASH manifest)
 * and every segment comes out. The ZIP is read by independent playlist parsers and decoded end to end by ffmpeg.
 */

const ARTIFACT_TTL_MS = 60 * 60 * 1000;
const SOURCE_SECONDS = 6;
const SEGMENT_SECONDS = 2;
const RUNG_HEIGHT = 180;

let seq = 0;

function nodeJob(graphNode: Record<string, unknown>, inputArtifacts: string[]) {
  seq += 1;
  const graphId = `g_pkg_${Date.now()}_${seq}`;
  return {
    id: `${graphId}:n1`,
    data: {
      jobId: `${graphId}:n1`,
      sourceFormat: 'bin',
      targetFormat: 'bin',
      fileSize: 0,
      options: {},
      graphId,
      graphNodeId: 'n1',
      graphNode,
      inputArtifacts,
    },
    opts: { attempts: 1 },
    attemptsMade: 1,
    signal: new AbortController().signal,
    log: async () => {},
    updateProgress: async () => {},
  } as unknown as Job<ConversionJobData, ConversionJobResult>;
}

const graph = (nodes: Record<string, Record<string, unknown>>) => ({ nodes }) as unknown as JobGraph;
const upload = { op: 'import.upload', storageKey: 'uploads/u1/clip.mp4' };

describe('media.package is a canonical graph operation', () => {
  it('is listed in GRAPH_OPERATIONS, in the API schema, and always yields a zip', () => {
    expect(GRAPH_OPERATIONS).toContain('media.package');
    const nodeSchema = (JobGraphSchema as any).properties.nodes.additionalProperties;
    expect(nodeSchema.properties.op.enum).toContain('media.package');
    expect(FIXED_OUTPUT_FORMATS['media.package']).toBe('zip');
  });

  it('validates without a target format and infers a zip for the downstream nodes', () => {
    const result = validateJobGraph(
      graph({
        src: upload,
        pack: { op: 'media.package', input: 'src', options: { packaging: { format: 'dash' } } },
        out: { op: 'export.internal', input: 'pack' },
      })
    );
    expect(result.errors).toEqual([]);
    expect(result.inferredOutputFormats?.pack).toBe('zip');
    expect(result.normalizedNodes?.pack.op).toBe('media.package');
  });

  it('rejects a target format other than zip', () => {
    const result = validateJobGraph(
      graph({ src: upload, pack: { op: 'media.package', input: 'src', targetFormat: 'mp4' }, out: { op: 'export.internal', input: 'pack' } })
    );
    expect(result.errors.map((e) => e.code)).toEqual(['UNSUPPORTED_OUTPUT_FORMAT']);
  });

  it('runs on the cpu class, since its ladder is software video encoding', () => {
    expect(resolveNodeResourceClass({ op: 'media.package', input: 'src' })).toBe('cpu');
  });
});

describe('media.package node execution', () => {
  function sourceClip(dir: string): Buffer {
    requireEncoders('libx264', 'aac');
    const file = path.join(dir, 'clip.mp4');
    execFileSync(requireOracleTool('ffmpeg'), [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=320x${RUNG_HEIGHT}:rate=25:duration=${SOURCE_SECONDS}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${SOURCE_SECONDS}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
    ]);
    return fs.readFileSync(file);
  }

  for (const format of ['hls', 'dash'] as const) {
    oracleTest(
      `a ${format} node stores a ZIP with the ${format === 'hls' ? 'master playlist' : 'manifest'} and its segments, and the package plays`,
      ['ffmpeg', 'ffprobe'],
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-node-'));
        try {
          const key = `tests/media-package-node/${Date.now()}_${seq}_clip.mp4`;
          s3Storage.saveObject(key, sourceClip(dir), 'video/mp4', 'clip.mp4', ARTIFACT_TTL_MS);
          const result = await processGraphNodeJob(
            nodeJob(
              {
                op: 'media.package',
                input: 'src',
                options: { packaging: { format, segmentSeconds: SEGMENT_SECONDS, ladder: [{ height: RUNG_HEIGHT, bitrateK: 300 }] } },
              },
              [key]
            ),
            undefined,
            s3Storage
          );
          expect(result.resultKey).toMatch(new RegExp(`/n1/clip-${format}\\.zip$`));
          const stored = s3Storage.getObject(result.resultKey);
          if (!stored) throw new Error('the packaged ZIP is missing from storage');
          expect(stored.buffer.subarray(0, 2).toString('latin1')).toBe('PK');

          const zip = await JSZip.loadAsync(stored.buffer);
          const names = Object.keys(zip.files);
          const extracted = await extractZipToTemp(stored.buffer);
          try {
            if (format === 'hls') {
              expect(names).toContain('master.m3u8');
              const master = parseMasterPlaylist(fs.readFileSync(path.join(extracted, 'master.m3u8'), 'utf8'));
              expect(master).toHaveLength(1);
              const playlist = parseMediaPlaylist(fs.readFileSync(path.join(extracted, master[0].uri), 'utf8'));
              expect(playlist.segments.length).toBe(Math.ceil(SOURCE_SECONDS / SEGMENT_SECONDS));
              for (const segment of playlist.segments) expect(names).toContain(segment.uri);
              execFileSync(requireOracleTool('ffmpeg'), ['-v', 'error', '-xerror', '-i', path.join(extracted, master[0].uri), '-f', 'null', '-']);
            } else {
              expect(names).toContain('manifest.mpd');
              execFileSync(requireOracleTool('ffmpeg'), ['-v', 'error', '-xerror', '-i', path.join(extracted, 'manifest.mpd'), '-map', '0:v:0', '-f', 'null', '-']);
            }
          } finally {
            fs.rmSync(extracted, { recursive: true, force: true });
          }
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      240_000
    );
  }

  it('fails the node, with the artifact named, when its input is missing from storage', async () => {
    await expect(
      processGraphNodeJob(nodeJob({ op: 'media.package', input: 'src' }, ['tests/none/missing.mp4']), undefined, s3Storage)
    ).rejects.toThrow(/Input artifact "tests\/none\/missing\.mp4" not found in storage/);
  });
});
