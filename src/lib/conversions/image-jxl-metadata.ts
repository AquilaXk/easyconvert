import { ConversionFailedError } from '../types';
import { JXL_CODESTREAM_SIGNATURE } from '../format-signatures';
import { BitReader, codestreamHead, containerBoxTypes, readSizeHeader, type U32Choice } from './image-jxl-header';

/**
 * The ImageMetadata of a JPEG XL codestream, read far enough to say whether the decoded picture can be taken from the decoder as raw
 * samples (see image-jxl-raw.ts) and which header the answer holds for.
 *
 * The field layout follows the reference implementation (libjxl, github.com/libjxl/libjxl, tag v0.11.1 = commit 794a5dcf0d54, BSD-3-Clause: `lib/jxl/image_metadata.cc`,
 * `color_encoding_internal.cc`, `fields.cc`), which is ISO/IEC 18181-1 section 11 as it is coded: every field below is read in the
 * order and with the distribution that code gives it. Only the plain pictures are described: an RGB picture of 8 or 16 bits with no
 * alpha channel or one straight alpha channel of the same depth, coded with an enumerated colour encoding, still, without a preview or
 * an intrinsic size and with no extension. Everything else (grey, an ICC profile, float samples, an animation, spot colours, depth of 10
 * or 12 bits) is not described, and the decoder is run the way it always was.
 */

export interface RawDecodable {
  /** The bits of the ImageMetadata, from its first bit to its last: headers with the same bits describe the same colours, depth and channels. */
  metadataBits: string;
  bitsPerSample: 8 | 16;
  alpha: boolean;
}

/** The only boxes of a container that carry no metadata of their own (signature, file type, level, codestream, codestream index). */
const PLAIN_BOX_TYPES: ReadonlySet<string> = new Set(['JXL ', 'ftyp', 'jxll', 'jxlc', 'jxlp', 'jxli']);
/** The codestream bytes the metadata of a plain picture fits in; a longer one is not read. */
const HEAD_BYTES = 256;

/** Enum: U32(Val(0), Val(1), BitsOffset(4, 2), BitsOffset(6, 18)). */
const ENUM: readonly [U32Choice, U32Choice, U32Choice, U32Choice] = [0, 1, { bits: 4, offset: 2 }, { bits: 6, offset: 18 }];
const BIT_DEPTH_SAMPLES: readonly [U32Choice, U32Choice, U32Choice, U32Choice] = [8, 10, 12, { bits: 6, offset: 1 }];
const EXTRA_CHANNEL_COUNT: readonly [U32Choice, U32Choice, U32Choice, U32Choice] = [0, 1, { bits: 4, offset: 2 }, { bits: 12, offset: 1 }];
const DIM_SHIFT: readonly [U32Choice, U32Choice, U32Choice, U32Choice] = [0, 3, 4, { bits: 3, offset: 1 }];
const NAME_LENGTH: readonly [U32Choice, U32Choice, U32Choice, U32Choice] = [0, { bits: 4, offset: 0 }, { bits: 5, offset: 16 }, { bits: 10, offset: 48 }];
/** Customxy: two coordinates, each U32(Bits(19), BitsOffset(19, 524288), BitsOffset(20, 1048576), BitsOffset(21, 2097152)). */
const CUSTOM_XY: readonly [U32Choice, U32Choice, U32Choice, U32Choice] = [{ bits: 19, offset: 0 }, { bits: 19, offset: 524288 }, { bits: 20, offset: 1048576 }, { bits: 21, offset: 2097152 }];

const ORIENTATION_BITS = 3;
const GAMMA_BITS = 24;
const EXTENSION_SELECTOR_BITS = 2;
const F16_BITS = 16;
const SUPPORTED_SAMPLE_BITS: ReadonlySet<number> = new Set([8, 16]);
const COLOUR_SPACE_RGB = 0;
const EXTRA_CHANNEL_ALPHA = 0;
/** The enumerated value that says a white point or the primaries are given as coordinates. */
const CUSTOM = 2;

interface Depth {
  float: boolean;
  samples: number;
}

/** BitDepth: floating_point_sample, then bits_per_sample (a float adds its exponent bits, which a plain picture does not have). */
function readBitDepth(bits: BitReader): Depth {
  const float = bits.bool();
  return { float, samples: float ? 0 : bits.u32(BIT_DEPTH_SAMPLES) };
}

/** The alpha channel the one ExtraChannelInfo describes, as its bit depth; null for anything else (a spot colour, a depth map, an associated alpha, a reduced size). */
function readAlphaChannel(bits: BitReader): Depth | null {
  if (bits.bool()) return { float: false, samples: 8 };
  if (bits.u32(ENUM) !== EXTRA_CHANNEL_ALPHA) return null;
  const depth = readBitDepth(bits);
  if (bits.u32(DIM_SHIFT) !== 0) return null;
  bits.read(bits.u32(NAME_LENGTH) * 8);
  return bits.bool() ? null : depth;
}

/** `points` Customxy fields: an x and a y each. */
function skipCoordinates(bits: BitReader, points: number): void {
  for (let coordinate = 0; coordinate < points * 2; coordinate += 1) bits.u32(CUSTOM_XY);
}

/** ColorEncoding: true for a picture in RGB with an enumerated encoding, false for any other colour space or one that comes as an ICC profile. */
function readsRgbEncoding(bits: BitReader): boolean {
  if (bits.bool()) return true;
  const wantsIcc = bits.bool();
  const colourSpace = bits.u32(ENUM);
  if (wantsIcc || colourSpace !== COLOUR_SPACE_RGB) return false;
  if (bits.u32(ENUM) === CUSTOM) skipCoordinates(bits, 1);
  if (bits.u32(ENUM) === CUSTOM) skipCoordinates(bits, 3);
  if (bits.bool()) bits.read(GAMMA_BITS);
  else bits.u32(ENUM);
  bits.u32(ENUM);
  return true;
}

/** ToneMapping: all_default, else intensity_target, min_nits, relative_to_max_display and linear_below. */
function skipToneMapping(bits: BitReader): void {
  if (bits.bool()) return;
  bits.read(F16_BITS);
  bits.read(F16_BITS);
  bits.bool();
  bits.read(F16_BITS);
}

/** The ImageMetadata at the reader's position, or null for a picture this module does not describe. */
function readMetadata(bits: BitReader): { depth: Depth; alpha: boolean } | null {
  if (bits.bool()) return { depth: { float: false, samples: 8 }, alpha: false };
  const extraFields = bits.bool();
  if (extraFields) {
    bits.read(ORIENTATION_BITS);
    const hasIntrinsicSize = bits.bool();
    if (hasIntrinsicSize) return null;
    const hasPreview = bits.bool();
    const hasAnimation = bits.bool();
    if (hasPreview || hasAnimation) return null;
  }
  const depth = readBitDepth(bits);
  bits.bool();
  const extraChannels = bits.u32(EXTRA_CHANNEL_COUNT);
  if (extraChannels > 1) return null;
  const alphaDepth = extraChannels === 1 ? readAlphaChannel(bits) : null;
  if (extraChannels === 1 && alphaDepth === null) return null;
  bits.bool();
  if (!readsRgbEncoding(bits)) return null;
  if (extraFields) skipToneMapping(bits);
  // The extension mask (a U64): zero when there is no extension; any other selector names extensions, which are not read.
  if (bits.read(EXTENSION_SELECTOR_BITS) !== 0) return null;
  if (alphaDepth !== null && (alphaDepth.float || alphaDepth.samples !== depth.samples)) return null;
  return { depth, alpha: alphaDepth !== null };
}

/**
 * What the headers of `file` say about it, or null when it is not a plain picture (see the module comment), when the container holds a
 * box besides the codestream (Exif, XMP, JUMBF and compressed boxes all end up in the PNG the decoder writes, and the headers cannot say
 * how), or when the header cannot be read.
 */
export function rawDecodableMetadata(file: Buffer): RawDecodable | null {
  const boxes = containerBoxTypes(file);
  if (boxes === null || !boxes.every((type) => PLAIN_BOX_TYPES.has(type))) return null;
  const head = codestreamHead(file, HEAD_BYTES);
  if (head === null) return null;
  const bits = new BitReader(head.subarray(JXL_CODESTREAM_SIGNATURE.length, HEAD_BYTES));
  try {
    readSizeHeader(bits);
    const start = bits.bitPosition;
    const metadata = readMetadata(bits);
    if (metadata === null || metadata.depth.float || !SUPPORTED_SAMPLE_BITS.has(metadata.depth.samples)) return null;
    return { metadataBits: bits.bitsSince(start), bitsPerSample: metadata.depth.samples as 8 | 16, alpha: metadata.alpha };
  } catch (err) {
    if (err instanceof ConversionFailedError) return null;
    throw err;
  }
}
