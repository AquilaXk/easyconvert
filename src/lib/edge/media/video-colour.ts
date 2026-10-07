/**
 * Colour description of a video as ISO/IEC 23091-2 (ITU-T H.273) code points, and its two translations: the
 * VideoColorSpace enums WebCodecs takes in a decoder configuration, and the checks the muxers apply before they
 * write the code points into an output file.
 */

import { EdgeUnsupportedError } from '../workers/worker-errors';
import type { VideoColour } from './media-types';

/** Code point 2: the file states nothing for this field; WebCodecs spells that `null`. */
const CODE_POINT_UNSPECIFIED = 2;
const CODE_POINT_BT709 = 1;
/** The code points are one byte in H.273; Matroska stores them as one, MP4 as sixteen bits. */
export const COLOUR_CODE_POINT_MAX = 255;

/** Colour primaries (H.273 Table 2) that the WebCodecs VideoColorPrimaries enum names. */
const PRIMARIES_BY_CODE: ReadonlyMap<number, string> = new Map([
  [1, 'bt709'],
  [5, 'bt470bg'],
  [6, 'smpte170m'],
  [9, 'bt2020'],
  [12, 'smpte432'],
]);

/** Transfer characteristics (H.273 Table 3) that the VideoTransferCharacteristics enum names. */
const TRANSFER_BY_CODE: ReadonlyMap<number, string> = new Map([
  [1, 'bt709'],
  [6, 'smpte170m'],
  [8, 'linear'],
  [13, 'iec61966-2-1'],
  [16, 'pq'],
  [18, 'hlg'],
]);

/** Matrix coefficients (H.273 Table 4) that the VideoMatrixCoefficients enum names. */
const MATRIX_BY_CODE: ReadonlyMap<number, string> = new Map([
  [0, 'rgb'],
  [1, 'bt709'],
  [5, 'bt470bg'],
  [6, 'smpte170m'],
  [9, 'bt2020-ncl'],
]);

export interface WebCodecsColorSpace {
  primaries: string | null;
  transfer: string | null;
  matrix: string | null;
  fullRange: boolean;
}

function named(field: string, code: number, names: ReadonlyMap<number, string>): string | null {
  if (code === CODE_POINT_UNSPECIFIED) return null;
  const name = names.get(code);
  if (name === undefined) {
    throw new EdgeUnsupportedError(
      `The video states ${field} code point ${code}, which WebCodecs has no name for; the server engine converts this file.`
    );
  }
  return name;
}

/** The `colorSpace` of a VideoDecoder configuration for `colour`; a code point WebCodecs cannot name throws. */
export function toWebCodecsColorSpace(colour: VideoColour): WebCodecsColorSpace {
  return {
    primaries: named('colour primaries', colour.primaries, PRIMARIES_BY_CODE),
    transfer: named('transfer characteristics', colour.transfer, TRANSFER_BY_CODE),
    matrix: named('matrix coefficients', colour.matrix, MATRIX_BY_CODE),
    fullRange: colour.fullRange,
  };
}

/** True when every field is a whole number a container can store. */
export function isStorableColour(colour: VideoColour): boolean {
  return [colour.primaries, colour.transfer, colour.matrix].every(
    (code) => Number.isInteger(code) && code >= 0 && code <= COLOUR_CODE_POINT_MAX
  );
}

/**
 * Whether pictures redrawn through a canvas (which is how the worker resizes) still match `colour`. A canvas
 * hands the encoder BT.709 limited-range pictures, so only a description that says BT.709, or nothing, survives.
 */
export function survivesCanvasRedraw(colour: VideoColour): boolean {
  const compatible = (code: number): boolean => code === CODE_POINT_BT709 || code === CODE_POINT_UNSPECIFIED;
  return !colour.fullRange && compatible(colour.primaries) && compatible(colour.transfer) && compatible(colour.matrix);
}
