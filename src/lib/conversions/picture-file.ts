import fs from 'node:fs';

/**
 * A picture whose pixels stay in a file. The image pipeline takes its source as a Buffer, and every reader of the bytes themselves (the
 * format sniffers, the print density, the TIFF directories) reads the head of the file only, so a picture of tens of megabytes can be
 * handed over as the head of its file: the places that open the picture with sharp (`sharpInput`) open the file instead, and the Node
 * process never holds the pixels. A caller that reads the bytes of a source beyond its head must be given the whole file.
 */
const filesOfHeads = new WeakMap<Buffer, string>();

/** Prefix bytes read to inspect still-image headers on disk (>= 256 bytes covers BMP BITMAPV5HEADER 14 + 124 = 138 bytes and masks). */
export const PICTURE_HEADER_READ_BYTES = 4096;

/** `head` (the bytes of the file before its pixels) standing for the file at `filePath`. */
export function pictureFileHead(filePath: string, head: Buffer): Buffer {
  filesOfHeads.set(head, filePath);
  return head;
}

/** Reads at most `maxBytes` from offset 0 of `filePath` and binds the slice to `filePath` for sharp metadata reads. */
export async function readPictureFileHead(
  filePath: string,
  maxBytes: number = PICTURE_HEADER_READ_BYTES
): Promise<Buffer> {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return pictureFileHead(filePath, buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

/** What sharp opens for `source`: the file a head stands for, or the buffer itself. */
export function sharpInput(source: Buffer): Buffer | string {
  return filesOfHeads.get(source) ?? source;
}
