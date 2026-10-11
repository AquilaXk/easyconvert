import { fetchImage, overrideImageFetchEnvironment } from './html-image-fetch-core';
import { FRAME_PREFIX_BYTES, ImageFetchRefusal, jsonFrame, MAX_FRAME_BYTES, type ImageFetchRequest, type ImageFetchTestRules } from './html-image-types';
import { isPublicAddress } from './public-address';

/**
 * The fetcher child process: one per job, serving the images of the job one after another. It reads length-prefixed JSON
 * requests on stdin, fetches each image with the guards of html-image-fetch-core.ts, and writes a length-prefixed JSON
 * reply on stdout, followed by the image bytes on success; it ends when the worker closes stdin. It is started by
 * html-image-fetch.ts with a stripped environment and its own resource limits, so the worker process holds no code
 * path that connects to a host named by a document.
 */

const DEFAULT_PORTS: ReadonlySet<number> = new Set([80, 443]);
const FALLBACK_REASON = 'the image could not be loaded';

let restoreTestRules: (() => void) | undefined;

function applyTestRules(rules: ImageFetchTestRules): void {
  restoreTestRules?.();
  const hosts = rules.hosts;
  const permitted = new Set(rules.permitAddresses ?? []);
  restoreTestRules = overrideImageFetchEnvironment({
    ...(hosts
      ? {
          resolve: (hostname) => {
            const answer = hosts[hostname];
            return answer ? Promise.resolve(answer) : Promise.reject(new Error(`no such host ${hostname}`));
          },
        }
      : {}),
    permitAddress: (address) => permitted.has(address) || isPublicAddress(address),
    permitPort: (port) => rules.anyPort === true || DEFAULT_PORTS.has(port),
  });
}

function write(frame: Buffer): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(frame, () => resolve());
  });
}

async function answer(request: ImageFetchRequest): Promise<void> {
  try {
    if (request.testRules) applyTestRules(request.testRules);
    const image = await fetchImage(request.url, {
      maxBytes: request.maxBytes,
      tooLargeReason: request.tooLargeReason,
      timeoutMs: request.timeoutMs,
      maxRedirects: request.maxRedirects,
    });
    await write(Buffer.concat([jsonFrame({ ok: true, mime: image.mime, length: image.bytes.length }), image.bytes]));
  } catch (error) {
    await write(jsonFrame({ ok: false, reason: error instanceof ImageFetchRefusal ? error.message : FALLBACK_REASON }));
  }
}

/** Serves requests one after another until the worker closes stdin. */
async function main(): Promise<void> {
  let pending = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, chunk as Buffer]);
    while (pending.length >= FRAME_PREFIX_BYTES) {
      const length = pending.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) process.exit(1);
      if (pending.length < FRAME_PREFIX_BYTES + length) break;
      const request = JSON.parse(pending.subarray(FRAME_PREFIX_BYTES, FRAME_PREFIX_BYTES + length).toString('utf8')) as ImageFetchRequest;
      pending = pending.subarray(FRAME_PREFIX_BYTES + length);
      await answer(request);
    }
  }
}

void main();
