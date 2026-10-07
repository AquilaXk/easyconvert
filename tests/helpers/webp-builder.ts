/**
 * Hand-built animated WebP (RIFF container, VP8X/ICCP/ANIM/ANMF/EXIF chunks per the WebP container
 * specification) for the animation tests. It shares no code with the converter or with sharp.
 */

const RIFF_HEADER = 12;
const RIFF_CHUNK_HEAD = 8;
const FLAG_ANIMATION = 0x02;
const FLAG_ICC = 0x20;
const FLAG_EXIF = 0x08;

function riffChunk(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(RIFF_CHUNK_HEAD);
  head.write(type, 0, 'latin1');
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload, payload.length % 2 === 0 ? Buffer.alloc(0) : Buffer.alloc(1)]);
}

/** The ALPH/VP8/VP8L image chunks of a still WebP file, with their chunk headers. */
function stillImageChunks(still: Buffer): Buffer {
  const kept: Buffer[] = [];
  let pos = RIFF_HEADER;
  while (pos + RIFF_CHUNK_HEAD <= still.length) {
    const type = still.toString('latin1', pos, pos + 4);
    const length = still.readUInt32LE(pos + 4);
    const end = pos + RIFF_CHUNK_HEAD + length + (length % 2);
    if (type === 'ALPH' || type === 'VP8 ' || type === 'VP8L') kept.push(still.subarray(pos, end));
    pos = end;
  }
  return Buffer.concat(kept);
}

export interface AnimatedWebpSpec {
  width: number;
  height: number;
  frames: number;
  delayMs?: number;
  loop?: number;
  /** EXIF TIFF block (no `Exif\0\0` prefix). */
  exif?: Buffer;
  icc?: Buffer;
}

/**
 * Animated WebP whose every frame is the image chunk of one still WebP, so a huge canvas of one flat colour
 * costs a few hundred bytes.
 */
export function buildAnimatedWebpFromStill(still: Buffer, spec: AnimatedWebpSpec): Buffer {
  const image = stillImageChunks(still);
  const vp8x = Buffer.alloc(10);
  vp8x[0] = FLAG_ANIMATION | (spec.icc ? FLAG_ICC : 0) | (spec.exif ? FLAG_EXIF : 0);
  vp8x.writeUIntLE(spec.width - 1, 4, 3);
  vp8x.writeUIntLE(spec.height - 1, 7, 3);
  const anim = Buffer.alloc(6);
  anim.writeUInt16LE(spec.loop ?? 0, 4);
  const anmfHeader = Buffer.alloc(16);
  anmfHeader.writeUIntLE(spec.width - 1, 6, 3);
  anmfHeader.writeUIntLE(spec.height - 1, 9, 3);
  anmfHeader.writeUIntLE(spec.delayMs ?? 100, 12, 3);
  const frame = riffChunk('ANMF', Buffer.concat([anmfHeader, image]));
  const body = [Buffer.from('WEBP', 'latin1'), riffChunk('VP8X', vp8x)];
  if (spec.icc) body.push(riffChunk('ICCP', spec.icc));
  body.push(riffChunk('ANIM', anim));
  for (let index = 0; index < spec.frames; index += 1) body.push(frame);
  if (spec.exif) body.push(riffChunk('EXIF', spec.exif));
  const content = Buffer.concat(body);
  const head = Buffer.alloc(RIFF_CHUNK_HEAD);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(content.length, 4);
  return Buffer.concat([head, content]);
}
