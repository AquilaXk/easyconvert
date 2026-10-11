import { fetchImage, overrideImageFetchEnvironment } from './html-image-fetch-core';
import { ImageFetchRefusal, type ImageFetchReply, type ImageFetchRequest, type ImageFetchTestRules } from './html-image-types';
import { isPublicAddress } from './public-address';

/**
 * The fetcher child process: reads one request (JSON) on stdin, fetches the image with the guards of
 * html-image-fetch-core.ts, and writes one JSON line on stdout, followed by the image bytes on success. It is started
 * by html-image-fetch.ts with a stripped environment and its own resource limits, so the worker process holds no code
 * path that connects to a host named by a document.
 */

const DEFAULT_PORTS: ReadonlySet<number> = new Set([80, 443]);
const FALLBACK_REASON = 'the image could not be loaded';

function applyTestRules(rules: ImageFetchTestRules): void {
  const hosts = rules.hosts;
  const permitted = new Set(rules.permitAddresses ?? []);
  overrideImageFetchEnvironment({
    ...(hosts
      ? {
          resolve: async (hostname) => {
            const answer = hosts[hostname];
            if (!answer) throw new Error(`no such host ${hostname}`);
            return answer;
          },
        }
      : {}),
    permitAddress: (address) => permitted.has(address) || isPublicAddress(address),
    permitPort: (port) => rules.anyPort === true || DEFAULT_PORTS.has(port),
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function write(reply: ImageFetchReply, bytes?: Buffer): Promise<void> {
  const frame = bytes ? Buffer.concat([Buffer.from(`${JSON.stringify(reply)}\n`), bytes]) : Buffer.from(`${JSON.stringify(reply)}\n`);
  return new Promise((resolve) => {
    process.stdout.write(frame, () => resolve());
  });
}

async function main(): Promise<void> {
  try {
    const request = JSON.parse(await readStdin()) as ImageFetchRequest;
    if (request.testRules) applyTestRules(request.testRules);
    const image = await fetchImage(request.url, {
      maxBytes: request.maxBytes,
      tooLargeReason: request.tooLargeReason,
      timeoutMs: request.timeoutMs,
      maxRedirects: request.maxRedirects,
    });
    await write({ ok: true, mime: image.mime }, image.bytes);
  } catch (error) {
    await write({ ok: false, reason: error instanceof ImageFetchRefusal ? error.message : FALLBACK_REASON });
  }
}

void main();
