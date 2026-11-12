import type { Metadata, Sharp } from 'sharp';
import { hasSrgbPrimaries, isProfileDroppedByPngReader, isSrgbProfile } from './icc-srgb';
import type { FrameSelection } from './image-frames';
import { openLimitedSharp } from './image-input-limits';
import { metadataOf } from './image-metadata';
import { isMarkedForOptimiser } from './png-optimise';
import type { ConversionOptions } from '../types';

/** Density (pixels per inch) every viewer assumes for an image that does not state one; it is not worth a metadata block. */
export const DEFAULT_DENSITY_PPI = 72;

/**
 * Targets that carry the source's own EXIF block, XMP packet and ICC profile exactly as they are, the way the reference
 * service's engine writes them with its default (metadata kept): the profile is attached and the pixels are not converted through
 * it, and no block is made up; the profiles of `keepSourceBlocks` are the exceptions. The library's "keep metadata" switch makes it write an EXIF block of its own for a source that has
 * none (about 190 bytes, from the density; 2% of a small file), so the blocks are kept one by one. WebP and AVIF viewers
 * ignore a print density, which only an EXIF block could hold there; a JPEG keeps it (see `keepSourceBlocks`).
 */
export const SOURCE_BLOCK_TARGETS: ReadonlySet<string> = new Set(['jpg', 'jpeg', 'webp', 'avif']);

/**
 * Whether a conversion is a PNG written from a PNG (entry 249): a compression of its source, which keeps the profile it carries as it is
 * and converts no sample through it, whatever the profile.
 */
export const compressesPng = (target: string, options: ConversionOptions): boolean => target === 'png' && isMarkedForOptimiser(options);

/** Whether the profile is attached as it is and the picture left unconverted: the targets of `SOURCE_BLOCK_TARGETS`, and a PNG written from a PNG. */
export const keepsSourceBlocks = (target: string, options: ConversionOptions): boolean => SOURCE_BLOCK_TARGETS.has(target) || compressesPng(target, options);

const profileIsDropped = (meta: Metadata): boolean => meta.format === 'png' && meta.icc !== undefined && isProfileDroppedByPngReader(meta.icc);

/**
 * The input opened again without its ICC profile when it is a PNG whose profile the reference engine's PNG reader drops, for the targets
 * that write the source's blocks: such a profile is not written and changes no pixel, so converting through it only costs time. For an 8-bit picture the
 * transform to sRGB is the identity and costs 3 to 6 ms per read of a 1 to 2 megapixel picture, and a thumbnail, the encode and the alpha
 * check each read it. For a 16-bit picture the transform goes through a wide-gamut working space and back, which moves about a third of the
 * samples by one step of 65535, enough to turn the nearest 8-bit level of 3.5% of them into the one below. Null: no such profile.
 */
export async function openWithoutSrgbProfile(pipeline: Sharp, selection: FrameSelection): Promise<Sharp | null> {
  const meta = await metadataOf(pipeline);
  if (!profileIsDropped(meta)) return null;
  return openLimitedSharp(selection.source, { ...selection.input, ignoreIcc: true });
}

/**
 * The pipeline keeping the EXIF block, XMP packet and ICC profile the input has, and no block it has not. A source with an
 * IPTC block keeps it in a JPEG, which the library can only do by keeping everything.
 */
export function keepSourceBlocks(pipeline: Sharp, meta: Metadata, target: string, srgbProfileIgnored: boolean, appliesNoCurve = false): Sharp {
  if (meta.iptc !== undefined && (target === 'jpg' || target === 'jpeg')) return pipeline.keepMetadata();
  let kept = pipeline;
  // The library writes a JPEG's print density only along with an EXIF block (made from the density when the source has none):
  // the one block this adds, for a picture whose density says it is meant for print.
  const keepsDensity = (target === 'jpg' || target === 'jpeg') && meta.density !== undefined && meta.density !== DEFAULT_DENSITY_PPI;
  if (meta.exif !== undefined || keepsDensity) kept = kept.keepExif();
  if (meta.xmp !== undefined) kept = kept.keepXmp();
  // The profile is attached as it is, the pixels not converted through it, except a profile the reference engine's PNG reader drops (opened
  // without by `openWithoutSrgbProfile`) and a development curve over sRGB primaries, which are applied to the pixels and not written.
  if (!meta.hasProfile) return kept;
  const appliedNotWritten = profileIsDropped(meta) || (!appliesNoCurve && meta.icc !== undefined && hasSrgbPrimaries(meta.icc) && !isSrgbProfile(meta.icc));
  if (meta.icc !== undefined && !appliedNotWritten) return kept.keepIccProfile();
  return srgbProfileIgnored ? kept : kept.withIccProfile('srgb', { attach: false });
}
