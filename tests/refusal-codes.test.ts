import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import sharp from 'sharp';
import { POST as convertRoute } from '../src/app/api/convert/route';
import { POST as loginRoute } from '../src/app/api/auth/login/route';
import { POST as registerRoute } from '../src/app/api/auth/register/route';
import { POST as queueJobsRoute } from '../src/app/api/queue/jobs/route';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import QueueItemRow from '../src/components/workbench/QueueItemRow';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { DjvuComponentSizeError } from '../src/lib/conversions/djvu-container';
import { OcrTextLayerLimitError } from '../src/lib/conversions/ocr-text-layer';
import { ParquetCodecUnavailableError } from '../src/lib/conversions/parquet-format';
import { SevenZipStructureError } from '../src/lib/conversions/sevenzip-reader';
import { executeItemConversion } from '../src/lib/client-converter';
import { jobFailure, type ConversionFailure } from '../src/lib/conversion-failure';
import { Queue, Worker } from '../src/lib/queue/bullmq-engine';
import { executeSandboxedBinary } from '../src/lib/security/process-sandbox';
import { buildOpenApiDocument } from '../src/lib/api/openapi';
import {
  ArchiveEncryptedHeaderError,
  ArchiveEntryCollisionError,
  DataLimitExceededError,
  EmptyAudioInputError,
  CadExpansionLimitError,
  CpuTaskTimeoutError,
  InvalidMediaOptionError,
  MissingVolumeError,
  OcrLanguageUnavailableError,
  PdfPasswordListError,
  RawEngineRequiredError,
  UnprocessableFontInputError,
  UnsupportedMediaCodecError,
  type ConversionQueueItem,
} from '../src/lib/types';
import { renderDom, select, visibleText } from './helpers/rendered-dom';

/**
 * A refusal names its cause by the `refusalCode` of its error class, which a subclass inherits, on the synchronous route
 * and on a queued job alike. A failure the server did not classify reaches neither the answer nor the page with its own
 * text: a missing program's path stays in the server log.
 */

vi.mock('../src/lib/conversions/dispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/conversions/dispatch')>()),
  dispatchConversion: vi.fn(),
}));

const MISSING_BINARY = '/opt/easyconvert-missing/bin/magick';
const noop = () => undefined;

let png: Uint8Array;

beforeAll(async () => {
  png = new Uint8Array(await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } }).png().toBuffer());
});

afterEach(() => {
  vi.mocked(dispatchConversion).mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function convertRequest(): NextRequest {
  const form = new FormData();
  form.append('file', new File([png], 'pixel.png'));
  form.append('targetFormat', 'jpg');
  return new NextRequest('http://localhost:3000/api/convert', { method: 'POST', body: form });
}

async function convertAnswer(error: Error): Promise<{ status: number; body: Record<string, unknown> }> {
  vi.mocked(dispatchConversion).mockRejectedValueOnce(error);
  const res = await convertRoute(convertRequest());
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Runs one job that throws `error` on its only attempt and waits until it failed. */
async function failedJob(name: string, error: Error) {
  const queue = new Queue<{ n: number }, string>(name);
  const worker = new Worker(queue, async () => { throw error; }, { concurrency: 1 });
  const failed = new Promise<void>((resolve) => worker.on('failed', () => resolve()));
  const job = await queue.add('convert', { n: 1 }, { attempts: 1 });
  await failed;
  await worker.close();
  await queue.close();
  return job;
}

async function spawnFailure(): Promise<Error> {
  try {
    await executeSandboxedBinary(MISSING_BINARY, ['-version']);
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error('a program that does not exist started');
}

function renderedRow(failure: ConversionFailure) {
  const file = new File([png], 'pixel.png');
  const item: ConversionQueueItem = {
    id: 'row-1', file, name: 'pixel.png', size: file.size, sourceFormat: 'png', targetFormat: 'jpg', status: 'error', progress: 0, options: {}, error: failure,
  };
  const dom = renderDom(createElement(QueueItemRow, {
    item,
    onSelectTargetFormat: noop, onOpenOptions: noop, onRemove: noop,
  }));
  return visibleText(dom) + select(dom, 'details').map(visibleText).join(' ');
}

describe('a subclass of a coded error answers its parent code', () => {
  const cases: Array<[string, Error, string]> = [
    ['InvalidMediaOptionError', new InvalidMediaOptionError('Unsupported audio bitrate "x".'), 'option_not_supported'],
    ['PdfPasswordListError', new PdfPasswordListError('None of the passwords opens the PDF.'), 'encrypted_input'],
    ['SevenZipStructureError', new SevenZipStructureError('The 7z header is truncated.'), 'malformed_input'],
    ['RawEngineRequiredError', new RawEngineRequiredError('A native RAW decoder is required.'), 'engine_unavailable'],
    ['ParquetCodecUnavailableError', new ParquetCodecUnavailableError('The LZ4 codec is not available.'), 'engine_unavailable'],
    ['OcrTextLayerLimitError', new OcrTextLayerLimitError('The text layer holds too many words.'), 'input_over_limit'],
  ];

  it.each(cases)('names the code of %s on /api/convert', async (_, error, code) => {
    expect((await convertAnswer(error)).body.code).toBe(code);
  });

  it.each(cases)('records the code of %s on a failed job, which the queue words', async (name, error, code) => {
    const job = await failedJob(`refusal-code-${name}`, error);
    expect(job.failedCode).toBe(name);
    expect(job.failedRefusalCode).toBe(code);
    expect((jobFailure(job).failure as Extract<ConversionFailure, { code: 'jobFailed' }>).refusalCode).toBe(code);
  });
});

describe('/api/convert answers a client mistake with a code', () => {
  it.each([
    ['a JSON body', { 'content-type': 'application/json' }, JSON.stringify({ targetFormat: 'jpg' })],
    ['a text body', { 'content-type': 'text/plain' }, 'file'],
    ['a body without a type', {}, 'file'],
  ])('answers %s 415 with the code multipart_required, and logs nothing', async (_, headers, body) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(noop);
    const res = await convertRoute(new NextRequest('http://localhost:3000/api/convert', { method: 'POST', headers, body }));
    expect({ status: res.status, code: (await res.json()).code }).toEqual({ status: 415, code: 'multipart_required' });
    expect(logged).not.toHaveBeenCalled();
    expect(dispatchConversion).not.toHaveBeenCalled();
  });

  it.each([
    ['MissingVolumeError', new MissingVolumeError('archive.part2.rar'), 'missing_volume'],
    ['ArchiveEncryptedHeaderError', new ArchiveEncryptedHeaderError(), 'encrypted_input'],
  ])('answers %s with its declared 422 and its code', async (_, error, code) => {
    const { status, body } = await convertAnswer(error);
    expect({ status, code: body.code }).toEqual({ status: 422, code });
  });
});

describe('the API document lists, per status, the codes /api/convert answers with', () => {
  const responses = (buildOpenApiDocument().paths['/api/convert'] as { post: { responses: Record<string, unknown> } }).post.responses;
  const documented = (status: number): unknown[] => {
    const response = responses[String(status)] as { content: Record<string, { schema: { allOf: Array<{ properties?: { code?: { enum: unknown[] } } }> } }> };
    return response.content['application/json'].schema.allOf[1].properties?.code?.enum ?? [];
  };

  it('documents the 415 of a body that is not multipart', () => {
    expect(documented(415)).toEqual(['multipart_required']);
  });

  it.each([
    new InvalidMediaOptionError('Unsupported audio bitrate "x".'),
    new PdfPasswordListError('None of the passwords opens the PDF.'),
    new SevenZipStructureError('The 7z header is truncated.'),
    new RawEngineRequiredError('A native RAW decoder is required.'),
    new DataLimitExceededError('The table holds too many rows.'),
    new UnsupportedMediaCodecError('xyz', 'The codec xyz cannot be decoded.'),
    new UnprocessableFontInputError('The font cannot be read in full.'),
    new EmptyAudioInputError('mp3'),
    new ArchiveEntryCollisionError('a.txt'),
    new MissingVolumeError('archive.part2.rar'),
    new ArchiveEncryptedHeaderError(),
    new CpuTaskTimeoutError('png', 1000),
    new CadExpansionLimitError('The drawing expands past the budget.'),
    new DjvuComponentSizeError(20_000_000),
    new OcrLanguageUnavailableError('Unsupported or unrecognized OCR language'),
    new OcrTextLayerLimitError('The page has more than 50000 words.'),
  ])('documents the answer to %s', async (error) => {
    const { status, body } = await convertAnswer(error);
    expect(documented(status), `${error.name} answered ${status} ${String(body.code)}`).toContain(body.code);
  });

  it('documents the 400 of a multipart body that cannot be parsed', () => {
    expect(documented(400).filter((code) => code === 'multipart_required')).toEqual(['multipart_required']);
  });

  it('documents the 429 as the quota alone, since no link import runs on a synchronous conversion', () => {
    expect(JSON.stringify(responses['429']).includes('import_budget_exceeded')).toBe(false);
  });
});

describe('the API document of /api/v1/convert', () => {
  const document = buildOpenApiDocument();
  const v1Responses = (document.paths['/api/v1/convert'] as { post: { responses: Record<string, { description: string }> } }).post.responses;

  it('names the code of a refusal in its problem schema', () => {
    const problem = document.components.schemas.ProblemDetails as { properties: Record<string, { type: string }> };
    expect(problem.properties.code?.type).toBe('string');
  });

  it('describes the 400 of a multipart body that cannot be parsed', () => {
    expect(v1Responses['400'].description).toBe(
      'Invalid input format, missing parameter, a text field such as `options` sent as a file, an unsupported conversion pair, or a body declared `multipart/form-data` that cannot be parsed.'
    );
  });
});

describe('a failure the server did not classify keeps its text in the server log', () => {
  it('answers a program that could not start with a fixed sentence, and logs its path', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(noop);
    const error = await spawnFailure();
    expect(error.message).toContain(MISSING_BINARY);
    const { status, body } = await convertAnswer(error);
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain(MISSING_BINARY);
    expect(body.error).toBe('The conversion failed on the server.');
    expect(logged.mock.calls.flat().map(String).join(' ')).toContain(MISSING_BINARY);
  });

  it('answers a sign-in or sign-up the store failed with a fixed sentence, and logs the store error', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(noop);
    vi.spyOn(redisUserStore, 'findByEmail').mockRejectedValue(new Error('connect ENOENT /var/run/redis/redis.sock'));
    const credentials = (path: string) =>
      new NextRequest(`http://localhost:3000${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'store@fault.test', password: 'LongEnough1' }) });
    const answers = await Promise.all([loginRoute(credentials('/api/auth/login')), registerRoute(credentials('/api/auth/register'))]);
    const bodies = await Promise.all(answers.map(async (res) => ({ status: res.status, body: await res.json() })));
    expect(bodies).toEqual([
      { status: 500, body: { success: false, error: 'Sign-in failed on the server.' } },
      { status: 500, body: { success: false, error: 'Registration failed on the server.' } },
    ]);
    expect(logged.mock.calls.flat().map(String).join(' ')).toContain('/var/run/redis/redis.sock');
  });

  it('answers a job the queue could not take with a fixed sentence, and logs the queue error', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(noop);
    vi.spyOn(conversionQueue, 'add').mockRejectedValue(new Error(`EACCES: open '${MISSING_BINARY}'`));
    const res = await queueJobsRoute(new NextRequest('http://localhost:3000/api/queue/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'pixel.png', targetFormat: 'jpg', inputBufferBase64: Buffer.from(png).toString('base64') }),
    }));
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 500, body: { success: false, error: 'Job enqueue error' } });
    expect(logged.mock.calls.flat().map(String).join(' ')).toContain(MISSING_BINARY);
  });

  it('shows no path on the page for a refused conversion or a failed job', async () => {
    vi.spyOn(console, 'error').mockImplementation(noop);
    // The worker masks the paths under the directories it runs engines from, the configured tool's among them.
    vi.stubEnv('MAGICK_PATH', MISSING_BINARY);
    const error = await spawnFailure();
    vi.mocked(dispatchConversion).mockRejectedValueOnce(error);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => convertRoute(new NextRequest(new URL(url, 'http://localhost:3000'), init as never))));
    const onError = vi.fn<(failure: ConversionFailure) => void>();
    const file = new File([png], 'pixel.png');
    await executeItemConversion(
      { id: 'row-1', file, name: 'pixel.png', size: file.size, sourceFormat: 'png', targetFormat: 'jpg', status: 'ready', progress: 0, options: {} },
      { onProgress: noop, onSuccess: noop, onError }
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(renderedRow(onError.mock.calls[0][0])).not.toContain(MISSING_BINARY);

    const job = await failedJob('refusal-code-spawn', await spawnFailure());
    expect(job.failedReason).not.toContain(MISSING_BINARY);
    expect(renderedRow(jobFailure(job).failure)).not.toContain(MISSING_BINARY);
  });
});
