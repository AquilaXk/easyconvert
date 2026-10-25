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

/** Every route that takes conversion options; `prefix` is where the route names a key of the options in `invalidParams`. */
const routes: Array<{ name: string; status: number; prefix?: string; send: (options: unknown) => Promise<Response> }> = [
  { name: 'POST /api/convert/batch', status: LEGACY_REJECT, send: (options) => batchRoute(multipart('/api/convert/batch', csvForm('files', options))) },
  { name: 'POST /api/convert', status: LEGACY_REJECT, send: (options) => convertRoute(multipart('/api/convert', csvForm('file', options))) },
  { name: 'POST /api/queue/jobs', status: LEGACY_REJECT, send: (options) => queueJobsRoute(multipart('/api/queue/jobs', csvForm('file', options))) },
  { name: 'POST /api/v1/convert', status: V1_REJECT, send: (options) => v1ConvertRoute(multipart('/api/v1/convert', csvForm('file', options))) },
  { name: 'POST /api/v1/jobs (multipart)', status: V1_REJECT, send: (options) => v1JobsRoute(multipart('/api/v1/jobs', csvForm('file', options))) },
  {
    name: 'POST /api/v1/jobs (JSON options)',
    status: V1_REJECT,
    prefix: 'options.',
    send: (options) =>
      v1JobsRoute(jsonRequest('/api/v1/jobs', { filename: 'scores.csv', targetFormat: 'json', inputBufferBase64: Buffer.from(CSV_INPUT).toString('base64'), options })),
  },
];

describe('a public request cannot switch FFmpeg off', () => {
  for (const route of routes) {
    it(`${route.name} refuses options.disableNativeEngine`, async () => {
      const res = await route.send({ disableNativeEngine: true });
      expect(res.status).toBe(route.status);
      expect(await invalidParamNames(res)).toEqual([`${route.prefix ?? ''}disableNativeEngine`]);
    });
  }
});

describe('a public request cannot name where the server writes the result', () => {
  for (const route of routes) {
    it(`${route.name} refuses options.outputPath and writes no file there`, async () => {
      const res = await route.send({ outputPath: outsidePath });
      expect(res.status).toBe(route.status);
      expect(await invalidParamNames(res)).toEqual([`${route.prefix ?? ''}outputPath`]);
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

/** Options as JSON.parse builds them from `{"__proto__": inner}`: an own key named `__proto__`, not a prototype. */
function ownProtoOptions(inner: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(`{"__proto__":${JSON.stringify(inner)}}`) as Record<string, unknown>;
}

describe('a "__proto__" key cannot carry options past the boundary', () => {
  for (const route of routes) {
    it(`${route.name} refuses options whose own "__proto__" holds outputPath, and writes no file there`, async () => {
      const res = await route.send(ownProtoOptions({ outputPath: outsidePath }));
      expect(fs.existsSync(outsidePath)).toBe(false);
      expect(res.status).toBe(route.status);
      expect(await invalidParamNames(res)).toEqual([`${route.prefix ?? ''}__proto__`]);
    });
  }

  it('POST /api/v1/jobs refuses a "__proto__" key in the options of a pipeline task and of a graph node', async () => {
    const inline = Buffer.from(CSV_INPUT).toString('base64');
    const tasksRes = await v1JobsRoute(
      jsonRequest('/api/v1/jobs', {
        filename: 'scores.csv',
        targetFormat: 'json',
        inputBufferBase64: inline,
        tasks: [{ operation: 'convert', targetFormat: 'json', options: ownProtoOptions({ outputPath: outsidePath }) }],
      })
    );
    expect(tasksRes.status).toBe(V1_REJECT);
    expect(await invalidParamNames(tasksRes)).toEqual(['tasks.0.options.__proto__']);

    const graphRes = await v1JobsRoute(
      jsonRequest('/api/v1/jobs', {
        graph: {
          nodes: {
            src: { op: 'import.upload', storageKey: 'uploads/other-user/scores.csv' },
            out: { op: 'convert', input: 'src', targetFormat: 'json', options: ownProtoOptions({ inputPath: '/etc/passwd' }) },
          },
        },
      })
    );
    expect(graphRes.status).toBe(V1_REJECT);
    expect(await invalidParamNames(graphRes)).toEqual(['graph.nodes.out.options.__proto__']);
    expect(fs.existsSync(outsidePath)).toBe(false);
  });

  it('refuses a "__proto__" key at any depth, naming where it sits', () => {
    const lifted = validateOrProblem(ConversionOptionsSchema, ownProtoOptions({ subtitles: { mode: 'burn', input: '/etc/passwd' } }));
    expect(lifted.problem?.invalidParams).toEqual([{ name: '__proto__', reason: 'prototype_key' }]);

    const nested = JSON.parse('{"subtitles":{"mode":"burn","__proto__":{"input":"/etc/passwd"}},"extra":[{"__proto__":{}}]}');
    expect(validateOrProblem(ConversionOptionsSchema, nested).problem?.invalidParams).toEqual([
      { name: 'subtitles.__proto__', reason: 'prototype_key' },
      { name: 'extra.0.__proto__', reason: 'prototype_key' },
    ]);
  });

  it('refuses a "constructor" key that holds a "prototype", and accepts a "constructor" that is plain data', () => {
    const poisoned = JSON.parse('{"metadata":{"constructor":{"prototype":{"outputPath":"/x"}}}}');
    expect(validateOrProblem(ConversionOptionsSchema, poisoned).problem?.invalidParams).toEqual([
      { name: 'metadata.constructor', reason: 'prototype_key' },
    ]);
    expect(validateOrProblem(ConversionOptionsSchema, JSON.parse('{"constructor":"x","note":{"constructor":null}}')).ok).toBe(true);
  });

  it('scans a nesting deeper than the call stack without overflowing it', () => {
    const depth = 50_000;
    const text = `${'{"a":'.repeat(depth)}{"__proto__":{}}${'}'.repeat(depth)}`;
    const result = validateOrProblem(ConversionOptionsSchema, JSON.parse(text));
    expect(result.ok).toBe(false);
    expect(result.problem?.invalidParams?.[0]?.name.endsWith('a.a.__proto__')).toBe(true);
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

  it('still accepts the engine toggles a caller may set, which route no path', () => {
    expect(validateOrProblem(ConversionOptionsSchema, { useFfmpeg: true, disableHwaccel: true }).ok).toBe(true);
  });

  it('refuses disableNativeEngine, the switch that keeps a source away from FFmpeg', () => {
    const result = validateOrProblem(ConversionOptionsSchema, { disableNativeEngine: true });
    expect(result.ok).toBe(false);
    expect(result.problem?.invalidParams).toEqual([{ name: 'disableNativeEngine', reason: 'server_only_option' }]);
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

/**
 * A read of an options key through a cast, `(options as any).key`, `(item.options as { key?: T })?.key` or
 * `(opts as Record<string, unknown>)['key']`: the reads the schema and the server-only list cannot see.
 */
const CAST_OPTION_READ =
  /\(\s*(?:[\w$]+(?:\?\.|\.))*(?:options|opts)[?!]?\s+as\s+[^()]*?\)\s*(?:(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)|(?:\?\.)?\[\s*['"]([^'"]+)['"]\s*\])/g;

/** Keys read through a cast that the schema does not declare and that name no file; each waits to be declared or removed. */
const UNDECLARED_ROUTING_READS = ['brightnessDelta', 'grayscale', 'hwaccel', 'invert'];

describe('every options key production code reads through a cast is public or server-only', () => {
  it('names no other key, so the server-only list cannot go stale', () => {
    const declared = new Set<string>([...Object.keys(ConversionOptionsSchema.properties), ...SERVER_ONLY_OPTION_KEYS]);
    const src = path.resolve(__dirname, '..', 'src');
    const undeclared = new Map<string, string[]>();
    for (const file of fs.readdirSync(src, { recursive: true }).map(String)) {
      if (!/\.tsx?$/.test(file)) continue;
      for (const match of fs.readFileSync(path.join(src, file), 'utf8').matchAll(CAST_OPTION_READ)) {
        const key = match[1] ?? match[2];
        if (!declared.has(key)) undeclared.set(key, [...(undeclared.get(key) ?? []), file]);
      }
    }
    expect([...undeclared.keys()].sort(), JSON.stringify(Object.fromEntries(undeclared))).toEqual(UNDECLARED_ROUTING_READS);
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
