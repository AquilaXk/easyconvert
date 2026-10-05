import {
  GrowBuffer,
  U255_BYTE_1_BASE,
  U255_BYTE_2_BASE,
  U255_ONE_MORE_BYTE_1,
  U255_ONE_MORE_BYTE_2,
  U255_WORD_CODE,
  WOFF2_MAX_DECODED_BYTES,
  WOFF2_MAX_POINTS_PER_GLYPH,
  Woff2FormatError,
  Woff2LimitError,
  truncated,
} from './font-woff2-primitives';

/**
 * The glyf/loca and hmtx transforms of the W3C WOFF2 Recommendation (transformed glyf table format,
 * transformed loca table, transformed hmtx table), in both directions.
 *
 * Layout of the transformed glyf table: a 36 byte header (version, option flags, glyph count, loca
 * format, then the byte sizes of seven streams), followed by the streams: contour counts, point
 * counts per contour, point flags, coordinate triplets plus instruction lengths, composite glyph
 * records, bounding boxes (a bitmap with one bit per glyph, then the explicit boxes) and instructions;
 * an optional bitmap of glyphs whose first flag carries the overlap bit comes last.
 */

const GLYF_TRANSFORM_HEADER_BYTES = 36;
const GLYF_STREAM_COUNT = 7;
const GLYF_SIZE_FIELDS_AT = 8;
const GLYF_OPTION_OVERLAP_BITMAP = 0x0001;
const GLYPH_HEADER_BYTES = 10;
const GLYPH_ALIGNMENT_MASK = 3;
const COMPOSITE_CONTOURS = -1;
const INT16_MIN = -32768;
const INT16_MAX = 32767;
const LOCA_SHORT_MAX_BYTES = 0x1fffe;
const BYTES_PER_UINT16 = 2;
const BYTES_PER_UINT32 = 4;
const BBOX_BYTES = 8;
const MAX_FLAG_RUN = 256;
const BITS_PER_BYTE = 8;
const FIRST_BIT = 0x80;
const BITS_PER_BYTE_MASK = 7;
const BITMAP_WORD_SHIFT = 5;
const BITMAP_WORD_BYTES_SHIFT = 2;
/** Worst case bytes a point adds to a simple glyph: one flag and two coordinate bytes per axis. */
const WORST_BYTES_PER_POINT = 5;

/** sfnt simple glyph flags. */
const FLAG_ON_CURVE = 0x01;
const FLAG_X_SHORT = 0x02;
const FLAG_Y_SHORT = 0x04;
const FLAG_REPEAT = 0x08;
const FLAG_X_SAME_OR_POSITIVE = 0x10;
const FLAG_Y_SAME_OR_POSITIVE = 0x20;
const FLAG_OVERLAP_SIMPLE = 0x40;
const SHORT_VECTOR_LIMIT = 256;

/** Composite glyph component flags. */
const COMPONENT_ARG_WORDS = 0x0001;
const COMPONENT_HAVE_SCALE = 0x0008;
const COMPONENT_MORE = 0x0020;
const COMPONENT_HAVE_XY_SCALE = 0x0040;
const COMPONENT_HAVE_2X2 = 0x0080;
const COMPONENT_HAVE_INSTRUCTIONS = 0x0100;
const COMPONENT_FIXED_BYTES = 4;
const COMPONENT_WORD_ARGS_BYTES = 4;
const COMPONENT_BYTE_ARGS_BYTES = 2;
const COMPONENT_SCALE_BYTES = 2;
const COMPONENT_XY_SCALE_BYTES = 4;
const COMPONENT_2X2_BYTES = 8;

/**
 * Triplet encoding: the flag byte of a point (low seven bits) selects how many bytes the point takes
 * and how they split into dx and dy; bit 7 is set for off-curve points.
 */
const TRIPLET_OFF_CURVE = 0x80;
const TRIPLET_KIND_MASK = 0x7f;
const TRIPLET_Y_ONLY_END = 10;
const TRIPLET_X_ONLY_END = 20;
const TRIPLET_ONE_BYTE_END = 84;
const TRIPLET_TWO_BYTE_END = 120;
const TRIPLET_THREE_BYTE_END = 124;
const TRIPLET_NIBBLE_HIGH_BITS = 0x30;
const TRIPLET_NIBBLE_Y_HIGH_BITS = 0x0c;
const TRIPLET_BLOCKS_PER_X_STEP = 12;
const TRIPLET_AXIS_HIGH_BITS = 14;
const TRIPLET_AXIS_HIGH_SHIFT = 7;
const TRIPLET_Y_HIGH_SHIFT = 2;

const HMTX_NO_LSB_ARRAY = 0x01;
const HMTX_NO_TAIL_ARRAY = 0x02;
const HMTX_RESERVED_BITS = 0xfc;
const BYTES_PER_LONG_HOR_METRIC = 4;

export interface GlyfReconstruction {
  glyf: Uint8Array;
  /** Offsets of the glyphs in glyf, numGlyphs + 1 entries. */
  offsets: Uint32Array;
  indexFormat: number;
  numGlyphs: number;
  /** xMin of every glyph (0 for empty glyphs), the left side bearing the hmtx transform omits. */
  xMin: Int16Array;
}

/** Reads a 255UInt16 from data[cursor.at, end); advances the cursor. */
function read255(data: Uint8Array, cursor: { at: number }, end: number, what: string): number {
  const at = cursor.at;
  if (at >= end) throw truncated(what);
  const code = data[at];
  if (code === U255_WORD_CODE) {
    if (at + 3 > end) throw truncated(what);
    cursor.at = at + 3;
    return (data[at + 1] << 8) | data[at + 2];
  }
  if (code === U255_ONE_MORE_BYTE_1 || code === U255_ONE_MORE_BYTE_2) {
    if (at + 2 > end) throw truncated(what);
    cursor.at = at + 2;
    return data[at + 1] + (code === U255_ONE_MORE_BYTE_1 ? U255_BYTE_1_BASE : U255_BYTE_2_BASE);
  }
  cursor.at = at + 1;
  return code;
}

/**
 * Reverses the glyf transform. The streams are consumed in one pass; each glyph is written to the
 * output in place with its flags run-length packed, its coordinates in the shortest sfnt form, and
 * four-byte alignment between glyphs. `lengthHint` is the origLength of the directory; it only sizes
 * the first allocation, because encoders pack flags differently and so disagree on the exact length.
 */
export function reconstructGlyf(data: Uint8Array, lengthHint: number | null): GlyfReconstruction {
  if (data.length < GLYF_TRANSFORM_HEADER_BYTES) throw truncated('the transformed glyf table header');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint16(0) !== 0) throw new Woff2FormatError('Invalid WOFF2: the transformed glyf table has a version other than 0.');
  const optionFlags = view.getUint16(2);
  if ((optionFlags & ~GLYF_OPTION_OVERLAP_BITMAP) !== 0) {
    throw new Woff2FormatError('Invalid WOFF2: the transformed glyf table sets reserved option flags.');
  }
  const numGlyphs = view.getUint16(4);
  const indexFormat = view.getUint16(6);
  if (indexFormat > 1) throw new Woff2FormatError(`Invalid WOFF2: glyf indexFormat ${indexFormat} is neither 0 nor 1.`);

  // stream i occupies [bound[i], bound[i + 1])
  const bound: number[] = [GLYF_TRANSFORM_HEADER_BYTES];
  for (let i = 0; i < GLYF_STREAM_COUNT; i++) bound.push(bound[i] + view.getUint32(GLYF_SIZE_FIELDS_AT + i * BYTES_PER_UINT32));
  const overlapBytes = (optionFlags & GLYF_OPTION_OVERLAP_BITMAP) !== 0 ? (numGlyphs + BITS_PER_BYTE_MASK) >> 3 : 0;
  if (bound[GLYF_STREAM_COUNT] + overlapBytes !== data.length) {
    throw new Woff2FormatError('Invalid WOFF2: the stream sizes of the transformed glyf table do not add up to its length.');
  }
  const [contourStart, pointsStart, flagsStart, glyphStart, compositeStart, bboxStart, instructionStart, overlapStart] = bound;
  const pointsEnd = flagsStart;
  const flagsEnd = glyphStart;
  const glyphEnd = compositeStart;
  const compositeEnd = bboxStart;
  const bboxEnd = instructionStart;
  const instructionEnd = overlapStart;
  const bitmapBytes = ((numGlyphs + 31) >> BITMAP_WORD_SHIFT) << BITMAP_WORD_BYTES_SHIFT;
  if (bboxEnd - bboxStart < bitmapBytes) throw truncated('the bounding box bitmap');
  if (pointsStart - contourStart !== numGlyphs * BYTES_PER_UINT16) {
    throw new Woff2FormatError('Invalid WOFF2: the contour count stream does not hold one entry per glyph.');
  }

  const pointsCursor = { at: pointsStart };
  const glyphCursor = { at: glyphStart };
  let contourAt = contourStart;
  let flagAt = flagsStart;
  let compositeAt = compositeStart;
  let boxAt = bboxStart + bitmapBytes;
  let instructionAt = instructionStart;

  // the flag stream holds one byte per point, so it bounds the points of any glyph; the point count
  // stream holds at least one byte per contour, so it bounds the contours
  const scratchPoints = Math.min(WOFF2_MAX_POINTS_PER_GLYPH, flagsEnd - flagsStart);
  const deltaX = new Int32Array(scratchPoints);
  const deltaY = new Int32Array(scratchPoints);
  const sfntFlags = new Uint8Array(scratchPoints);
  const endPoints = new Uint16Array(Math.min(INT16_MAX, pointsEnd - pointsStart));

  const out = new GrowBuffer(
    Math.min(lengthHint ?? data.length * 2, data.length * 4 + 1024),
    WOFF2_MAX_DECODED_BYTES,
    () => new Woff2LimitError(`The reconstructed glyf table would exceed ${WOFF2_MAX_DECODED_BYTES} bytes.`),
  );
  const offsets = new Uint32Array(numGlyphs + 1);
  const xMin = new Int16Array(numGlyphs);

  for (let glyph = 0; glyph < numGlyphs; glyph++) {
    offsets[glyph] = out.length;
    const contours = view.getInt16(contourAt);
    contourAt += BYTES_PER_UINT16;
    const hasBox = (data[bboxStart + (glyph >> 3)] & (FIRST_BIT >> (glyph & BITS_PER_BYTE_MASK))) !== 0;

    if (contours === 0) {
      if (hasBox) throw new Woff2FormatError(`Invalid WOFF2: empty glyph ${glyph} carries a bounding box.`);
      continue;
    }

    if (contours === COMPOSITE_CONTOURS) {
      if (!hasBox) throw new Woff2FormatError(`Invalid WOFF2: composite glyph ${glyph} has no bounding box.`);
      if (boxAt + BBOX_BYTES > bboxEnd) throw truncated('the bounding box stream');
      out.reserve(GLYPH_HEADER_BYTES);
      out.i16(out.length, COMPOSITE_CONTOURS);
      out.bytes.set(data.subarray(boxAt, boxAt + BBOX_BYTES), out.length + BYTES_PER_UINT16);
      xMin[glyph] = view.getInt16(boxAt);
      boxAt += BBOX_BYTES;
      out.length += GLYPH_HEADER_BYTES;
      let haveInstructions = false;
      for (let more = true; more; ) {
        if (compositeAt + COMPONENT_FIXED_BYTES > compositeEnd) throw truncated('the composite stream');
        const flags = view.getUint16(compositeAt);
        const component = view.getUint16(compositeAt + BYTES_PER_UINT16);
        if (component >= numGlyphs) throw new Woff2FormatError(`Invalid WOFF2: glyph ${glyph} refers to glyph ${component} of ${numGlyphs}.`);
        let size = COMPONENT_FIXED_BYTES + ((flags & COMPONENT_ARG_WORDS) !== 0 ? COMPONENT_WORD_ARGS_BYTES : COMPONENT_BYTE_ARGS_BYTES);
        if ((flags & COMPONENT_HAVE_SCALE) !== 0) size += COMPONENT_SCALE_BYTES;
        else if ((flags & COMPONENT_HAVE_XY_SCALE) !== 0) size += COMPONENT_XY_SCALE_BYTES;
        else if ((flags & COMPONENT_HAVE_2X2) !== 0) size += COMPONENT_2X2_BYTES;
        if (compositeAt + size > compositeEnd) throw truncated('the composite stream');
        out.reserve(size);
        out.bytes.set(data.subarray(compositeAt, compositeAt + size), out.length);
        out.length += size;
        compositeAt += size;
        haveInstructions ||= (flags & COMPONENT_HAVE_INSTRUCTIONS) !== 0;
        more = (flags & COMPONENT_MORE) !== 0;
      }
      if (haveInstructions) {
        const length = read255(data, glyphCursor, glyphEnd, 'the glyph stream');
        if (instructionAt + length > instructionEnd) throw truncated('the instruction stream');
        out.reserve(BYTES_PER_UINT16 + length);
        out.u16(out.length, length);
        out.bytes.set(data.subarray(instructionAt, instructionAt + length), out.length + BYTES_PER_UINT16);
        out.length += BYTES_PER_UINT16 + length;
        instructionAt += length;
      }
    } else if (contours > 0) {
      let points = 0;
      for (let c = 0; c < contours; c++) {
        const inContour = read255(data, pointsCursor, pointsEnd, 'the point count stream');
        if (inContour === 0) throw new Woff2FormatError(`Invalid WOFF2: glyph ${glyph} has a contour without points.`);
        points += inContour;
        if (points > WOFF2_MAX_POINTS_PER_GLYPH) {
          throw new Woff2LimitError(`Glyph ${glyph} has more than ${WOFF2_MAX_POINTS_PER_GLYPH} points.`);
        }
        endPoints[c] = points - 1;
      }
      if (flagAt + points > flagsEnd) throw truncated('the flag stream');

      // triplets to deltas, absolute extent and sfnt flags
      let x = 0;
      let y = 0;
      let minX = INT16_MAX;
      let minY = INT16_MAX;
      let maxX = INT16_MIN;
      let maxY = INT16_MIN;
      let at = glyphCursor.at;
      for (let i = 0; i < points; i++) {
        const flag = data[flagAt + i];
        const kind = flag & TRIPLET_KIND_MASK;
        let dx: number;
        let dy: number;
        if (kind < TRIPLET_ONE_BYTE_END) {
          if (at + 1 > glyphEnd) throw truncated('the glyph stream');
          const b = data[at++];
          if (kind < TRIPLET_Y_ONLY_END) {
            dx = 0;
            dy = ((kind & TRIPLET_AXIS_HIGH_BITS) << TRIPLET_AXIS_HIGH_SHIFT) + b;
            if ((kind & 1) === 0) dy = -dy;
          } else if (kind < TRIPLET_X_ONLY_END) {
            dx = (((kind - TRIPLET_Y_ONLY_END) & TRIPLET_AXIS_HIGH_BITS) << TRIPLET_AXIS_HIGH_SHIFT) + b;
            if ((kind & 1) === 0) dx = -dx;
            dy = 0;
          } else {
            const base = kind - TRIPLET_X_ONLY_END;
            dx = 1 + (base & TRIPLET_NIBBLE_HIGH_BITS) + (b >> 4);
            dy = 1 + ((base & TRIPLET_NIBBLE_Y_HIGH_BITS) << TRIPLET_Y_HIGH_SHIFT) + (b & 0x0f);
            if ((kind & 1) === 0) dx = -dx;
            if ((kind & 2) === 0) dy = -dy;
          }
        } else if (kind < TRIPLET_TWO_BYTE_END) {
          if (at + 2 > glyphEnd) throw truncated('the glyph stream');
          const base = kind - TRIPLET_ONE_BYTE_END;
          dx = 1 + (Math.floor(base / TRIPLET_BLOCKS_PER_X_STEP) << 8) + data[at];
          dy = 1 + (((base % TRIPLET_BLOCKS_PER_X_STEP) >> 2) << 8) + data[at + 1];
          at += 2;
          if ((kind & 1) === 0) dx = -dx;
          if ((kind & 2) === 0) dy = -dy;
        } else if (kind < TRIPLET_THREE_BYTE_END) {
          if (at + 3 > glyphEnd) throw truncated('the glyph stream');
          dx = (data[at] << 4) + (data[at + 1] >> 4);
          dy = ((data[at + 1] & 0x0f) << 8) + data[at + 2];
          at += 3;
          if ((kind & 1) === 0) dx = -dx;
          if ((kind & 2) === 0) dy = -dy;
        } else {
          if (at + 4 > glyphEnd) throw truncated('the glyph stream');
          dx = (data[at] << 8) + data[at + 1];
          dy = (data[at + 2] << 8) + data[at + 3];
          at += 4;
          if ((kind & 1) === 0) dx = -dx;
          if ((kind & 2) === 0) dy = -dy;
        }
        x += dx;
        y += dy;
        if (x < INT16_MIN || x > INT16_MAX || y < INT16_MIN || y > INT16_MAX) {
          throw new Woff2FormatError(`Invalid WOFF2: glyph ${glyph} has a coordinate outside the 16-bit range.`);
        }
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        deltaX[i] = dx;
        deltaY[i] = dy;
        let sfntFlag = (flag & TRIPLET_OFF_CURVE) === 0 ? FLAG_ON_CURVE : 0;
        if (dx === 0) sfntFlag |= FLAG_X_SAME_OR_POSITIVE;
        else if (dx > -SHORT_VECTOR_LIMIT && dx < SHORT_VECTOR_LIMIT) sfntFlag |= dx > 0 ? FLAG_X_SHORT | FLAG_X_SAME_OR_POSITIVE : FLAG_X_SHORT;
        if (dy === 0) sfntFlag |= FLAG_Y_SAME_OR_POSITIVE;
        else if (dy > -SHORT_VECTOR_LIMIT && dy < SHORT_VECTOR_LIMIT) sfntFlag |= dy > 0 ? FLAG_Y_SHORT | FLAG_Y_SAME_OR_POSITIVE : FLAG_Y_SHORT;
        sfntFlags[i] = sfntFlag;
      }
      glyphCursor.at = at;
      flagAt += points;
      if (overlapBytes > 0 && (data[overlapStart + (glyph >> 3)] & (FIRST_BIT >> (glyph & BITS_PER_BYTE_MASK))) !== 0) {
        sfntFlags[0] |= FLAG_OVERLAP_SIMPLE;
      }

      const instructionLength = read255(data, glyphCursor, glyphEnd, 'the glyph stream');
      if (instructionAt + instructionLength > instructionEnd) throw truncated('the instruction stream');

      let box0 = minX;
      let box1 = minY;
      let box2 = maxX;
      let box3 = maxY;
      if (hasBox) {
        if (boxAt + BBOX_BYTES > bboxEnd) throw truncated('the bounding box stream');
        box0 = view.getInt16(boxAt);
        box1 = view.getInt16(boxAt + 2);
        box2 = view.getInt16(boxAt + 4);
        box3 = view.getInt16(boxAt + 6);
        boxAt += BBOX_BYTES;
      }
      xMin[glyph] = box0;

      // header, end points, instructions, then flags and coordinates written back to back
      out.reserve(
        GLYPH_HEADER_BYTES + contours * BYTES_PER_UINT16 + BYTES_PER_UINT16 + instructionLength + points * WORST_BYTES_PER_POINT + GLYPH_ALIGNMENT_MASK,
      );
      const bytes = out.bytes;
      let o = out.length;
      out.i16(o, contours);
      out.i16(o + 2, box0);
      out.i16(o + 4, box1);
      out.i16(o + 6, box2);
      out.i16(o + 8, box3);
      o += GLYPH_HEADER_BYTES;
      for (let c = 0; c < contours; c++, o += BYTES_PER_UINT16) out.u16(o, endPoints[c]);
      out.u16(o, instructionLength);
      o += BYTES_PER_UINT16;
      bytes.set(data.subarray(instructionAt, instructionAt + instructionLength), o);
      o += instructionLength;
      instructionAt += instructionLength;

      for (let i = 0; i < points; ) {
        const f = sfntFlags[i];
        let run = 1;
        while (i + run < points && run < MAX_FLAG_RUN && sfntFlags[i + run] === f) run++;
        if (run > 1) {
          bytes[o++] = f | FLAG_REPEAT;
          bytes[o++] = run - 1;
        } else {
          bytes[o++] = f;
        }
        i += run;
      }
      for (let i = 0; i < points; i++) {
        const f = sfntFlags[i];
        const d = deltaX[i];
        if ((f & FLAG_X_SHORT) !== 0) bytes[o++] = d < 0 ? -d : d;
        else if ((f & FLAG_X_SAME_OR_POSITIVE) === 0) {
          bytes[o++] = (d >> 8) & 0xff;
          bytes[o++] = d & 0xff;
        }
      }
      for (let i = 0; i < points; i++) {
        const f = sfntFlags[i];
        const d = deltaY[i];
        if ((f & FLAG_Y_SHORT) !== 0) bytes[o++] = d < 0 ? -d : d;
        else if ((f & FLAG_Y_SAME_OR_POSITIVE) === 0) {
          bytes[o++] = (d >> 8) & 0xff;
          bytes[o++] = d & 0xff;
        }
      }
      out.length = o;
    } else {
      throw new Woff2FormatError(`Invalid WOFF2: glyph ${glyph} declares ${contours} contours.`);
    }

    out.reserve(GLYPH_ALIGNMENT_MASK);
    while ((out.length & GLYPH_ALIGNMENT_MASK) !== 0) out.bytes[out.length++] = 0;
    out.commit();
  }
  offsets[numGlyphs] = out.length;

  return { glyf: out.finish(), offsets, indexFormat, numGlyphs, xMin };
}

/** Writes the loca table for the glyph offsets in the given index format. */
export function serializeLoca(offsets: Uint32Array, indexFormat: number): Uint8Array {
  const long = indexFormat === 1;
  if (!long && offsets[offsets.length - 1] > LOCA_SHORT_MAX_BYTES) {
    throw new Woff2FormatError('Invalid WOFF2: the glyf table is too large for the short loca format its indexFormat selects.');
  }
  const loca = new Uint8Array(offsets.length * (long ? BYTES_PER_UINT32 : BYTES_PER_UINT16));
  const view = new DataView(loca.buffer);
  for (let i = 0; i < offsets.length; i++) {
    if (long) view.setUint32(i * BYTES_PER_UINT32, offsets[i]);
    else view.setUint16(i * BYTES_PER_UINT16, offsets[i] / BYTES_PER_UINT16);
  }
  return loca;
}

/** xMin of every glyph of an untransformed glyf table (0 for empty glyphs). */
export function readXMins(glyf: Uint8Array, loca: Uint8Array, longLoca: boolean, numGlyphs: number): Int16Array {
  const entry = longLoca ? BYTES_PER_UINT32 : BYTES_PER_UINT16;
  if (loca.length < (numGlyphs + 1) * entry) throw truncated('the loca table');
  const locaView = new DataView(loca.buffer, loca.byteOffset, loca.byteLength);
  const glyfView = new DataView(glyf.buffer, glyf.byteOffset, glyf.byteLength);
  const offsetOf = (i: number): number => (longLoca ? locaView.getUint32(i * entry) : locaView.getUint16(i * entry) * BYTES_PER_UINT16);
  const xMin = new Int16Array(numGlyphs);
  for (let g = 0; g < numGlyphs; g++) {
    const start = offsetOf(g);
    const end = offsetOf(g + 1);
    if (end < start || end > glyf.length) throw new Woff2FormatError(`Invalid WOFF2: loca offsets of glyph ${g} lie outside glyf.`);
    if (end > start) {
      if (start + GLYPH_HEADER_BYTES > glyf.length) throw truncated('a glyph header');
      xMin[g] = glyfView.getInt16(start + BYTES_PER_UINT16);
    }
  }
  return xMin;
}

/** Reverses the hmtx transform: advance widths come from the stream, omitted side bearings from the glyph boxes. */
export function reconstructHmtx(data: Uint8Array, expectedLength: number, numGlyphs: number, numHMetrics: number, xMin: Int16Array): Uint8Array {
  if (data.length < 1) throw truncated('the transformed hmtx table');
  const flags = data[0];
  if ((flags & HMTX_RESERVED_BITS) !== 0) throw new Woff2FormatError('Invalid WOFF2: the transformed hmtx table sets reserved flags.');
  const hasLsb = (flags & HMTX_NO_LSB_ARRAY) === 0;
  const hasTail = (flags & HMTX_NO_TAIL_ARRAY) === 0;
  if (hasLsb && hasTail) {
    throw new Woff2FormatError('Invalid WOFF2: a transformed hmtx table must omit at least one of its side bearing arrays.');
  }
  if (numHMetrics < 1 || numHMetrics > numGlyphs) {
    throw new Woff2FormatError(`Invalid WOFF2: hhea declares ${numHMetrics} horizontal metrics for ${numGlyphs} glyphs.`);
  }
  const tailCount = numGlyphs - numHMetrics;
  const storedLength = 1 + numHMetrics * BYTES_PER_UINT16 + (hasLsb ? numHMetrics * BYTES_PER_UINT16 : 0) + (hasTail ? tailCount * BYTES_PER_UINT16 : 0);
  if (data.length !== storedLength) {
    throw new Woff2FormatError(`Invalid WOFF2: the transformed hmtx table is ${data.length} bytes, expected ${storedLength}.`);
  }
  const length = numHMetrics * BYTES_PER_LONG_HOR_METRIC + tailCount * BYTES_PER_UINT16;
  if (length !== expectedLength) {
    throw new Woff2FormatError(`Invalid WOFF2: hmtx reconstructs to ${length} bytes but the directory declares ${expectedLength}.`);
  }
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  const source = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const advanceAt = 1;
  const lsbAt = advanceAt + numHMetrics * BYTES_PER_UINT16;
  const tailAt = lsbAt + (hasLsb ? numHMetrics * BYTES_PER_UINT16 : 0);
  for (let i = 0; i < numHMetrics; i++) {
    view.setUint16(i * BYTES_PER_LONG_HOR_METRIC, source.getUint16(advanceAt + i * BYTES_PER_UINT16));
    view.setInt16(i * BYTES_PER_LONG_HOR_METRIC + BYTES_PER_UINT16, hasLsb ? source.getInt16(lsbAt + i * BYTES_PER_UINT16) : xMin[i]);
  }
  const tailOut = numHMetrics * BYTES_PER_LONG_HOR_METRIC;
  for (let i = 0; i < tailCount; i++) {
    view.setInt16(tailOut + i * BYTES_PER_UINT16, hasTail ? source.getInt16(tailAt + i * BYTES_PER_UINT16) : xMin[numHMetrics + i]);
  }
  return out;
}
