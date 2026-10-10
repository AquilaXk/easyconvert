import { EdgeUnsupportedError } from '../workers/worker-errors';

/** The slice of a canvas this needs: an OffscreenCanvas has convertToBlob, an HTMLCanvasElement has toBlob. */
export interface BlobCanvas {
  convertToBlob?: (options: { type: string; quality: number }) => Promise<Blob>;
  toBlob?: (callback: (blob: Blob | null) => void, type: string, quality: number) => void;
}

/**
 * Encodes a canvas to an image Blob. A canvas that yields nothing (toBlob calls back with null, or the bytes are
 * empty) is a failure: an empty file is never a converted result. The failure is an EdgeUnsupportedError, so the tier
 * router runs the server tier on the original file.
 */
export async function canvasToBlob(canvas: BlobCanvas, mimeType: string, quality: number): Promise<Blob> {
  let blob: Blob | null;
  if (typeof canvas.convertToBlob === 'function') {
    blob = await canvas.convertToBlob({ type: mimeType, quality });
  } else if (typeof canvas.toBlob === 'function') {
    const encode = canvas.toBlob.bind(canvas);
    blob = await new Promise<Blob | null>((resolve) => encode(resolve, mimeType, quality));
  } else {
    throw new EdgeUnsupportedError('The canvas cannot encode an image.');
  }
  if (!blob || blob.size === 0) {
    throw new EdgeUnsupportedError(`The canvas produced no image data for ${mimeType}.`);
  }
  return blob;
}
