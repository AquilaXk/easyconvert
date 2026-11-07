import { once } from 'node:events';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';

/**
 * The scanlines of a non-interlaced PNG, read one row at a time: the zlib stream of the IDAT chunks is inflated in bounded chunks and each
 * row is unfiltered (PNG filter types 0 to 4, ISO/IEC 15948 section 9) against the row before it. Nothing here holds more than two rows, a
 * batch of output rows per plane and the compressed output, so a picture of any size costs no per-byte JavaScript values (PDFKit's PNG
 * reader keeps every byte of the stream in an array).
 */

const FILTER_SUB = 1;
const FILTER_UP = 2;
const FILTER_AVERAGE = 3;
const FILTER_PAETH = 4;
/** About this many bytes of rows are collected before they are handed to the deflater. */
const PLANE_BATCH_BYTES = 256 * 1024;

function paeth(left: number, above: number, aboveLeft: number): number {
  const estimate = left + above - aboveLeft;
  const toLeft = Math.abs(estimate - left);
  const toAbove = Math.abs(estimate - above);
  const toAboveLeft = Math.abs(estimate - aboveLeft);
  if (toLeft <= toAbove && toLeft <= toAboveLeft) return left;
  return toAbove <= toAboveLeft ? above : aboveLeft;
}

/** Undoes the filter of `row` in place; `prior` is the unfiltered row above it (zeros for the first), `step` the bytes of one pixel (at least 1). */
function unfilterRow(filter: number, row: Uint8Array, prior: Uint8Array, step: number): void {
  const length = row.length;
  switch (filter) {
    case 0:
      return;
    case FILTER_SUB:
      for (let i = step; i < length; i += 1) row[i] = (row[i] + row[i - step]) & 0xff;
      return;
    case FILTER_UP:
      for (let i = 0; i < length; i += 1) row[i] = (row[i] + prior[i]) & 0xff;
      return;
    case FILTER_AVERAGE:
      for (let i = 0; i < length; i += 1) row[i] = (row[i] + (((i >= step ? row[i - step] : 0) + prior[i]) >> 1)) & 0xff;
      return;
    case FILTER_PAETH:
      for (let i = 0; i < length; i += 1) {
        const left = i >= step ? row[i - step] : 0;
        const aboveLeft = i >= step ? prior[i - step] : 0;
        row[i] = (row[i] + paeth(left, prior[i], aboveLeft)) & 0xff;
      }
      return;
    default:
      throw new Error(`PNG filter type ${filter} is not defined`);
  }
}

/** Calls `onRow` with each unfiltered row of the image, top to bottom; the row is reused, so `onRow` uses it before it returns. */
export async function scanRows(
  idat: readonly Buffer[],
  width: number,
  height: number,
  bitsPerPixel: number,
  onRow: (row: Uint8Array) => Promise<void> | void
): Promise<void> {
  const step = Math.max(1, bitsPerPixel >> 3);
  const lineBytes = Math.ceil((width * bitsPerPixel) / 8) + 1;
  let line = Buffer.alloc(lineBytes);
  let prior = Buffer.alloc(lineBytes);
  let filled = 0;
  let rows = 0;
  const inflated = Readable.from(idat, { objectMode: false }).pipe(zlib.createInflate());
  for await (const chunk of inflated as AsyncIterable<Buffer>) {
    // The image is `height` rows; leaving the loop destroys the decoder, so data past them (a bomb) is never inflated.
    if (rows >= height) break;
    let at = 0;
    while (at < chunk.length && rows < height) {
      const taken = Math.min(chunk.length - at, lineBytes - filled);
      chunk.copy(line, filled, at, at + taken);
      filled += taken;
      at += taken;
      if (filled === lineBytes) {
        const row = line.subarray(1);
        unfilterRow(line[0], row, prior.subarray(1), step);
        await onRow(row);
        [line, prior] = [prior, line];
        filled = 0;
        rows += 1;
      }
    }
  }
  if (rows < height) throw new Error('PNG image data ends before its last row');
}

/** Rows written one by one into a zlib stream (the default level, as PDFKit's deflate), the compressed bytes kept. */
class DeflatedPlane {
  private readonly stream = zlib.createDeflate();
  private readonly parts: Buffer[] = [];
  private readonly finished: Promise<Buffer>;
  private readonly batchBytes: number;
  private batch: Buffer;
  private used = 0;

  constructor(private readonly rowBytes: number) {
    this.batchBytes = rowBytes * Math.max(1, Math.floor(PLANE_BATCH_BYTES / rowBytes));
    this.batch = Buffer.allocUnsafe(this.batchBytes);
    this.stream.on('data', (part: Buffer) => this.parts.push(part));
    this.finished = new Promise((resolve, reject) => {
      this.stream.on('end', () => resolve(Buffer.concat(this.parts)));
      this.stream.on('error', reject);
    });
    // A failure is thrown by whoever awaits the stream (a write or `finish`); this keeps it from also being reported as unhandled.
    this.finished.catch(() => undefined);
  }

  /** The space the next row is written to. */
  nextRow(): Buffer {
    return this.batch.subarray(this.used, this.used + this.rowBytes);
  }

  async commitRow(): Promise<void> {
    this.used += this.rowBytes;
    if (this.used === this.batchBytes) await this.flush();
  }

  private async flush(): Promise<void> {
    const full = this.batch.subarray(0, this.used);
    // The deflater reads the chunk later, so the next rows go to a new buffer.
    this.batch = Buffer.allocUnsafe(this.batchBytes);
    this.used = 0;
    if (full.length > 0 && !this.stream.write(full)) await once(this.stream, 'drain');
  }

  async finish(): Promise<Buffer> {
    await this.flush();
    this.stream.end();
    return this.finished;
  }
}

export interface AlphaPlanes {
  /** The colour channels as one zlib stream, 8 bits each. */
  color: Buffer;
  /** The alpha channel as one zlib stream, 8 bits per pixel. */
  alpha: Buffer;
}

/**
 * The colour and alpha planes of a grey+alpha or RGBA PNG (`colors` 1 or 3, `bits` 8 or 16), as PDFKit separates them: a 16-bit sample is
 * reduced to its most significant byte, each plane is deflated on its own.
 */
export async function splitAlphaPlanes(idat: readonly Buffer[], width: number, height: number, colors: number, bits: number): Promise<AlphaPlanes> {
  const sampleBytes = bits >> 3;
  const color = new DeflatedPlane(width * colors);
  const alpha = new DeflatedPlane(width);
  await scanRows(idat, width, height, (colors + 1) * bits, async (row) => {
    const colorRow = color.nextRow();
    const alphaRow = alpha.nextRow();
    let from = 0;
    let to = 0;
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < colors; channel += 1) {
        colorRow[to++] = row[from];
        from += sampleBytes;
      }
      alphaRow[x] = row[from];
      from += sampleBytes;
    }
    await Promise.all([color.commitRow(), alpha.commitRow()]);
  });
  const [colorStream, alphaStream] = await Promise.all([color.finish(), alpha.finish()]);
  return { color: colorStream, alpha: alphaStream };
}

/** The alpha of each pixel of a palette PNG (`bits` 1, 2, 4 or 8), looked up from the palette index, as one zlib stream of 8-bit samples. */
export async function paletteAlphaPlane(idat: readonly Buffer[], width: number, height: number, bits: number, alphaOfIndex: Uint8Array): Promise<Buffer> {
  const plane = new DeflatedPlane(width);
  const mask = (1 << bits) - 1;
  await scanRows(idat, width, height, bits, async (row) => {
    const alphaRow = plane.nextRow();
    for (let x = 0; x < width; x += 1) {
      const bit = x * bits;
      alphaRow[x] = alphaOfIndex[(row[bit >> 3] >> (8 - bits - (bit & 7))) & mask];
    }
    await plane.commitRow();
  });
  return plane.finish();
}
