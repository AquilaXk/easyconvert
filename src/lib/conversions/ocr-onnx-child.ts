import { OcrEngineUnavailableError } from '../types';
import { recognizeOnnxInput, warmOnnxOcr } from './ocr-onnx';
import { encodeFrame, FrameReader, validateRunRequest, type OnnxReply, type OnnxRunRequest } from './ocr-onnx-protocol';

/**
 * The ONNX OCR helper process (ocr-onnx-helper.ts starts it): it loads the detector and the recognizer once, says it is ready, and
 * then reads one page at a time, as raw pixels, from its standard input and answers with the page's lines on its standard output.
 * It never sees an encoded image (the host decodes it), opens no network connection, and writes no file; it is started with its own
 * namespaces and limits by the host. It ends when its input closes.
 *
 * Arguments: `--models=<directory>` and `--threads=<count>`.
 */

const MAX_REPORTED_MESSAGE_CHARS = 300;

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const modelDir = option('models');
const threads = Number(option('threads'));

function send(reply: OnnxReply): void {
  process.stdout.cork();
  for (const part of encodeFrame(reply)) process.stdout.write(part);
  process.stdout.uncork();
}

function reportable(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, MAX_REPORTED_MESSAGE_CHARS) || 'unknown error';
}

async function run(request: OnnxRunRequest, payload: Buffer): Promise<void> {
  const invalid = validateRunRequest(request, payload.length);
  if (invalid) {
    send({ type: 'error', id: Number.isInteger(request?.id) ? request.id : 0, kind: 'failed', message: invalid });
    return;
  }
  const pagePixels = 3 * request.width * request.height;
  try {
    const result = await recognizeOnnxInput(
      {
        width: request.width,
        height: request.height,
        rgb: payload.subarray(0, pagePixels),
        detector: { width: request.detector.width, height: request.detector.height, rgb: payload.subarray(pagePixels) },
      },
      { modelDir, threads, language: request.language, recoverSpaces: request.recoverSpaces }
    );
    send({ type: 'result', id: request.id, result });
  } catch (error) {
    send({ type: 'error', id: request.id, kind: error instanceof OcrEngineUnavailableError ? 'unavailable' : 'failed', message: reportable(error) });
  }
}

async function main(): Promise<void> {
  if (!modelDir || !Number.isInteger(threads) || threads < 1) process.exit(2);
  await warmOnnxOcr(modelDir, threads);
  const reader = new FrameReader<OnnxRunRequest>();
  // One page at a time: a request that arrives while a page is being read waits for it.
  let queue: Promise<void> = Promise.resolve();
  process.stdin.on('data', (chunk: Buffer) => {
    try {
      for (const frame of reader.push(chunk)) queue = queue.then(() => run(frame.header, frame.payload));
    } catch {
      process.exit(1);
    }
  });
  process.stdin.on('end', () => process.exit(0));
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => process.exit(0));
  send({ type: 'ready' });
}

process.on('uncaughtException', () => process.exit(1));
process.on('unhandledRejection', () => process.exit(1));
main().catch(() => process.exit(3));
