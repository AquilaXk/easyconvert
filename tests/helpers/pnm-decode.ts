/**
 * A strict Netpbm reader for tests (P4, P5 and P6, 8-bit samples), written from the format
 * descriptions and sharing no code with the writer under test. Its own correctness is checked
 * against ImageMagick in tests/ocr-pnm-pages.test.ts.
 */

export interface DecodedPnm {
  format: 'P4' | 'P5' | 'P6';
  width: number;
  height: number;
  /** One byte per sample, row-major; P4 rows are unpacked to 0 (ink) and 255 (paper). */
  samples: Uint8Array;
  /** Samples per pixel: 1 for P4 and P5, 3 for P6. */
  channels: 1 | 3;
  /** Bytes of header before the first sample. */
  headerBytes: number;
}

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);
const COMMENT_START = 0x23;
const MAX_SAMPLE_VALUE = 255;

function isDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

export function decodePnm(bytes: Uint8Array): DecodedPnm {
  const format = String.fromCharCode(bytes[0], bytes[1]);
  if (format !== 'P4' && format !== 'P5' && format !== 'P6') throw new Error(`Not a supported PNM: ${format}`);
  let at = 2;
  const nextInteger = (): number => {
    while (at < bytes.length && (WHITESPACE.has(bytes[at]) || bytes[at] === COMMENT_START)) {
      if (bytes[at] === COMMENT_START) while (at < bytes.length && bytes[at] !== 0x0a) at++;
      else at++;
    }
    const start = at;
    while (at < bytes.length && isDigit(bytes[at])) at++;
    if (start === at) throw new Error('PNM header: integer expected');
    return Number(Buffer.from(bytes.subarray(start, at)).toString('ascii'));
  };
  const width = nextInteger();
  const height = nextInteger();
  if (format !== 'P4') {
    const maxValue = nextInteger();
    if (maxValue !== MAX_SAMPLE_VALUE) throw new Error(`PNM maxval ${maxValue} is not 255`);
  }
  // Exactly one whitespace byte separates the header from the samples.
  if (!WHITESPACE.has(bytes[at])) throw new Error('PNM header: whitespace expected before the samples');
  const headerBytes = at + 1;
  const body = bytes.subarray(headerBytes);
  if (format === 'P4') {
    const rowBytes = Math.ceil(width / 8);
    if (body.length !== rowBytes * height) throw new Error(`P4 body is ${body.length} bytes, expected ${rowBytes * height}`);
    const samples = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (body[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        samples[y * width + x] = bit === 1 ? 0 : MAX_SAMPLE_VALUE;
      }
    }
    return { format, width, height, samples, channels: 1, headerBytes };
  }
  const channels = format === 'P5' ? 1 : 3;
  if (body.length !== width * height * channels) {
    throw new Error(`${format} body is ${body.length} bytes, expected ${width * height * channels}`);
  }
  return { format, width, height, samples: new Uint8Array(body), channels, headerBytes };
}

/** The gray level of every pixel: P4 and P5 as they are, P6 by the Rec. 601 luma. */
export function pnmGray(image: DecodedPnm): Uint8Array {
  if (image.channels === 1) return image.samples;
  const gray = new Uint8Array(image.width * image.height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(
      0.299 * image.samples[i * 3] + 0.587 * image.samples[i * 3 + 1] + 0.114 * image.samples[i * 3 + 2]
    );
  }
  return gray;
}
