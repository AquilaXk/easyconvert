/**
 * Hand-written GIF89a writer (CompuServe GIF specification) for the frame-limit tests. It shares no code
 * with the converter or with sharp.
 */

const GIF_MIN_CODE_SIZE = 2;
/** LZW data of one 1x1 frame with minimum code size 2, for palette index 0 and index 1. */
const PIXEL_DATA = [Buffer.from([0x44, 0x01]), Buffer.from([0x4c, 0x01])];

/**
 * GIF of `frames` 1x1 frames whose pixel alternates between palette index 0 (red) and 1 (blue), so no two
 * neighbouring frames are identical and a writer cannot merge them.
 */
export function buildTinyGif(frames: number): Buffer {
  const parts: Buffer[] = [
    Buffer.from('GIF89a', 'latin1'),
    Buffer.from([1, 0, 1, 0, 0x80, 0, 0]), // 1x1 screen, 2-colour global table
    Buffer.from([255, 0, 0, 0, 0, 255]), // red, blue
  ];
  for (let index = 0; index < frames; index += 1) {
    const data = PIXEL_DATA[index % 2];
    parts.push(
      Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0]), // graphic control: 100 ms
      Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]), // image descriptor, no local table
      Buffer.from([GIF_MIN_CODE_SIZE, data.length]),
      data,
      Buffer.from([0])
    );
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}
