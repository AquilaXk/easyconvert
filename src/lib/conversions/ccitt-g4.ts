/**
 * CCITT Group 4 (ITU-T T.6, two-dimensional) encoder for bitonal rasters.
 *
 * Written from the recommendation: each row is coded against the row above it (the reference line, an all-white
 * row for the first) with the pass, horizontal and vertical modes of T.6 clause 2.2, and runs use the white and
 * black terminating and make-up code tables of T.4 (Tables 2 and 3), which T.6 reuses. The strip ends with the
 * EOFB code (two EOL codes). The output is a PDF `/CCITTFaxDecode` stream with `/K -1`, `/BlackIs1 false`.
 */

/** Bits in a byte, for the packed-raster arithmetic. */
const BITS_PER_BYTE = 8;
/** Longest run one make-up code covers; longer runs repeat this code (T.4 clause 4.1.3). */
const LONGEST_MAKEUP_RUN = 2560;
/** Make-up codes exist for multiples of this run length. */
const MAKEUP_STEP = 64;
/** First run length of the make-up codes shared by both colours. */
const FIRST_EXTENDED_MAKEUP_RUN = 1792;
/** Largest distance in pixels between a1 and b1 that vertical mode can code. */
const MAX_VERTICAL_OFFSET = 3;
/** Pixel value of white in a packed 1-bit gray raster (a clear bit is black, as in PNG and PDF DeviceGray). */
const WHITE_BYTE = 0xff;
/** A byte of eight black pixels. */
const BLACK_BYTE = 0x00;
/** Bit index mask within a byte. */
const BIT_INDEX_MASK = 7;
/** Bytes per row shift: eight pixels per byte. */
const BYTE_SHIFT = 3;
/** Bits of the accumulator that are flushed to the output at a time. */
const FLUSH_BITS = 8;

/** Thrown for a raster whose shape does not match the data given. */
export class CcittRasterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CcittRasterError';
  }
}

interface Code {
  readonly bits: number;
  readonly length: number;
}

function code(pattern: string): Code {
  return { bits: Number.parseInt(pattern, 2), length: pattern.length };
}

/** T.4 Table 2: terminating codes for white runs of 0 to 63. */
const WHITE_TERMINATING = [
  '00110101', '000111', '0111', '1000', '1011', '1100', '1110', '1111',
  '10011', '10100', '00111', '01000', '001000', '000011', '110100', '110101',
  '101010', '101011', '0100111', '0001100', '0001000', '0010111', '0000011', '0000100',
  '0101000', '0101011', '0010011', '0100100', '0011000', '00000010', '00000011', '00011010',
  '00011011', '00010010', '00010011', '00010100', '00010101', '00010110', '00010111', '00101000',
  '00101001', '00101010', '00101011', '00101100', '00101101', '00000100', '00000101', '00001010',
  '00001011', '01010010', '01010011', '01010100', '01010101', '00100100', '00100101', '01011000',
  '01011001', '01011010', '01011011', '01001010', '01001011', '00110010', '00110011', '00110100',
].map(code);

/** T.4 Table 2: terminating codes for black runs of 0 to 63. */
const BLACK_TERMINATING = [
  '0000110111', '010', '11', '10', '011', '0011', '0010', '00011',
  '000101', '000100', '0000100', '0000101', '0000111', '00000100', '00000111', '000011000',
  '0000010111', '0000011000', '0000001000', '00001100111', '00001101000', '00001101100', '00000110111', '00000101000',
  '00000010111', '00000011000', '000011001010', '000011001011', '000011001100', '000011001101', '000001101000', '000001101001',
  '000001101010', '000001101011', '000011010010', '000011010011', '000011010100', '000011010101', '000011010110', '000011010111',
  '000001101100', '000001101101', '000011011010', '000011011011', '000001010100', '000001010101', '000001010110', '000001010111',
  '000001100100', '000001100101', '000001010010', '000001010011', '000000100100', '000000110111', '000000111000', '000000100111',
  '000000101000', '000001011000', '000001011001', '000000101011', '000000101100', '000001011010', '000001100110', '000001100111',
].map(code);

/** T.4 Table 3: make-up codes for white runs of 64, 128, ... 1728. */
const WHITE_MAKEUP = [
  '11011', '10010', '010111', '0110111', '00110110', '00110111', '01100100', '01100101',
  '01101000', '01100111', '011001100', '011001101', '011010010', '011010011', '011010100', '011010101',
  '011010110', '011010111', '011011000', '011011001', '011011010', '011011011', '010011000', '010011001',
  '010011010', '011000', '010011011',
].map(code);

/** T.4 Table 3: make-up codes for black runs of 64, 128, ... 1728. */
const BLACK_MAKEUP = [
  '0000001111', '000011001000', '000011001001', '000001011011', '000000110011', '000000110100', '000000110101', '0000001101100',
  '0000001101101', '0000001001010', '0000001001011', '0000001001100', '0000001001101', '0000001110010', '0000001110011', '0000001110100',
  '0000001110101', '0000001110110', '0000001110111', '0000001010010', '0000001010011', '0000001010100', '0000001010101', '0000001011010',
  '0000001011011', '0000001100100', '0000001100101',
].map(code);

/** T.4 Table 3: make-up codes for runs of 1792, 1856, ... 2560, the same for both colours. */
const EXTENDED_MAKEUP = [
  '00000001000', '00000001100', '00000001101', '000000010010', '000000010011', '000000010100', '000000010101',
  '000000010110', '000000010111', '000000011100', '000000011101', '000000011110', '000000011111',
].map(code);

const PASS_CODE = code('0001');
const HORIZONTAL_CODE = code('001');
/** Vertical mode codes for a1 - b1 of -3 to +3 (T.6 Table 1), indexed by offset + 3. */
const VERTICAL_CODES = ['0000010', '000010', '010', '1', '011', '000011', '0000011'].map(code);
/** End of facsimile block: two EOL codes (T.6 clause 2.4). */
const EOFB_CODE = code('000000000001000000000001');

/** Appends bit codes to a byte array, giving up when the output would pass `maxBytes`. */
class BitSink {
  private bytes: Uint8Array;
  private used = 0;
  private accumulator = 0;
  private pending = 0;

  constructor(private readonly maxBytes: number) {
    this.bytes = new Uint8Array(Math.min(maxBytes, 4096));
  }

  /** False when `maxBytes` has been passed; the caller stops encoding. */
  get overflowed(): boolean {
    return this.used > this.maxBytes;
  }

  put(value: Code): void {
    let remaining = value.length;
    while (remaining > 0) {
      const take = Math.min(remaining, FLUSH_BITS - this.pending);
      const chunk = (value.bits >>> (remaining - take)) & ((1 << take) - 1);
      this.accumulator = (this.accumulator << take) | chunk;
      this.pending += take;
      remaining -= take;
      if (this.pending === FLUSH_BITS) {
        this.pushByte(this.accumulator);
        this.accumulator = 0;
        this.pending = 0;
      }
    }
  }

  private pushByte(byte: number): void {
    if (this.used >= this.maxBytes) {
      this.used = this.maxBytes + 1;
      return;
    }
    if (this.used === this.bytes.length) {
      const grown = new Uint8Array(Math.min(this.maxBytes, this.bytes.length * 2));
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.used++] = byte;
  }

  /** Pads the last byte with zero bits and returns the bytes, or null once `maxBytes` was passed. */
  finish(): Uint8Array | null {
    if (this.pending > 0) {
      this.pushByte(this.accumulator << (FLUSH_BITS - this.pending));
      this.accumulator = 0;
      this.pending = 0;
    }
    return this.overflowed ? null : this.bytes.subarray(0, this.used);
  }
}

/** Writes one run of `length` pixels of one colour: make-up codes, then the terminating code. */
function putRun(sink: BitSink, length: number, black: boolean): void {
  let remaining = length;
  while (remaining >= LONGEST_MAKEUP_RUN) {
    sink.put(EXTENDED_MAKEUP[EXTENDED_MAKEUP.length - 1]);
    remaining -= LONGEST_MAKEUP_RUN;
  }
  if (remaining >= MAKEUP_STEP) {
    const multiple = Math.floor(remaining / MAKEUP_STEP);
    if (remaining >= FIRST_EXTENDED_MAKEUP_RUN) {
      sink.put(EXTENDED_MAKEUP[multiple - FIRST_EXTENDED_MAKEUP_RUN / MAKEUP_STEP]);
    } else {
      sink.put((black ? BLACK_MAKEUP : WHITE_MAKEUP)[multiple - 1]);
    }
    remaining -= multiple * MAKEUP_STEP;
  }
  sink.put((black ? BLACK_TERMINATING : WHITE_TERMINATING)[remaining]);
}

/**
 * Lists the changing elements of a row (T.6 clause 2.1): the position of each pixel whose colour differs from
 * the pixel before it, the pixel before the first being white. Returns how many were found; the list ends with
 * `width` sentinels so a lookup past the last change reads the end of the row.
 */
function changingElements(row: Uint8Array, width: number, out: Int32Array): number {
  let count = 0;
  let black = false;
  let x = 0;
  while (x < width) {
    // A byte equal to the current run's fill byte carries no change, so whole bytes are skipped.
    if (x % BITS_PER_BYTE === 0 && x + BITS_PER_BYTE <= width && row[x / BITS_PER_BYTE] === (black ? BLACK_BYTE : WHITE_BYTE)) {
      x += BITS_PER_BYTE;
      continue;
    }
    const pixelIsBlack = ((row[x >> BYTE_SHIFT] >> (BITS_PER_BYTE - 1 - (x & BIT_INDEX_MASK))) & 1) === 0;
    if (pixelIsBlack !== black) {
      out[count++] = x;
      black = pixelIsBlack;
    }
    x++;
  }
  out[count] = width;
  out[count + 1] = width;
  out[count + 2] = width;
  return count;
}

export interface BitonalRaster {
  readonly width: number;
  readonly height: number;
  /** Rows of `ceil(width / 8)` bytes, most significant bit first; a clear bit is a black pixel. */
  readonly data: Uint8Array;
}

/**
 * Encodes `raster` as one CCITT G4 strip, or returns null when the strip would be longer than `maxBytes` (the
 * caller then keeps the other encoding). Output memory never exceeds `maxBytes`.
 */
export function encodeCcittG4(raster: BitonalRaster, maxBytes: number): Uint8Array | null {
  const { width, height, data } = raster;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new CcittRasterError(`A CCITT raster needs a positive integer size, got ${width}x${height}`);
  }
  const rowBytes = Math.ceil(width / BITS_PER_BYTE);
  if (data.length !== rowBytes * height) {
    throw new CcittRasterError(`A ${width}x${height} bitonal raster is ${rowBytes * height} bytes, got ${data.length}`);
  }
  const sink = new BitSink(maxBytes);
  // Changing elements plus the three sentinels.
  let reference = new Int32Array(width + 3);
  let current = new Int32Array(width + 3);
  let referenceCount = 0;
  reference[0] = width;
  reference[1] = width;
  reference[2] = width;

  for (let y = 0; y < height; y++) {
    const currentCount = changingElements(data.subarray(y * rowBytes, (y + 1) * rowBytes), width, current);
    codeRow(sink, current, currentCount, reference, referenceCount, width);
    if (sink.overflowed) return null;
    [reference, current] = [current, reference];
    referenceCount = currentCount;
  }
  sink.put(EOFB_CODE);
  return sink.finish();
}

/** Codes one row against its reference line with the T.6 algorithm (clause 2.2). */
function codeRow(
  sink: BitSink,
  current: Int32Array,
  currentCount: number,
  reference: Int32Array,
  referenceCount: number,
  width: number
): void {
  let a0 = -1;
  let black = false;
  // Index of the first changing element to the right of a0, on each line. a0 only moves right, so both only advance.
  let currentIndex = 0;
  let referenceIndex = 0;
  while (a0 < width) {
    while (currentIndex < currentCount && current[currentIndex] <= a0) currentIndex++;
    while (referenceIndex < referenceCount && reference[referenceIndex] <= a0) referenceIndex++;
    // a1 is the next change on the coding line; b1 the first change on the reference line to the right of a0
    // that goes to the colour opposite a0's, which is every other element, even indexes being white to black.
    const a1 = current[currentIndex];
    let b1Index = referenceIndex;
    if (b1Index % 2 !== (black ? 1 : 0)) b1Index++;
    const b1 = b1Index < referenceCount ? reference[b1Index] : width;
    const b2 = b1Index + 1 < referenceCount ? reference[b1Index + 1] : width;
    const offset = a1 - b1;

    if (b2 < a1) {
      sink.put(PASS_CODE);
      a0 = b2;
    } else if (Math.abs(offset) <= MAX_VERTICAL_OFFSET) {
      sink.put(VERTICAL_CODES[offset + MAX_VERTICAL_OFFSET]);
      a0 = a1;
      black = !black;
    } else {
      const a2 = currentIndex + 1 < currentCount ? current[currentIndex + 1] : width;
      sink.put(HORIZONTAL_CODE);
      putRun(sink, a1 - Math.max(a0, 0), black);
      putRun(sink, a2 - a1, !black);
      a0 = a2;
    }
    if (sink.overflowed) return;
  }
}
