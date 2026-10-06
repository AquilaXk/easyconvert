/**
 * Entry of the thread that decodes Sigma X3F and Raspberry Pi RAW frames (see raw-decode-host.ts).
 * It receives the file bytes, posts back 16-bit sRGB or a serialised RawDecodeError.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { decodeBrcmRaw } from '../lib/conversions/raw-brcm';
import { decodeX3f } from '../lib/conversions/raw-x3f';
import { RawDecodeError } from '../lib/types';

interface DecodeRequest {
  format: 'x3f' | 'raw';
  bytes: Uint8Array;
}

function run(): void {
  const { format, bytes } = workerData as DecodeRequest;
  const port = parentPort;
  if (!port) return;
  try {
    const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoded = format === 'x3f' ? decodeX3f(file) : decodeBrcmRaw(file);
    port.postMessage({ ok: true, width: decoded.width, height: decoded.height, rgb16: decoded.rgb16 }, [decoded.rgb16.buffer as ArrayBuffer]);
  } catch (error) {
    if (error instanceof RawDecodeError) {
      port.postMessage({ ok: false, kind: 'raw', message: error.message, unrecognized: error.unrecognized });
    } else {
      port.postMessage({ ok: false, kind: 'other', message: error instanceof Error ? error.message : String(error) });
    }
  }
}

run();
