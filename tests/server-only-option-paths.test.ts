import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as convertRoute } from '../src/app/api/convert/route';
import { POST as batchRoute } from '../src/app/api/convert/batch/route';
import { POST as queueJobsRoute } from '../src/app/api/queue/jobs/route';
import { POST as v1ConvertRoute } from '../src/app/api/v1/convert/route';
import { POST as v1JobsRoute } from '../src/app/api/v1/jobs/route';
import { ConversionOptionsSchema, SERVER_ONLY_OPTION_KEYS, validateOrProblem } from '../src/lib/api/contracts';
import {
  buildFfmpegArguments,
  buildHlsDashArguments,
  type PackagingSource,
} from '../src/lib/conversions/media-ffmpeg-args';
import { escapeFfmpegFilterPath } from '../src/lib/conversions/media-filter-escape';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { InvalidMediaOptionError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';

/**
 * A request option never names a file of the server. Options that only server code sets (where the worker writes or
 * reads a file, worker limits) are refused by the options schema on every route, so a public request that carries one
 * gets a problem response and nothing is written; an external subtitle file is not a public option; a packaging
 * manifest name is a bare file name; and a path placed in a filtergraph is escaped by FFmpeg's own rules.
 */

const BASE_URL = 'http://localhost:3000';
const CSV_INPUT = 'name,score\nAlice,100\n';
const LEGACY_REJECT = 400;
const V1_REJECT = 422;

let apiKey = '';
let outsideDir = '';
let outsidePath = '';

beforeEach(async () => {
  const email = `serveronly_${Date.now()}_${crypto.randomBytes(6).toString('hex')}@server-only.test`;
  const user = await userStore.createUser({ email, name: 'Server Only Tester', tier: 'pro' });
  apiKey = (await redisKeyStore.generateApiKey(user.id, 'Server Only Key', { scopes: ['convert:write', 'convert:read'] })).secretKey;
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-only-option-'));
  outsidePath = path.join(outsideDir, 'written-by-request.json');
});

afterEach(() => {
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

function multipart(url: string, form: FormData): NextRequest {
  return new NextRequest(`${BASE_URL}${url}`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
}

function jsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(`${BASE_URL}${url}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function csvForm(fileField: 'file' | 'files', options: unknown): FormData {
  const form = new FormData();
  form.append(fileField, new File([CSV_INPUT], 'scores.csv', { type: 'text/csv' }));
  if (fileField === 'file') form.append('targetFormat', 'json');
  form.append('options', JSON.stringify(options));
  return form;
}

async function invalidParamNames(res: Response): Promise<string[]> {
  const body = (await res.json()) as { invalidParams?: Array<{ name: string }> };
  return (body.invalidParams ?? []).map((param) => param.name);
}

describe('a public request cannot name where the server writes the result', () => {
  it('POST /api/convert/batch answers 400 for options.outputPath and writes no file there', async () => {
    const res = await batchRoute(multipart('/api/convert/batch', csvForm('files', { outputPath: outsidePath })));
    expect(res.status).toBe(LEGACY_REJECT);
    expect(await invalidParamNames(res)).toEqual(['outputPath']);
    expect(fs.existsSync(outsidePath)).toBe(false);
  });

  const routes: Array<{ name: string; status: number; param?: string; send: (options: unknown) => Promise<Response> }> = [
    { name: 'POST /api/convert', status: LEGACY_REJECT, send: (options) => convertRoute(multipart('/api/convert', csvForm('file', options))) },
    { name: 'POST /api/queue/jobs', status: LEGACY_REJECT, send: (options) => queueJobsRoute(multipart('/api/queue/jobs', csvForm('file', options))) },
    { name: 'POST /api/v1/convert', status: V1_REJECT, send: (options) => v1ConvertRoute(multipart('/api/v1/convert', csvForm('file', options))) },
    { name: 'POST /api/v1/jobs (multipart)', status: V1_REJECT, send: (options) => v1JobsRoute(multipart('/api/v1/jobs', csvForm('file', options))) },
    {
      name: 'POST /api/v1/jobs (JSON options)',
      status: V1_REJECT,
      param: 'options.outputPath',
      send: (options) =>
        v1JobsRoute(jsonRequest('/api/v1/jobs', { filename: 'scores.csv', targetFormat: 'json', inputBufferBase64: Buffer.from(CSV_INPUT).toString('base64'), options })),
    },
  ];

  for (const route of routes) {
    it(`${route.name} refuses options.outputPath and writes no file there`, async () => {
      const res = await route.send({ outputPath: outsidePath });
      expect(res.status).toBe(route.status);
      expect(await invalidParamNames(res)).toEqual([route.param ?? 'outputPath']);
      expect(fs.existsSync(outsidePath)).toBe(false);
    });
  }

  it('POST /api/v1/jobs refuses a server-only key in the options of a pipeline task and of a graph node', async () => {
    const inline = Buffer.from(CSV_INPUT).toString('base64');
    const tasksRes = await v1JobsRoute(
      jsonRequest('/api/v1/jobs', {
        filename: 'scores.csv',
        targetFormat: 'json',
        inputBufferBase64: inline,
        tasks: [{ operation: 'convert', targetFormat: 'json', options: { outputPath: outsidePath } }],
      })
    );
    expect(tasksRes.status).toBe(V1_REJECT);
    expect(await invalidParamNames(tasksRes)).toContain('tasks.0.options.outputPath');

    const graphRes = await v1JobsRoute(
      jsonRequest('/api/v1/jobs', {
        graph: {
          nodes: {
            src: { op: 'import.upload', storageKey: 'uploads/other-user/scores.csv' },
            out: { op: 'convert', input: 'src', targetFormat: 'json', options: { inputPath: '/etc/passwd' } },
          },
        },
      })
    );
    expect(graphRes.status).toBe(V1_REJECT);
    expect(await invalidParamNames(graphRes)).toContain('graph.nodes.out.options.inputPath');
  });
});

describe('the options schema refuses every server-only key', () => {
  for (const key of SERVER_ONLY_OPTION_KEYS) {
    it(`refuses ${key} and names it`, () => {
      const result = validateOrProblem(ConversionOptionsSchema, { quality: 80, [key]: '/tmp/x' }, '/api/v1/jobs');
      expect(result.ok).toBe(false);
      expect(result.problem?.invalidParams).toEqual([{ name: key, reason: 'server_only_option' }]);
    });
  }

  it('still accepts the engine toggles, which route no path', () => {
    expect(validateOrProblem(ConversionOptionsSchema, { useFfmpeg: true, disableNativeEngine: true, disableHwaccel: true }).ok).toBe(true);
  });

  const subtitleSources = ['/etc/passwd', '../../secrets/subs.srt', 'uploads/another-user/subs.srt'];
  for (const input of subtitleSources) {
    it(`refuses subtitles.input ${JSON.stringify(input)}: an external subtitle file is not a public option`, () => {
      const result = validateOrProblem(ConversionOptionsSchema, { subtitles: { mode: 'burn', input } });
      expect(result.ok).toBe(false);
      expect(result.problem?.invalidParams).toEqual([{ name: 'subtitles.input', reason: 'server_only_option' }]);
    });
  }

  it('POST /api/convert answers 400 for subtitles.input', async () => {
    const res = await convertRoute(multipart('/api/convert', csvForm('file', { subtitles: { mode: 'burn', input: '/etc/passwd' } })));
    expect(res.status).toBe(LEGACY_REJECT);
    expect(await invalidParamNames(res)).toEqual(['subtitles.input']);
  });

  it('accepts an embedded subtitle stream chosen by streamIndex', () => {
    expect(validateOrProblem(ConversionOptionsSchema, { subtitles: { mode: 'burn', streamIndex: 1 } }).ok).toBe(true);
  });
});

const PACKAGING_SOURCE: PackagingSource = {
  geometry: { fpsNum: 25, fpsDen: 1, width: 1920, height: 1080, durationSec: 60 },
  hasAudio: true,
};

describe('a packaging manifest name is a bare file name with the extension of its format', () => {
  const refused: Array<[string, Record<string, unknown>]> = [
    ['../x.m3u8', { format: 'hls', masterPlaylistName: '../x.m3u8' }],
    ['a/b.m3u8', { format: 'hls', masterPlaylistName: 'a/b.m3u8' }],
    ['an absolute path', { format: 'dash', masterPlaylistName: '/tmp/manifest.mpd' }],
    ['a backslash', { format: 'hls', masterPlaylistName: 'a\\b.m3u8' }],
    ['the DASH extension on HLS', { format: 'hls', masterPlaylistName: 'master.mpd' }],
    ['the HLS extension on DASH', { format: 'dash', masterPlaylistName: 'manifest.m3u8' }],
    ['a name over 128 characters', { format: 'hls', masterPlaylistName: `${'a'.repeat(124)}.m3u8` }],
  ];

  for (const [label, packaging] of refused) {
    it(`the schema refuses ${label}`, () => {
      const result = validateOrProblem(ConversionOptionsSchema, { packaging });
      expect(result.ok).toBe(false);
      expect(result.problem?.invalidParams?.map((param) => param.name)).toContain('packaging.masterPlaylistName');
    });

    it(`the argument builder refuses ${label}`, () => {
      expect(() => buildHlsDashArguments('/tmp/in.mp4', '/tmp/out', packaging as never, 'ffmpeg', PACKAGING_SOURCE)).toThrowError(InvalidMediaOptionError);
    });
  }

  it('accepts a bare name and writes the manifest inside the output directory', () => {
    expect(validateOrProblem(ConversionOptionsSchema, { packaging: { format: 'hls', masterPlaylistName: 'Main_v2-1.m3u8' } }).ok).toBe(true);
    expect(validateOrProblem(ConversionOptionsSchema, { packaging: { format: 'dash', masterPlaylistName: 'stream.mpd' } }).ok).toBe(true);
    const dash = buildHlsDashArguments('/tmp/in.mp4', '/tmp/out', { format: 'dash', masterPlaylistName: 'stream.mpd' }, 'ffmpeg', PACKAGING_SOURCE);
    expect(dash.at(-1)).toBe(path.join('/tmp/out', 'stream.mpd'));
    const hls = buildHlsDashArguments('/tmp/in.mp4', '/tmp/out', { format: 'hls', masterPlaylistName: 'Main_v2-1.m3u8' }, 'ffmpeg', PACKAGING_SOURCE);
    expect(hls[hls.indexOf('-master_pl_name') + 1]).toBe('Main_v2-1.m3u8');
  });
});

/**
 * FFmpeg's tokenizer, libavutil/avstring.c `av_get_token`: a backslash takes the next character literally, '…' takes
 * its content literally, leading whitespace and unescaped trailing whitespace are dropped, and the token ends at an
 * unescaped, unquoted character of `term`.
 */
function avGetToken(buf: string, term: string): { token: string; rest: string } {
  const WHITESPACES = ' \n\t\r';
  let p = 0;
  while (p < buf.length && WHITESPACES.includes(buf[p])) p++;
  let out = '';
  let end = 0;
  while (p < buf.length && !term.includes(buf[p])) {
    const c = buf[p++];
    if (c === '\\' && p < buf.length) {
      out += buf[p++];
      end = out.length;
    } else if (c === "'") {
      while (p < buf.length && buf[p] !== "'") out += buf[p++];
      if (p < buf.length) {
        p++;
        end = out.length;
      }
    } else {
      out += c;
    }
  }
  let trimmed = out.length;
  while (trimmed > end && WHITESPACES.includes(out[trimmed - 1])) trimmed--;
  return { token: out.slice(0, trimmed), rest: buf.slice(p) };
}

/** What the subtitles filter receives as its file name, parsed the way libavfilter parses `-vf` (graphparser.c, then ff_filter_opt_parse). */
function parsedFilterFilename(filter: string): { filename: string; rest: string } {
  const name = avGetToken(filter, '=,;[');
  expect(name.token).toBe('subtitles');
  expect(name.rest.startsWith('=')).toBe(true);
  const opts = avGetToken(name.rest.slice(1), '[],;');
  const key = /^filename=/.exec(opts.token);
  expect(key).not.toBeNull();
  return { filename: avGetToken(opts.token.slice('filename='.length), ':').token, rest: opts.rest };
}

describe('a path in a filtergraph is escaped by the FFmpeg filtergraph rules', () => {
  // doc/filters.texi "Notes on filtergraph escaping": a first level for the option value (\ ' :), a second for the
  // filter description (\ ' [ ] , ;); ffmpeg-utils "Quoting and escaping": leading and trailing whitespace is escaped.
  const table: Array<[string, string]> = [
    ['/tmp/plain.srt', '/tmp/plain.srt'],
    ["/tmp/it's.srt", String.raw`/tmp/it\\\'s.srt`],
    ['/tmp/a:b.srt', String.raw`/tmp/a\\:b.srt`],
    [String.raw`/tmp/back\slash.srt`, String.raw`/tmp/back\\\\slash.srt`],
    ['/tmp/a,b.srt', String.raw`/tmp/a\,b.srt`],
    ['/tmp/a;b.srt', String.raw`/tmp/a\;b.srt`],
    ['/tmp/[a]b.srt', String.raw`/tmp/\[a\]b.srt`],
    ['/tmp/a=b.srt', '/tmp/a=b.srt'],
    ['/tmp/trailing ', String.raw`/tmp/trailing\\\ `],
  ];

  for (const [raw, escaped] of table) {
    it(`escapes ${JSON.stringify(raw)}`, () => {
      expect(escapeFfmpegFilterPath(raw)).toBe(escaped);
    });

    it(`FFmpeg's parser reads ${JSON.stringify(raw)} back whole, followed by the next filter`, () => {
      const parsed = parsedFilterFilename(`subtitles=filename=${escapeFfmpegFilterPath(raw)},scale=2:2`);
      expect(parsed.filename).toBe(raw);
      expect(parsed.rest).toBe(',scale=2:2');
    });
  }

  it('the burn filter names the file through the filename option', () => {
    const vf = (args: string[]) => args[args.indexOf('-vf') + 1];
    const args = buildFfmpegArgumentsForBurn("/tmp/sub's:a,b.srt");
    expect(parsedFilterFilename(vf(args)).filename).toBe("/tmp/sub's:a,b.srt");
  });

  oracleTest(
    'ffmpeg opens a file whose name holds every special character through the escaped value',
    ['ffmpeg'],
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-escape-'));
      try {
        const awkward = path.join(dir, String.raw`a'b:c\d,e;f[g]h=i `);
        execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=16x16:d=0.1', '-frames:v', '1', '-f', 'mjpeg', awkward]);
        const graph = `movie=filename=${escapeFfmpegFilterPath(awkward)},scale=8:8`;
        const out = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', graph, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
        expect(out.length).toBe(8 * 8);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});

function buildFfmpegArgumentsForBurn(subtitlePath: string): string[] {
  return buildFfmpegArguments('/nonexistent/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
    disableHwaccel: true,
    subtitles: { mode: 'burn', input: subtitlePath },
  });
}
