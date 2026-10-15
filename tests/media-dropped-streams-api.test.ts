import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { GET as getV1JobRoute } from '../src/app/api/v1/jobs/[id]/route';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';
import { Worker } from '../src/lib/queue/bullmq-engine';
import { conversionQueue, processConversionJob } from '../src/lib/queue/conversion-queue';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import {
  DROPPED_STREAMS_HEADER,
  MAX_DROPPED_STREAMS,
  MAX_DROPPED_TEXT_CHARS,
  droppedStreamsFields,
  droppedStreamsHeaders,
} from '../src/lib/api/dropped-streams';
import { oracleTest } from './helpers/oracle-test';
import { expectedDrop, libraryMkv, probeBuffer, withFixtureDirAsync } from './helpers/dropped-stream-fixtures';

/**
 * A conversion that leaves a stream out says so on every surface that reports its result: the v1 convert JSON
 * and headers, the job view and its result, the webhook payload schema and the OpenAPI document.
 *
 * Oracle: the expected entries are built from the reference ffprobe's listing of the source mkv, and the output
 * avi is probed by it too; the OpenAPI checks read the published document.
 */

const BASE_URL = 'http://localhost:3000';
const HTTP_OK = 200;
const ENCODE_TIMEOUT_MS = 120_000;
const KEY_NAME = 'Dropped Streams Key';

let secretKey: string;
let userId: string;

beforeEach(async () => {
  const user = await userStore.createUser({
    name: 'Dropped Streams Tester',
    email: `dropped_streams_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
    tier: 'pro',
  });
  userId = user.id;
  const key = await redisKeyStore.generateApiKey(user.id, KEY_NAME, { scopes: ['convert:write', 'convert:read'] });
  secretKey = key.secretKey;
});

function expectedForAvi(mkv: Buffer) {
  const source = probeBuffer(mkv, 'mkv');
  return [
    ...source.streams.filter((s) => s.codec_type === 'subtitle').map((s) => expectedDrop(s, 'subtitle', 'container_unsupported')),
    ...source.streams.filter((s) => s.codec_type === 'attachment').map((s) => expectedDrop(s, 'attachment', 'container_unsupported')),
  ];
}

function convertRequest(mkv: Buffer, headers: Record<string, string> = {}): NextRequest {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(mkv)]), 'library.mkv');
  form.append('targetFormat', 'avi');
  return new NextRequest(`${BASE_URL}/api/v1/convert`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}`, ...headers },
    body: form,
  });
}

async function jobView(mkv: Buffer): Promise<Record<string, any>> {
  const worker = new Worker(conversionQueue, processConversionJob, { concurrency: 1 });
  const done = new Promise<void>((resolve) => {
    worker.on('completed', () => resolve());
    worker.on('failed', () => resolve());
  });
  const job = await conversionQueue.add('convert', {
    jobId: '',
    originalFilename: 'library.mkv',
    sourceFormat: 'mkv',
    targetFormat: 'avi',
    fileSize: mkv.length,
    options: {},
    inputBufferBase64: mkv.toString('base64'),
    userId,
  });
  await done;
  await worker.close();
  const res = await getV1JobRoute(
    new NextRequest(`${BASE_URL}/api/v1/jobs/${job.id}`, { headers: { Authorization: `Bearer ${secretKey}` } }),
    { params: Promise.resolve({ id: job.id }) }
  );
  expect(res.status).toBe(HTTP_OK);
  return res.json();
}

describe('POST /api/v1/convert reports dropped streams', () => {
  oracleTest(
    'lists the 2 subtitle tracks and the attachment of an mkv converted to avi in the JSON and in the raw headers',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withFixtureDirAsync(async (dir) => {
        const mkv = libraryMkv(dir);
        const expected = expectedForAvi(mkv);
        expect(expected.map((e) => e.kind)).toEqual(['subtitle', 'subtitle', 'attachment']);

        const json = await v1ConvertPost(convertRequest(mkv));
        expect(json.status).toBe(HTTP_OK);
        const body = await json.json();
        expect(body.droppedStreams).toEqual(expected);

        const raw = await v1ConvertPost(convertRequest(mkv, { Accept: 'application/octet-stream' }));
        expect(raw.status).toBe(HTTP_OK);
        const header = raw.headers.get(DROPPED_STREAMS_HEADER);
        expect(header).toBe(expected.map((e) => `${e.kind}#${e.index}:container_unsupported`).join(','));
        // The raw body is an avi without any subtitle stream.
        const avi = probeBuffer(Buffer.from(await raw.arrayBuffer()), 'avi');
        expect(avi.streams.map((s) => s.codec_type).sort()).toEqual(['audio', 'video']);
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'sends no droppedStreams when the target carries every stream',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withFixtureDirAsync(async (dir) => {
        const mkv = libraryMkv(dir);
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(mkv)]), 'library.mkv');
        form.append('targetFormat', 'mkv');
        const res = await v1ConvertPost(
          new NextRequest(`${BASE_URL}/api/v1/convert`, { method: 'POST', headers: { Authorization: `Bearer ${secretKey}` }, body: form })
        );
        expect(res.status).toBe(HTTP_OK);
        expect(await res.json()).not.toHaveProperty('droppedStreams');
      });
    },
    ENCODE_TIMEOUT_MS
  );
});

describe('GET /api/v1/jobs/{id} reports dropped streams', () => {
  oracleTest(
    'carries the list in the job view and in its result',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withFixtureDirAsync(async (dir) => {
        const mkv = libraryMkv(dir);
        const expected = expectedForAvi(mkv);
        const body = await jobView(mkv);
        expect(body.status).toBe('completed');
        expect(body.droppedStreams).toEqual(expected);
        expect(body.result.droppedStreams).toEqual(expected);
      });
    },
    ENCODE_TIMEOUT_MS
  );
});

describe('droppedStreamsFields', () => {
  const valid = { index: 3, kind: 'subtitle', codec: 'subrip', language: 'eng', title: 'English', reason: 'container_unsupported' };

  it('reads the list from the result metadata or from a stored job result', () => {
    expect(droppedStreamsFields({ metadata: { droppedStreams: [valid] } })).toEqual({ droppedStreams: [valid] });
    expect(droppedStreamsFields({ droppedStreams: [valid] })).toEqual({ droppedStreams: [valid] });
  });

  it('answers nothing when nothing was dropped or the value is not a list', () => {
    expect(droppedStreamsFields({})).toEqual({});
    expect(droppedStreamsFields({ metadata: { droppedStreams: [] } })).toEqual({});
    expect(droppedStreamsFields({ metadata: { droppedStreams: 'subtitle' } })).toEqual({});
  });

  it('ignores entries with an unknown kind or reason and keeps the valid ones', () => {
    const fields = droppedStreamsFields({
      droppedStreams: [{ ...valid, kind: 'telepathy' }, { ...valid, reason: 'because' }, null, 'x', valid],
    });
    expect(fields.droppedStreams).toEqual([valid]);
  });

  it('drops a negative or fractional index, strips control characters and bounds the text', () => {
    const fields = droppedStreamsFields({
      droppedStreams: [{ ...valid, index: -1, title: `a\u0000b\nc${'x'.repeat(MAX_DROPPED_TEXT_CHARS * 2)}` }, { ...valid, index: 1.5, codec: '  ' }],
    });
    const [first, second] = fields.droppedStreams!;
    expect(first).not.toHaveProperty('index');
    expect(first.title!.startsWith('a b c')).toBe(true);
    expect(first.title!.length).toBe(MAX_DROPPED_TEXT_CHARS);
    expect(second).not.toHaveProperty('index');
    expect(second).not.toHaveProperty('codec');
  });

  it('lists at most MAX_DROPPED_STREAMS entries', () => {
    const many = Array.from({ length: MAX_DROPPED_STREAMS * 2 }, (_, i) => ({ ...valid, index: i }));
    expect(droppedStreamsFields({ droppedStreams: many }).droppedStreams).toHaveLength(MAX_DROPPED_STREAMS);
  });

  it('formats the header as kind[#index]:reason entries, chapters without an index', () => {
    const headers = droppedStreamsHeaders({
      droppedStreams: [valid, { kind: 'chapters', reason: 'container_unsupported' }],
    });
    expect(headers).toEqual({ [DROPPED_STREAMS_HEADER]: 'subtitle#3:container_unsupported,chapters:container_unsupported' });
    expect(droppedStreamsHeaders({})).toEqual({});
  });
});

describe('OpenAPI document', () => {
  it('documents droppedStreams on the convert response, the job view, its result and the webhook, and the header', async () => {
    const spec = await (await getOpenApiSpec()).json();
    const response = spec.components.schemas.ConversionResponse.properties.droppedStreams;
    expect(response.type).toBe('array');
    expect(response.maxItems).toBe(MAX_DROPPED_STREAMS);
    expect(response.items.required).toEqual(['kind', 'reason']);
    expect(response.items.properties.reason.enum).toEqual(['container_unsupported', 'stream_type_unsupported', 'additional_video_track']);
    expect(response.items.properties.kind.enum).toEqual(['video', 'subtitle', 'attachment', 'data', 'attached_picture', 'chapters']);

    const job = spec.components.schemas.JobResource.properties;
    expect(job.droppedStreams.type).toBe('array');
    expect(job.result.properties.droppedStreams.type).toBe('array');

    const headers = spec.paths['/api/v1/convert'].post.responses['200'].headers;
    expect(headers[DROPPED_STREAMS_HEADER].schema.type).toBe('string');
    const internal = spec.paths['/api/convert'].post.responses['200'].headers;
    expect(internal[DROPPED_STREAMS_HEADER].schema.type).toBe('string');

    const webhook = JSON.stringify(spec.webhooks['job.completed']);
    expect(webhook).toContain('droppedStreams');
  });
});
