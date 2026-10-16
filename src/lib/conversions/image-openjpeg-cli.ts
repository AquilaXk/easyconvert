import path from 'node:path';
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
import { assertInputPixels } from './image-input-limits';

/**
 * JPEG 2000 (ITU-T T.800, ISO/IEC 15444-1) pictures, JP2 files and bare codestreams, decoded by OpenJPEG's
 * `opj_decompress` and handed on as a lossless PNG. It is run as an unmodified separate program under the process
 * sandbox with no network, on a file in a private directory. OpenJPEG takes the kind of file from the file name, so the
 * name is chosen here from the signature of the bytes, never from the name the upload had.
 */

/** Environment variable that names the executable; a value is authoritative, so a path that is not an executable file means "not installed". */
export const OPJ_DECOMPRESS_PATH_ENV = 'OPJ_DECOMPRESS_PATH';
const OPJ_EXECUTABLE_NAMES = ['opj_decompress'] as const;
const OPJ_LABEL = 'JPEG 2000';
const OPJ_THREADS = '2';

/** JP2 signature box (T.800 Annex I.5.1): length 12, type 'jP  ', content 0D 0A 87 0A. */
const JP2_SIGNATURE = Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a]);
/** A codestream opens with the SOC marker and the SIZ marker (T.800 Annex A.4). */
const CODESTREAM_START = Buffer.from([0xff, 0x4f, 0xff, 0x51]);
const CODESTREAM_BOX_TYPE = 'jp2c';
const BOX_HEADER_BYTES = 8;
const BOX_LARGE_HEADER_BYTES = 16;
const BOX_LENGTH_LARGE = 1;
/** SIZ marker segment (T.800 A.5.1): marker, Lsiz (2), Rsiz (2), then Xsiz, Ysiz, XOsiz, YOsiz as 32-bit values. */
const SIZ_FIELDS_OFFSET = CODESTREAM_START.length + 2 + 2;
const SIZ_FIELD_BYTES = 4;
const SIZ_BYTES_READ = SIZ_FIELDS_OFFSET + 4 * SIZ_FIELD_BYTES;
/** Largest sample of the PNG the decoder writes is 16 bits of four channels. */
const OUTPUT_BYTES_PER_PIXEL = 8;
const OUTPUT_OVERHEAD_BYTES = 64 * 1024;

type Jpeg2000Kind = { file: string; codestreamStart: number };

/** Offset of the codestream inside a JP2 file: the contents of its first `jp2c` box, or -1 when the file has none. */
function findCodestreamBox(buf: Buffer): number {
  let offset = JP2_SIGNATURE.length;
  while (offset + BOX_HEADER_BYTES <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const header = length === BOX_LENGTH_LARGE ? BOX_LARGE_HEADER_BYTES : BOX_HEADER_BYTES;
    if (type === CODESTREAM_BOX_TYPE) return offset + header;
    if (offset + header > buf.length) return -1;
    const size = length === BOX_LENGTH_LARGE ? Number(buf.readBigUInt64BE(offset + BOX_HEADER_BYTES)) : length;
    // A length of 0 (the box runs to the end of the file) is shorter than a header, like any other length that cannot hold one: no codestream box follows.
    if (size < header) return -1;
    offset += size;
  }
  return -1;
}

/** Which kind of file the bytes are, from the signature, or null when they are neither a JP2 file nor a codestream. */
function classify(buf: Buffer): Jpeg2000Kind | null {
  if (buf.subarray(0, CODESTREAM_START.length).equals(CODESTREAM_START)) return { file: 'in.j2k', codestreamStart: 0 };
  if (!buf.subarray(0, JP2_SIGNATURE.length).equals(JP2_SIGNATURE)) return null;
  const codestreamStart = findCodestreamBox(buf);
  return codestreamStart === -1 ? null : { file: 'in.jp2', codestreamStart };
}

/** Width and height of the picture: the reference grid less its offset (T.800 B.2), read from the SIZ segment. */
function declaredSize(buf: Buffer, codestreamStart: number): { width: number; height: number } {
  const siz = buf.subarray(codestreamStart);
  if (siz.length < SIZ_BYTES_READ || !siz.subarray(0, CODESTREAM_START.length).equals(CODESTREAM_START)) {
    throw new ConversionFailedError(`Invalid image: the ${OPJ_LABEL} header could not be decoded`);
  }
  const field = (index: number): number => siz.readUInt32BE(SIZ_FIELDS_OFFSET + index * SIZ_FIELD_BYTES);
  return { width: field(0) - field(2), height: field(1) - field(3) };
}

/** Where `opj_decompress` is installed, or null. */
export function findOpenJpeg(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  return findDecoderTool(OPJ_DECOMPRESS_PATH_ENV, OPJ_EXECUTABLE_NAMES, env);
}

/** Decodes a JPEG 2000 picture to a PNG with OpenJPEG. */
export async function decodeWithOpenJpeg(input: Buffer, signal?: AbortSignal): Promise<Buffer> {
  const opj = findOpenJpeg();
  if (opj === null) throw decoderUnavailable('opj_decompress', 'OpenJPEG tools');
  const kind = classify(input);
  if (kind === null) throw new ConversionFailedError(`Invalid image: the ${OPJ_LABEL} header could not be decoded`);
  const { width, height } = declaredSize(input, kind.codestreamStart);
  if (width <= 0 || height <= 0) throw new ConversionFailedError(`Invalid image: the ${OPJ_LABEL} header declares no picture`);
  assertInputPixels(width, height);
  const maxOutputBytes = width * height * OUTPUT_BYTES_PER_PIXEL + OUTPUT_OVERHEAD_BYTES;
  return withDecoderJob(input, kind.file, async (jobDir) => {
    try {
      await executeSandboxedBinary(opj, ['-i', kind.file, '-o', `${DECODER_OUTPUT_NAME}.png`, '-threads', OPJ_THREADS], {
        cwd: jobDir,
        timeoutMs: DECODER_TIMEOUT_MS,
        maxBuffer: DECODER_MAX_DIAGNOSTIC_BYTES,
        maxFileSize: maxOutputBytes,
        memoryLimitMb: DECODER_MEMORY_LIMIT_MB,
        networkIsolated: true,
        signal,
      });
    } catch (err) {
      throw describeDecoderFailure(err, 'opj_decompress', OPJ_LABEL, DECODER_TIMEOUT_MS);
    }
    return readDecodedFile(path.join(jobDir, `${DECODER_OUTPUT_NAME}.png`), maxOutputBytes, OPJ_LABEL);
  });
}
