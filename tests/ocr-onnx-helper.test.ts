import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkedResult,
  onnxHelperPlan,
  onnxOcrUnavailableReason,
  OnnxOcrFailedError,
  OnnxOcrPool,
  OnnxOcrUnavailableError,
  ONNX_OCR_SWITCH_ENV,
} from '../src/lib/conversions/ocr-onnx-helper';
import { ONNX_OCR_MODEL_DIR_ENV, type OnnxPageInput } from '../src/lib/conversions/ocr-onnx';
import {
  encodeFrame,
  FrameReader,
  MAX_PAGE_PIXELS,
  OnnxProtocolError,
  validateRunRequest,
  type OnnxRunRequest,
} from '../src/lib/conversions/ocr-onnx-protocol';
import { koreanOnnxLanguages } from '../src/lib/conversions/ocr-onnx-route';

const FAKE_CHILD = path.join(__dirname, 'helpers', 'fake-onnx-child.cjs');
const entryFor = (mode: string) => ({ binary: process.execPath, args: [FAKE_CHILD, `--mode=${mode}`] });

function page(width = 8, height = 6): OnnxPageInput {
  return { width, height, rgb: new Uint8Array(width * height * 3), detector: { width: 4, height: 4, rgb: new Uint8Array(48) } };
}

const pools: OnnxOcrPool[] = [];
function makePool(mode: string, options: ConstructorParameters<typeof OnnxOcrPool>[0] = {}): OnnxOcrPool {
  const pool = new OnnxOcrPool({ plan: { helpers: 1, threads: 1 }, modelDir: '/unused', entry: entryFor(mode), ...options });
  pools.push(pool);
  return pool;
}
afterEach(() => {
  for (const pool of pools.splice(0)) pool.shutdown();
});

describe('the ONNX OCR helper protocol', () => {
  const request: OnnxRunRequest = { type: 'run', id: 1, width: 2, height: 2, detector: { width: 2, height: 2 }, language: 'kor', recoverSpaces: true };

  it('reassembles a frame that arrives in pieces and two frames that arrive together', () => {
    const bytes = Buffer.concat(encodeFrame(request, Buffer.alloc(24, 7)));
    const reader = new FrameReader<OnnxRunRequest>();
    expect(reader.push(bytes.subarray(0, 5))).toEqual([]);
    expect(reader.push(bytes.subarray(5, 40))).toEqual([]);
    const frames = reader.push(Buffer.concat([bytes.subarray(40), bytes]));
    expect(frames).toHaveLength(2);
    expect(frames[0].header).toEqual(request);
    expect(frames[0].payload).toEqual(Buffer.alloc(24, 7));
  });

  it('refuses a length past the limits and a header that is not JSON', () => {
    const prefix = Buffer.alloc(8);
    prefix.writeUInt32BE(64 * 1024 * 1024, 0);
    expect(() => new FrameReader().push(prefix)).toThrow(OnnxProtocolError);
    const bad = Buffer.concat([Buffer.from([0, 0, 0, 3, 0, 0, 0, 0]), Buffer.from('{{{')]);
    expect(() => new FrameReader().push(bad)).toThrow(OnnxProtocolError);
  });

  it('accepts a request whose payload is exactly its pixels and refuses the others', () => {
    expect(validateRunRequest(request, 3 * (4 + 4))).toBeNull();
    expect(validateRunRequest(request, 3 * 8 + 1)).toMatch(/payload/);
    expect(validateRunRequest({ ...request, width: 0 }, 0)).toMatch(/malformed/);
    expect(validateRunRequest({ ...request, width: 1.5 }, 0)).toMatch(/malformed/);
    expect(validateRunRequest({ ...request, language: 5 as unknown as string }, 24)).toMatch(/malformed/);
    expect(validateRunRequest({ ...request, width: MAX_PAGE_PIXELS, height: 2 }, 0)).toMatch(/too many/);
  });
});

describe('checking a helper reply', () => {
  const box = { x: 1, y: 1, width: 4, height: 3 };
  const good = { lineBlocks: [{ text: '가나', bbox: box, words: [{ text: '가나', confidence: 0.5, bbox: box }] }] };

  it('rebuilds the page from the fields the product reads', () => {
    const result = checkedResult({ ...good, extra: 'dropped', lineBlocks: [{ ...good.lineBlocks[0], injected: true }] }, 10, 10, 'kor');
    expect(result.text).toBe('가나');
    expect(result.language).toBe('kor');
    expect(result.imageWidth).toBe(10);
    expect(result.wordCount).toBe(1);
    expect(result.confidenceCalibrated).toBe(false);
    expect(JSON.stringify(result)).not.toContain('injected');
  });

  it.each([
    ['a confidence above one', { lineBlocks: [{ ...good.lineBlocks[0], words: [{ text: 'a', confidence: 2, bbox: box }] }] }],
    ['a box outside the page', { lineBlocks: [{ ...good.lineBlocks[0], bbox: { x: 0, y: 0, width: 999, height: 3 } }] }],
    ['a non-finite number', { lineBlocks: [{ ...good.lineBlocks[0], bbox: { x: NaN, y: 0, width: 1, height: 1 } }] }],
    ['a text that is not a string', { lineBlocks: [{ ...good.lineBlocks[0], text: 5 }] }],
    ['no lines', { lines: [] }],
    ['an endless text', { lineBlocks: [{ ...good.lineBlocks[0], text: 'x'.repeat(10_000) }] }],
  ])('refuses %s', (_name, reply) => {
    expect(() => checkedResult(reply, 10, 10, 'kor')).toThrow(OnnxOcrFailedError);
  });
});

describe('where the ONNX engine is used', () => {
  it('sizes the helpers by the cores', () => {
    expect(onnxHelperPlan(1)).toEqual({ helpers: 1, threads: 1 });
    expect(onnxHelperPlan(2)).toEqual({ helpers: 1, threads: 2 });
    expect(onnxHelperPlan(4)).toEqual({ helpers: 1, threads: 4 });
    expect(onnxHelperPlan(6)).toEqual({ helpers: 2, threads: 3 });
    expect(onnxHelperPlan(64)).toEqual({ helpers: 3, threads: 6 });
  });

  it('takes a request that names Korean and at most English', () => {
    expect(koreanOnnxLanguages(['kor'])).toBe(true);
    expect(koreanOnnxLanguages(['kor', 'eng'])).toBe(true);
    expect(koreanOnnxLanguages(['eng', 'kor'])).toBe(true);
    expect(koreanOnnxLanguages(['eng'])).toBe(false);
    expect(koreanOnnxLanguages(['kor', 'jpn'])).toBe(false);
    expect(koreanOnnxLanguages(['kor', 'deu'])).toBe(false);
  });

  it('says why it is unavailable: switched off, models missing', () => {
    const before = { off: process.env[ONNX_OCR_SWITCH_ENV], dir: process.env[ONNX_OCR_MODEL_DIR_ENV] };
    try {
      process.env[ONNX_OCR_SWITCH_ENV] = 'off';
      expect(onnxOcrUnavailableReason()?.reason).toBe('switched-off');
      delete process.env[ONNX_OCR_SWITCH_ENV];
      process.env[ONNX_OCR_MODEL_DIR_ENV] = '/nonexistent-ocr-onnx';
      expect(onnxOcrUnavailableReason()?.reason).toBe('models-missing');
    } finally {
      for (const [key, value] of [[ONNX_OCR_SWITCH_ENV, before.off], [ONNX_OCR_MODEL_DIR_ENV, before.dir]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('the helper pool, with a stand-in helper program', () => {
  it('reads pages with one helper, which it keeps for the next page', async () => {
    const pool = makePool('ok');
    const first = await pool.read(page(), { language: 'kor' });
    const second = await pool.read(page(), { language: 'kor+eng' });
    expect(pool.size).toBe(1);
    expect(first.text).toMatch(/^p([0-9a-f]+)n1$/);
    // the same process served both pages: the page count rose, the process id did not change
    expect(second.text.replace(/n2$/, 'n1')).toBe(first.text);
    expect(second.language).toBe('kor+eng');
  });

  it('replaces a helper that has read its share of pages', async () => {
    const pool = makePool('ok', { maxPagesPerHelper: 2 });
    const texts = [];
    for (let i = 0; i < 3; i++) texts.push((await pool.read(page(), { language: 'kor' })).text);
    expect(texts[1]).toMatch(/n2$/);
    expect(texts[2]).toMatch(/n1$/);
    expect(texts[2].split('n')[0]).not.toBe(texts[0].split('n')[0]);
  });

  it('reads two pages at a time with two helpers and queues the third', async () => {
    const pool = makePool('ok', { plan: { helpers: 2, threads: 1 } });
    const results = await Promise.all([1, 2, 3].map(() => pool.read(page(), { language: 'kor' })));
    expect(results).toHaveLength(3);
    expect(pool.size).toBeLessThanOrEqual(2);
  });

  it('reports a helper that dies on a page as a failure of that page, and starts another for the next', async () => {
    const pool = makePool('crash');
    await expect(pool.read(page(), { language: 'kor' })).rejects.toMatchObject({ name: 'OnnxOcrFailedError', reason: 'helper-lost' });
    expect(pool.size).toBe(0);
  });

  it('refuses a page that the helper reports as failed', async () => {
    const pool = makePool('error');
    await expect(pool.read(page(), { language: 'kor' })).rejects.toMatchObject({ name: 'OnnxOcrFailedError', reason: 'rejected' });
  });

  it('does not trust a reply with a confidence outside 0..1', async () => {
    const pool = makePool('bad-confidence');
    await expect(pool.read(page(), { language: 'kor' })).rejects.toMatchObject({ name: 'OnnxOcrFailedError', reason: 'rejected' });
  });

  it.each(['null-header', 'number-header', 'string-header', 'array-header', 'no-type-header', 'bad-id-header'])(
    'ends a helper that answers with a header that is not a reply (%s) as a lost helper, without an uncaught error',
    async (mode) => {
      const pool = makePool(mode);
      await expect(pool.read(page(), { language: 'kor' })).rejects.toMatchObject({ name: 'OnnxOcrFailedError', reason: 'helper-lost' });
      expect(pool.size).toBe(0);
    }
  );

  it('ends a helper whose first frame is not a ready frame, and calls the engine unavailable', async () => {
    const pool = makePool('boot-null');
    await expect(pool.read(page(), { language: 'kor' })).rejects.toMatchObject({ name: 'OnnxOcrUnavailableError', reason: 'helper-not-starting' });
    expect(pool.size).toBe(0);
  });

  it('cuts the message of a helper error to 300 characters, whatever it sends', async () => {
    const pool = makePool('huge-message');
    const error = await pool.read(page(), { language: 'kor' }).catch((e: Error) => e);
    expect(error).toMatchObject({ name: 'OnnxOcrUnavailableError' });
    expect((error as Error).message.length).toBeLessThan(400);
    expect((error as Error).message).toContain('xxxxxxxx');
  });

  it('ends a helper whose error message is not text', async () => {
    const pool = makePool('non-string-message');
    await expect(pool.read(page(), { language: 'kor' })).rejects.toMatchObject({ name: 'OnnxOcrFailedError', reason: 'helper-lost' });
    expect(pool.size).toBe(0);
  });

  it('puts the first bytes of the helper\'s standard error into the message of a helper that does not start', async () => {
    const pool = makePool('boot-stderr');
    const error = await pool.read(page(), { language: 'kor' }).catch((e: Error) => e);
    expect(error).toMatchObject({ name: 'OnnxOcrUnavailableError', reason: 'helper-not-starting' });
    expect((error as Error).message).toContain('mbind: Operation not permitted (seccomp)');
    expect((error as Error).message.length).toBeLessThan(500);
  });

  it('stops waiting for a helper that is still starting when the job is aborted', async () => {
    const pool = makePool('slow-boot');
    const controller = new AbortController();
    const reading = pool.read(page(), { language: 'kor', signal: controller.signal });
    setTimeout(() => controller.abort(new Error('the job was cancelled while the helper started')), 100);
    // the helper needs 1.5 s to start: the read ends with the abort long before that
    const outcome = await Promise.race([reading.catch((e: Error) => e.message), new Promise((resolve) => setTimeout(() => resolve('still waiting'), 1000))]);
    expect(outcome).toBe('the job was cancelled while the helper started');
    // the helper goes on booting and serves the next page
    const next = await pool.read(page(), { language: 'kor' });
    expect(next.text).toMatch(/^p[0-9a-f]+n1$/);
    expect(pool.size).toBe(1);
  });

  it('kills a helper that does not answer within the time limit', async () => {
    const pool = makePool('hang', { pageTimeoutMs: 300 });
    await expect(pool.read(page(), { language: 'kor' })).rejects.toMatchObject({ reason: 'timeout' });
    expect(pool.size).toBe(0);
  });

  it('stops at the abort of the job with the job\'s own reason', async () => {
    const pool = makePool('hang', { pageTimeoutMs: 10_000 });
    const controller = new AbortController();
    const reading = pool.read(page(), { language: 'kor', signal: controller.signal });
    // Abort once the page is sent, not while the helper starts: an abort before the page leaves the helper for the next page.
    await vi.waitFor(() => expect(pool.size).toBe(1));
    const [helper] = (pool as unknown as { helpers: Set<{ waiting: unknown }> }).helpers;
    await vi.waitFor(() => expect(helper.waiting).not.toBeNull(), { timeout: 10_000 });
    controller.abort(new Error('the job was cancelled'));
    await expect(reading).rejects.toThrow('the job was cancelled');
    await vi.waitFor(() => expect(pool.size).toBe(0));
  });

  it('does not start when the signal is already aborted', async () => {
    const pool = makePool('ok');
    const controller = new AbortController();
    controller.abort(new Error('already over'));
    await expect(pool.read(page(), { language: 'kor', signal: controller.signal })).rejects.toThrow('already over');
    expect(pool.size).toBe(0);
  });

  it('says the engine is unavailable when the helper does not boot, and does not try again at once', async () => {
    const pool = makePool('boot-fail');
    await expect(pool.read(page(), { language: 'kor' })).rejects.toMatchObject({ name: 'OnnxOcrUnavailableError', reason: 'helper-not-starting' });
    const again = pool.read(page(), { language: 'kor' });
    await expect(again).rejects.toBeInstanceOf(OnnxOcrUnavailableError);
    await expect(again).rejects.toThrow(/not tried again/);
  });
});
