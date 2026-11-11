import path from 'node:path';
import { JXL_CODESTREAM_SIGNATURE, JXL_CONTAINER_SIGNATURE, startsWithBytes } from '../format-signatures';
import { executeSandboxedBinary } from '../security/process-sandbox';
import { ConversionFailedError } from '../types';
import {
  DECODER_MAX_DIAGNOSTIC_BYTES,
  DECODER_MEMORY_LIMIT_MB,
  DECODER_OUTPUT_NAME,
  DECODER_TIMEOUT_MS,
  decoderUnavailable,
  describeDecoderFailure,
  findDecoderTool,
  readDecodedFile,
  withDecoderJob,
} from './image-decoder-tools';
import { withExifChunk } from './image-jxl-exif';
import { assertInputPixels } from './image-input-limits';
import { MAX_DECODED_ANIMATION_BYTES } from './image-limits';

/**
 * JPEG XL pictures (ISO/IEC 18181), a bare codestream or a file in the ISO base media container, decoded by libjxl's `djxl` and
 * handed on as a lossless PNG, or as an APNG when the picture is an animation (the image pipeline then keeps the first frame for a
 * still target and every frame for GIF and WebP). `djxl` is run as an unmodified separate program under the process sandbox with no
 * network, on a file in a private directory. It turns the pixels by the orientation of the codestream header, writes the colour
 * profile into the PNG (an ICC profile, or the sRGB, gamma and chromaticity chunks), and writes more than 8 bits per sample as 16.
 * The size is read from the header before the decoder starts, so a small file that declares a huge picture is refused unread.
 */

/** Environment variable that names the executable; a value is authoritative, so a path that is not an executable file means "not installed". */
export const DJXL_PATH_ENV = 'DJXL_PATH';
const DJXL_EXECUTABLE_NAMES = ['djxl'] as const;
const JXL_LABEL = 'JPEG XL';
const DJXL_THREADS = '--num_threads=2';
/** The decoder takes the kind of file from the bytes; the output format from the name. */
const INPUT_FILE = 'in.jxl';

const BOX_HEADER_BYTES = 8;
const BOX_LARGE_HEADER_BYTES = 16;
const BOX_LENGTH_LARGE = 1;
const BOX_LENGTH_TO_END = 0;
const CODESTREAM_BOX_TYPE = 'jxlc';
const PARTIAL_CODESTREAM_BOX_TYPE = 'jxlp';
/** A partial codestream box starts with a 32-bit index, whose top bit marks the last box. */
const PARTIAL_INDEX_BYTES = 4;

/** The SizeHeader is at most 68 bits: `small`, a 2-bit selector and 30 bits twice, and the 3-bit ratio. */
const SIZE_HEADER_BYTES = 9;
const HEADER_BYTES_READ = JXL_CODESTREAM_SIGNATURE.length + SIZE_HEADER_BYTES;
/** `small` pictures state their sides in multiples of 8 (5 bits each); the others in one of four fields after a 2-bit selector. */
const SMALL_SIDE_BITS = 5;
const SMALL_SIDE_STEP = 8;
const SIDE_SELECTOR_BITS = 2;
const SIDE_FIELD_BITS: readonly number[] = [9, 13, 18, 30];
const RATIO_BITS = 3;
/** The aspect ratios a header can name instead of the width (18181-1): width = height * numerator / denominator. */
const ASPECT_RATIOS: readonly (readonly [number, number])[] = [[1, 1], [12, 10], [4, 3], [3, 2], [16, 9], [5, 4], [2, 1]];

/** Largest sample of the PNG the decoder writes is 16 bits of four channels. */
const OUTPUT_BYTES_PER_PIXEL = 8;
const OUTPUT_OVERHEAD_BYTES = 64 * 1024;

const headerError = (): ConversionFailedError => new ConversionFailedError(`Invalid image: the ${JXL_LABEL} header could not be decoded`);

/** Reads fields of a bit string, least significant bit first; a read past its end is a header that cannot be decoded. */
class BitReader {
  private position = 0;

  constructor(private readonly bytes: Uint8Array) {}

  read(count: number): number {
    if (this.position + count > this.bytes.length * 8) throw headerError();
    let value = 0;
    for (let i = 0; i < count; i += 1, this.position += 1) {
      value += ((this.bytes[this.position >> 3] >> (this.position & 7)) & 1) * 2 ** i;
    }
    return value;
  }

  /** U32(BitsOffset(9, 1), BitsOffset(13, 1), BitsOffset(18, 1), BitsOffset(30, 1)): the side less 1, in the field a 2-bit selector names. */
  side(): number {
    return this.read(SIDE_FIELD_BITS[this.read(SIDE_SELECTOR_BITS)]) + 1;
  }
}

/** Where a box ends: its length field, the 64-bit length that follows a 1, or the end of the file for a 0. */
function boxEnd(file: Buffer, offset: number): number {
  const length = file.readUInt32BE(offset);
  if (length === BOX_LENGTH_LARGE) return offset + Number(file.readBigUInt64BE(offset + BOX_HEADER_BYTES));
  return length === BOX_LENGTH_TO_END ? file.length : offset + length;
}

/** The first bytes of the codestream of a container: the contents of its `jxlc` box, or of its `jxlp` boxes in order; null when there is none. */
function containerHead(file: Buffer): Buffer | null {
  const parts: Buffer[] = [];
  let have = 0;
  let offset = JXL_CONTAINER_SIGNATURE.length;
  while (offset + BOX_HEADER_BYTES <= file.length && have < HEADER_BYTES_READ) {
    const type = file.toString('latin1', offset + 4, offset + 8);
    const header = file.readUInt32BE(offset) === BOX_LENGTH_LARGE ? BOX_LARGE_HEADER_BYTES : BOX_HEADER_BYTES;
    if (offset + header > file.length) return null;
    const end = boxEnd(file, offset);
    // A length that cannot hold its own header is no box: no codestream follows.
    if (end < offset + header) return null;
    const content = file.subarray(offset + header, Math.min(end, file.length));
    if (type === CODESTREAM_BOX_TYPE || type === PARTIAL_CODESTREAM_BOX_TYPE) {
      const bytes = type === CODESTREAM_BOX_TYPE ? content : content.subarray(PARTIAL_INDEX_BYTES);
      parts.push(bytes);
      have += bytes.length;
      if (type === CODESTREAM_BOX_TYPE) break;
    }
    offset = end;
  }
  return parts.length === 0 ? null : Buffer.concat(parts);
}

/** The first bytes of the codestream of a file, or null when the bytes are neither a bare codestream nor a container that holds one. */
function codestreamHead(file: Buffer): Buffer | null {
  const head = startsWithBytes(file, JXL_CONTAINER_SIGNATURE) ? containerHead(file) : file;
  return head !== null && startsWithBytes(head, JXL_CODESTREAM_SIGNATURE) ? head : null;
}

/**
 * Width and height the SizeHeader of a JPEG XL picture states, read without decoding anything. The picture
 * `djxl` writes has the sides swapped when the header's orientation is a quarter turn, which changes neither the pixel count nor the limit.
 */
export function declaredJxlSize(file: Buffer): { width: number; height: number } {
  const head = codestreamHead(file);
  if (head === null) throw headerError();
  const bits = new BitReader(head.subarray(JXL_CODESTREAM_SIGNATURE.length, HEADER_BYTES_READ));
  const small = bits.read(1) === 1;
  const height = small ? (bits.read(SMALL_SIDE_BITS) + 1) * SMALL_SIDE_STEP : bits.side();
  const ratio = bits.read(RATIO_BITS);
  if (ratio > 0) {
    const [numerator, denominator] = ASPECT_RATIOS[ratio - 1];
    return { width: Math.floor((height * numerator) / denominator), height };
  }
  return { width: small ? (bits.read(SMALL_SIDE_BITS) + 1) * SMALL_SIDE_STEP : bits.side(), height };
}

/** Where `djxl` is installed, or null. */
export function findDjxl(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  return findDecoderTool(DJXL_PATH_ENV, DJXL_EXECUTABLE_NAMES, env);
}

/** Decodes a JPEG XL picture to a PNG (an APNG for an animation) with `djxl`. */
export async function decodeWithDjxl(input: Buffer, signal?: AbortSignal): Promise<Buffer> {
  const djxl = findDjxl();
  if (djxl === null) throw decoderUnavailable('djxl', 'libjxl-tools');
  const { width, height } = declaredJxlSize(input);
  assertInputPixels(width, height);
  // An animation holds many frames of the declared size, which the header does not count; the bound for them is the one of any decoded animation.
  const maxOutputBytes = Math.max(width * height * OUTPUT_BYTES_PER_PIXEL + OUTPUT_OVERHEAD_BYTES, MAX_DECODED_ANIMATION_BYTES);
  const output = `${DECODER_OUTPUT_NAME}.png`;
  return withDecoderJob(input, INPUT_FILE, async (jobDir) => {
    try {
      await executeSandboxedBinary(djxl, [INPUT_FILE, output, DJXL_THREADS, '--quiet'], {
        cwd: jobDir,
        workDir: jobDir,
        timeoutMs: DECODER_TIMEOUT_MS,
        maxBuffer: DECODER_MAX_DIAGNOSTIC_BYTES,
        maxFileSize: maxOutputBytes,
        memoryLimitMb: DECODER_MEMORY_LIMIT_MB,
        networkIsolated: true,
        signal,
      });
    } catch (err) {
      throw describeDecoderFailure(err, 'djxl', JXL_LABEL, DECODER_TIMEOUT_MS);
    }
    return withExifChunk(await readDecodedFile(path.join(jobDir, output), maxOutputBytes, JXL_LABEL));
  });
}
