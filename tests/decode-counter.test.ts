import { describe, expect, it } from 'vitest';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { installDecodeCounter } from './helpers/decode-counter';

const counter = installDecodeCounter();
const PAYLOAD = Buffer.alloc(3 * 1024 * 1024 + 17, 0x61);

/** Bytes the counter gains while `run` decodes. */
async function decodedBy(run: () => Promise<unknown> | unknown): Promise<number> {
  const before = counter.bytes();
  await run();
  return counter.bytes() - before;
}

async function drain(stream: NodeJS.ReadableStream): Promise<void> {
  stream.on('data', () => undefined);
  await new Promise<void>((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}

describe('the decode counter sees every inflater the bomb readers use', () => {
  it('counts nothing for work that does not inflate', async () => {
    expect(await decodedBy(() => zlib.deflateRawSync(PAYLOAD))).toBe(0);
  });

  it.each([
    ['inflateSync', () => zlib.inflateSync(zlib.deflateSync(PAYLOAD))],
    ['inflateRawSync', () => zlib.inflateRawSync(zlib.deflateRawSync(PAYLOAD))],
    ['gunzipSync', () => zlib.gunzipSync(zlib.gzipSync(PAYLOAD))],
    ['unzipSync', () => zlib.unzipSync(zlib.gzipSync(PAYLOAD))],
    ['brotliDecompressSync', () => zlib.brotliDecompressSync(zlib.brotliCompressSync(PAYLOAD))],
    ['promisified inflateRaw', () => promisify(zlib.inflateRaw)(zlib.deflateRawSync(PAYLOAD))],
    ['promisified gunzip', () => promisify(zlib.gunzip)(zlib.gzipSync(PAYLOAD))],
  ])('counts the output of %s exactly', async (_name, run) => {
    expect(await decodedBy(run)).toBe(PAYLOAD.length);
  });

  it.each([
    ['createGunzip', () => zlib.createGunzip(), () => zlib.gzipSync(PAYLOAD)],
    ['createInflateRaw', () => zlib.createInflateRaw(), () => zlib.deflateRawSync(PAYLOAD)],
    ['createInflate', () => zlib.createInflate(), () => zlib.deflateSync(PAYLOAD)],
    ['createBrotliDecompress', () => zlib.createBrotliDecompress(), () => zlib.brotliCompressSync(PAYLOAD)],
  ])('counts the output of a %s stream exactly', async (_name, createStream, compress) => {
    const stream = createStream();
    stream.end(compress());
    expect(await decodedBy(() => drain(stream))).toBe(PAYLOAD.length);
  });

  it('counts the bytes JSZip inflates for an entry, and none for an entry it only lists', async () => {
    const archive = await new JSZip().file('a.bin', PAYLOAD).generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const zip = await JSZip.loadAsync(archive);
    expect(await decodedBy(() => Object.keys(zip.files))).toBe(0);
    expect(await decodedBy(() => zip.file('a.bin')!.async('nodebuffer'))).toBe(PAYLOAD.length);
    expect(await decodedBy(() => drain(zip.file('a.bin')!.nodeStream('nodebuffer')))).toBe(PAYLOAD.length);
  });
});
