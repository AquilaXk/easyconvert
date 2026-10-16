import type { Metadata } from 'sharp';
import type { ConversionOptions } from '../types';
import { rethrowSandboxUnavailable } from '../security/process-sandbox';
import { AvifEncoderFailedError, type AvifCliRequest, type AvifCliRun, findAvifenc, startAvifWithCli } from './avif-cli';
import type { ContentClass } from './image-content';
import { SHARP_SIXTEEN_BIT_DEPTH } from './image-depth';
import { AVIF_CLI_MAX_PIXELS, avifPolicyFor, avifSourceBitsOf, type AvifPolicy } from './image-encoder-defaults';

/**
 * A PNG that reaches the AVIF command-line encoder as the file it arrived in.
 *
 * The encoder takes every grey picture and every picture with more than 8 bits per sample whatever its content (see
 * `avifEncoderFor`); only the tuning metric depends on the content class, which is found from the decoded pixels while the
 * encoder is already running. The decoded pixels, written out again as a PNG, are the same samples the source file holds, so
 * the encoder reads the source file instead: the picture is neither re-encoded (3.4 ms for a 1024 x 640 16-bit picture, 1.2 ms
 * for 640 x 640 grey) nor written (5 MB against 58 kB), and the start of the encoder (a fork, an exec and its libraries) overlaps
 * the decode instead of following it. When the class turns out to need another tuning the run is replaced by one with the
 * policy of the class, on the same file.
 *
 * Only a file whose chunks the encoder reads as pixels and nothing else qualifies (`readsAsPixelsOnly`), so the encoder writes
 * the very file it would write for the re-encoded samples. A file the encoder cannot read is encoded from the decoded pixels
 * as before.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHUNK_HEADER_BYTES = 8;
const CHUNK_OVERHEAD_BYTES = 12;
const HEADER_DATA_BYTES = 13;
const HEADER_BIT_DEPTH_OFFSET = 8;
const HEADER_COLOUR_TYPE_OFFSET = 9;

/**
 * The chunks a file may hold: the critical ones, the sRGB rendering intent (the encoder treats the picture as sRGB with or
 * without it), the print density and time stamp, and the significant-bits record (each measured to give the same AVIF with and
 * without the chunk). Everything else changes the output: a gamma or chromaticity chunk becomes a colour tag, a profile, EXIF,
 * XMP and text blocks become metadata of the file, a transparency key becomes an alpha plane, a palette a different sample
 * path.
 */
const PIXEL_ONLY_CHUNKS: ReadonlySet<string> = new Set(['IHDR', 'IDAT', 'IEND', 'sRGB', 'pHYs', 'tIME', 'sBIT']);
/** Grey, colour, grey with alpha and colour with alpha; a palette (3) goes through the decoder's expansion. */
const SAMPLE_COLOUR_TYPES: ReadonlySet<number> = new Set([0, 2, 4, 6]);
const SAMPLE_BIT_DEPTHS: ReadonlySet<number> = new Set([8, 16]);

/** Whether the chunk list of `png` holds nothing but pixels as far as the AVIF encoder's PNG reader is concerned. */
export function readsAsPixelsOnly(png: Buffer): boolean {
  if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return false;
  let at = PNG_SIGNATURE.length;
  let first = true;
  while (at + CHUNK_HEADER_BYTES <= png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + CHUNK_HEADER_BYTES);
    if (!PIXEL_ONLY_CHUNKS.has(type) || (first && type !== 'IHDR')) return false;
    if (first) {
      if (length !== HEADER_DATA_BYTES) return false;
      const header = at + CHUNK_HEADER_BYTES;
      if (!SAMPLE_BIT_DEPTHS.has(png[header + HEADER_BIT_DEPTH_OFFSET]) || !SAMPLE_COLOUR_TYPES.has(png[header + HEADER_COLOUR_TYPE_OFFSET])) return false;
      first = false;
    }
    if (type === 'IEND') return true;
    at += CHUNK_OVERHEAD_BYTES + length;
  }
  return false;
}

/** The fields of a policy that reach the encoder's command line (both policies are the command-line encoder's). */
function samePolicy(a: AvifPolicy, b: AvifPolicy): boolean {
  return a.quality === b.quality && a.effort === b.effort && a.bitdepth === b.bitdepth && a.layout === b.layout && a.tune === b.tune;
}

function requestFor(png: Buffer, size: { width: number; height: number }, policy: AvifPolicy, options: ConversionOptions): AvifCliRequest {
  return { png, ...size, quality: policy.quality, effort: policy.effort, bitdepth: policy.bitdepth, layout: policy.layout, tune: policy.tune, signal: options.signal };
}

/** What the policy of a content class depends on besides the content and the quality. */
interface DirectAvifSource {
  avifenc: string;
  png: Buffer;
  width: number;
  height: number;
  /** Bits per sample the policy's bit depth follows. */
  sourceBits: number;
  grey: boolean;
}

/** An encoder run on the source file, started before the content class is known. */
export class DirectAvif {
  private constructor(
    private readonly source: DirectAvifSource,
    private readonly options: ConversionOptions,
    private started: AvifPolicy,
    private run: AvifCliRun
  ) {}

  private policyFor(content: ContentClass): AvifPolicy {
    const { width, height, sourceBits, grey } = this.source;
    return avifPolicyFor(this.options.quality, content, width * height, sourceBits, grey, 'library-cli');
  }

  /**
   * Starts the encoder on `png` when the picture described by `meta` is one the command-line encoder takes whatever its content,
   * the file qualifies and the options leave its pixels as they are (the caller checks that); null otherwise. The policy it starts
   * with is the one of graphic content, the class of most grey and deep pictures.
   */
  static async start(png: Buffer, meta: Metadata, options: ConversionOptions): Promise<DirectAvif | null> {
    const { width, height } = meta;
    if (width === undefined || height === undefined || width * height > AVIF_CLI_MAX_PIXELS) return null;
    const deep = meta.depth === SHARP_SIXTEEN_BIT_DEPTH;
    const grey = meta.space === 'b-w' || meta.space === 'grey16';
    if (!(deep || grey) || !readsAsPixelsOnly(png)) return null;
    const avifenc = await findAvifenc();
    if (avifenc === null) return null;
    const source = { avifenc, png, width, height, grey, sourceBits: avifSourceBitsOf(deep, meta.bitsPerSample) };
    const started = avifPolicyFor(options.quality, 'graphic', width * height, source.sourceBits, grey, 'library-cli');
    return new DirectAvif(source, options, started, startAvifWithCli(avifenc, requestFor(png, source, started, options)));
  }

  /**
   * The AVIF for the content class: the run in progress when its policy is the class's, else a run of the class's policy on the
   * same file. Null when the encoder failed on the file, in which case the caller encodes the decoded pixels; every other failure
   * (a timeout, a memory limit, an abort) is thrown, as the run on the decoded pixels would meet it too.
   */
  async finish(content: ContentClass): Promise<Buffer | null> {
    const policy = this.policyFor(content);
    if (!samePolicy(policy, this.started)) {
      await this.run.cancel();
      this.started = policy;
      this.run = startAvifWithCli(this.source.avifenc, requestFor(this.source.png, this.source, policy, this.options));
    }
    try {
      return await this.run.result;
    } catch (err) {
      if (err instanceof AvifEncoderFailedError) return null;
      rethrowSandboxUnavailable(err);
      throw err;
    }
  }

  /** Stops the run if it is still going and removes its working directory. */
  abandon(): Promise<void> {
    return this.run.cancel();
  }
}

/** Where `convertImage` keeps the run of a conversion, so that every way out of it stops what is left. */
export class DirectAvifSlot {
  private current: DirectAvif | null = null;

  set(direct: DirectAvif | null): void {
    this.current = direct;
  }

  /**
   * The AVIF the run wrote for the content class, or null when there is no run or it could not encode the file. A run that is not
   * finished because something failed first stays in the slot, for `abandon`.
   */
  async finish(content: ContentClass | Promise<ContentClass>): Promise<Buffer | null> {
    const direct = this.current;
    if (direct === null) return null;
    const file = await direct.finish(await content);
    this.current = null;
    return file;
  }

  async abandon(): Promise<void> {
    const direct = this.current;
    this.current = null;
    await direct?.abandon();
  }
}

/**
 * The hook that starts the encoder on `source` for a plain PNG about to be decoded, or undefined when the conversion is not an AVIF
 * of the file's own pixels (`changesPixels`: a resize or a background).
 */
export function startDirectAvifOn(slot: DirectAvifSlot, fmt: string, changesPixels: boolean, source: Buffer, options: ConversionOptions): ((meta: Metadata) => Promise<void>) | undefined {
  if (fmt !== 'avif' || changesPixels) return undefined;
  return async (meta) => slot.set(await DirectAvif.start(source, meta, options));
}
