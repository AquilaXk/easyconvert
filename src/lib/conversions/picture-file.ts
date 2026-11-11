/**
 * A picture whose pixels stay in a file. The image pipeline takes its source as a Buffer, and every reader of the bytes themselves (the
 * format sniffers, the print density, the TIFF directories) reads the head of the file only, so a picture of tens of megabytes can be
 * handed over as the head of its file: the places that open the picture with sharp (`sharpInput`) open the file instead, and the Node
 * process never holds the pixels. A caller that reads the bytes of a source beyond its head must be given the whole file.
 */
const filesOfHeads = new WeakMap<Buffer, string>();

/** `head` (the bytes of the file before its pixels) standing for the file at `filePath`. */
export function pictureFileHead(filePath: string, head: Buffer): Buffer {
  filesOfHeads.set(head, filePath);
  return head;
}

/** What sharp opens for `source`: the file a head stands for, or the buffer itself. */
export function sharpInput(source: Buffer): Buffer | string {
  return filesOfHeads.get(source) ?? source;
}
