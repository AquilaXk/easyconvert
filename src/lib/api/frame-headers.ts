/**
 * Response metadata for conversions of multi-frame images (animated GIF/WebP/APNG, multi-page TIFF/HEIF):
 * how many frames the source holds and which one a still output was taken from.
 */

export const SOURCE_FRAMES_HEADER = 'X-Source-Frames';
export const FRAME_USED_HEADER = 'X-Frame-Used';

export interface FrameMetadata {
  sourceFrameCount?: number;
  frameUsed?: number;
}

/** Headers carrying the frame metadata of a conversion result; empty when the source had a single frame. */
export function frameMetadataHeaders(result: FrameMetadata): Record<string, string> {
  const headers: Record<string, string> = {};
  if (result.sourceFrameCount !== undefined) headers[SOURCE_FRAMES_HEADER] = String(result.sourceFrameCount);
  if (result.frameUsed !== undefined) headers[FRAME_USED_HEADER] = String(result.frameUsed);
  return headers;
}

/** JSON fields carrying the frame metadata of a conversion result; empty when the source had a single frame. */
export function frameMetadataFields(result: FrameMetadata): FrameMetadata {
  const fields: FrameMetadata = {};
  if (result.sourceFrameCount !== undefined) fields.sourceFrameCount = result.sourceFrameCount;
  if (result.frameUsed !== undefined) fields.frameUsed = result.frameUsed;
  return fields;
}
