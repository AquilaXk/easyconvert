import zlib from 'node:zlib';
import { DecompressionLimitError } from '../types';
import { exceedsArchiveRatio, type ArchiveExtractionLimits } from './archive-extraction-safety';

/**
 * Safely decompresses Gzip stream with real-time chunk-level threshold enforcement.
 * Eliminates upfront synchronous heap buffering to defend against gzip decompression bombs.
 */
export async function gunzipWithLimits(inputBuffer: Buffer, limits: ArchiveExtractionLimits): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let destroyed = false;

    const cleanup = () => {
      chunks.length = 0;
    };

    gunzip.on('data', (chunk: Buffer) => {
      if (destroyed) return;
      totalBytes += chunk.length;

      // 1. Guard against absolute uncompressed size bomb
      if (totalBytes > limits.MAX_UNCOMPRESSED_SIZE) {
        destroyed = true;
        cleanup();
        gunzip.destroy();
        return reject(
          new DecompressionLimitError(
            `Archive bomb detected: uncompressed size exceeds limit of ${limits.MAX_UNCOMPRESSED_SIZE} bytes (${Math.round(limits.MAX_UNCOMPRESSED_SIZE / (1024 * 1024))}MB)`
          )
        );
      }

      // 2. Guard against compression ratio bomb (evaluated beyond the shared ratio floor)
      if (exceedsArchiveRatio(totalBytes, inputBuffer.length, limits.MAX_RATIO)) {
        destroyed = true;
        cleanup();
        gunzip.destroy();
        return reject(
          new DecompressionLimitError(
            `Archive bomb detected: compression ratio exceeds ${limits.MAX_RATIO}:1 limit`
          )
        );
      }

      chunks.push(chunk);
    });

    gunzip.on('end', () => {
      if (destroyed) return;
      // Final ratio check on the whole stream (the same floor, so it cannot disagree with the running check)
      if (exceedsArchiveRatio(totalBytes, inputBuffer.length, limits.MAX_RATIO)) {
        cleanup();
        return reject(
          new DecompressionLimitError(
            `Archive bomb detected: compression ratio exceeds ${limits.MAX_RATIO}:1 limit`
          )
        );
      }
      resolve(Buffer.concat(chunks));
    });

    gunzip.on('error', (err) => {
      if (!destroyed) {
        cleanup();
        reject(err);
      }
    });

    gunzip.end(inputBuffer);
  });
}
