/**
 * Builds a minimal HDMV Presentation Graphic Stream (.sup): one solid rectangle shown from `startMs` to `endMs`.
 * The segment layout (PCS 0x16, WDS 0x17, PDS 0x14, ODS 0x15, END 0x80) and the run-length code follow the
 * Blu-ray PGS description; the bytes are authored here, not by the engine under test. It gives the tests a
 * bitmap subtitle (hdmv_pgs_subtitle) that ffmpeg itself cannot encode.
 */

export interface PgsRectangle {
  /** Canvas size: the video size the subtitle was authored for. */
  width: number;
  height: number;
  /** Position and size of the rectangle on the canvas. */
  x: number;
  y: number;
  w: number;
  h: number;
  startMs: number;
  endMs: number;
}

const PTS_PER_MS = 90;
const SEGMENT_PCS = 0x16;
const SEGMENT_WDS = 0x17;
const SEGMENT_PDS = 0x14;
const SEGMENT_ODS = 0x15;
const SEGMENT_END = 0x80;
const FRAME_RATE_CODE = 0x10;
const STATE_EPOCH_START = 0x80;
const STATE_NORMAL = 0x00;
const WHITE_PALETTE_ENTRY = 1;
const LUMA_WHITE = 235;
const CHROMA_NEUTRAL = 128;
const OPAQUE = 255;
const SEQUENCE_FIRST_AND_LAST = 0xc0;
const SHORT_RUN_LIMIT = 64;

function u16(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value);
  return buf;
}

function segment(type: number, ptsMs: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.write('PG', 0, 'latin1');
  header.writeUInt32BE(ptsMs * PTS_PER_MS, 2);
  header.writeUInt32BE(0, 6);
  header.writeUInt8(type, 10);
  header.writeUInt16BE(payload.length, 11);
  return Buffer.concat([header, payload]);
}

/** Run-length code of one row of `w` pixels of colour 1, then the end-of-line marker. */
function solidRow(w: number): Buffer {
  const run =
    w < SHORT_RUN_LIMIT
      ? Buffer.from([0x00, 0x80 | w, WHITE_PALETTE_ENTRY])
      : Buffer.from([0x00, 0xc0 | (w >> 8), w & 0xff, WHITE_PALETTE_ENTRY]);
  return Buffer.concat([run, Buffer.from([0x00, 0x00])]);
}

function presentationComposition(rect: PgsRectangle, state: number, ptsMs: number, objects: number): Buffer {
  const head = Buffer.concat([
    u16(rect.width),
    u16(rect.height),
    Buffer.from([FRAME_RATE_CODE]),
    u16(state === STATE_EPOCH_START ? 0 : 1),
    Buffer.from([state, 0x00, 0x00, objects]),
  ]);
  const object = Buffer.concat([u16(0), Buffer.from([0x00, 0x00]), u16(rect.x), u16(rect.y)]);
  return segment(SEGMENT_PCS, ptsMs, objects > 0 ? Buffer.concat([head, object]) : head);
}

function windowDefinition(rect: PgsRectangle, ptsMs: number): Buffer {
  return segment(SEGMENT_WDS, ptsMs, Buffer.concat([Buffer.from([1, 0]), u16(rect.x), u16(rect.y), u16(rect.w), u16(rect.h)]));
}

export function pgsRectangleSup(rect: PgsRectangle): Buffer {
  const rows = Buffer.concat(Array.from({ length: rect.h }, () => solidRow(rect.w)));
  const objectData = Buffer.concat([u16(rect.w), u16(rect.h), rows]);
  const dataLength = Buffer.from([(objectData.length >> 16) & 0xff, (objectData.length >> 8) & 0xff, objectData.length & 0xff]);
  const object = segment(
    SEGMENT_ODS,
    rect.startMs,
    Buffer.concat([u16(0), Buffer.from([0x00, SEQUENCE_FIRST_AND_LAST]), dataLength, objectData])
  );
  const palette = segment(
    SEGMENT_PDS,
    rect.startMs,
    Buffer.from([0x00, 0x00, WHITE_PALETTE_ENTRY, LUMA_WHITE, CHROMA_NEUTRAL, CHROMA_NEUTRAL, OPAQUE])
  );
  const end = (ptsMs: number) => segment(SEGMENT_END, ptsMs, Buffer.alloc(0));
  return Buffer.concat([
    presentationComposition(rect, STATE_EPOCH_START, rect.startMs, 1),
    windowDefinition(rect, rect.startMs),
    palette,
    object,
    end(rect.startMs),
    presentationComposition(rect, STATE_NORMAL, rect.endMs, 0),
    windowDefinition(rect, rect.endMs),
    end(rect.endMs),
  ]);
}
