/**
 * Independent oracles for the in-process camera RAW decoders (Sigma X3F and Raspberry Pi frames).
 *
 * Nothing here imports the decoders: the container readers below are separate, minimal parsers
 * written from the file layouts, and the pixel oracle is the camera's own embedded preview JPEG,
 * rendered by the camera's firmware. A decoded image is compared with it region by region.
 */
import sharp from 'sharp';

const JPEG_SOI = [0xff, 0xd8, 0xff];

export interface ContainerInfo {
  /** The camera's own preview, a complete JPEG file. */
  previewJpeg: Buffer;
  /** Frame size the file declares for the finished image (X3F header, Pi mode name). */
  declaredWidth: number;
  declaredHeight: number;
  /** Full sensor array size, including margins, when the file declares it. */
  sensorWidth: number;
  sensorHeight: number;
  /** Offset of the first byte of compressed or packed sensor data. */
  sensorDataOffset: number;
  /** X3F: byte length of the sensor section including its 28-byte image header; 0 for Pi frames. */
  sensorSectionLength: number;
  /** X3F: the sensor section's image type and format words (for example 3 / 0x1e); 0 for Pi frames. */
  sensorImageType: number;
  sensorFormat: number;
}

function startsWithJpegSoi(buffer: Buffer, at: number): boolean {
  return JPEG_SOI.every((byte, index) => buffer[at + index] === byte);
}

/** X3F: header columns/rows, directory walked from the pointer in the last four bytes. */
export function readX3fContainer(file: Buffer): ContainerInfo {
  if (file.toString('latin1', 0, 4) !== 'FOVb') throw new Error('not an X3F file');
  // Version 4 headers (Quattro) hold the finished image size 12 bytes further on than earlier ones.
  const major = file.readUInt16LE(6);
  const sizeAt = major >= 4 ? 40 : 28;
  const headerColumns = file.readUInt32LE(sizeAt);
  const headerRows = file.readUInt32LE(sizeAt + 4);
  const directory = file.readUInt32LE(file.length - 4);
  if (file.toString('latin1', directory, directory + 4) !== 'SECd') throw new Error('X3F directory marker missing');
  const count = file.readUInt32LE(directory + 8);
  let preview: Buffer | null = null;
  let sensor: { columns: number; rows: number; dataOffset: number; length: number; imageType: number; format: number } | null = null;
  for (let index = 0; index < count; index += 1) {
    const entry = directory + 12 + index * 12;
    const offset = file.readUInt32LE(entry);
    const length = file.readUInt32LE(entry + 4);
    const tag = file.toString('latin1', entry + 8, entry + 12);
    if (tag !== 'IMA2' && tag !== 'IMAG') continue;
    const imageType = file.readUInt32LE(offset + 8);
    const columns = file.readUInt32LE(offset + 16);
    const rows = file.readUInt32LE(offset + 20);
    const payload = offset + 28;
    // Sensor data is image type 3 (DP, SD14) or 1 (Merrill, Quattro); type 2 holds the previews.
    if (imageType === 3 || imageType === 1) {
      sensor = { columns, rows, dataOffset: payload, length, imageType, format: file.readUInt32LE(offset + 12) };
    } else if (startsWithJpegSoi(file, payload) && columns === headerColumns && rows === headerRows) {
      // The preview with the finished image's size, not the small thumbnail.
      preview = file.subarray(payload, offset + length);
    }
  }
  if (!preview || !sensor) throw new Error('X3F preview or sensor section missing');
  return {
    previewJpeg: preview,
    declaredWidth: headerColumns,
    declaredHeight: headerRows,
    sensorWidth: sensor.columns,
    sensorHeight: sensor.rows,
    sensorDataOffset: sensor.dataOffset,
    sensorSectionLength: sensor.length,
    sensorImageType: sensor.imageType,
    sensorFormat: sensor.format,
  };
}

/** Raspberry Pi: JPEG, then a 32768-byte "BRCM" block that gives the frame size. */
export function readPiFrame(file: Buffer): ContainerInfo & { stride: number } {
  // The JPEG preview may itself contain the letters "BRCM" (maker notes): the block is the occurrence
  // whose length word (offset 8) is the header size minus the magic.
  let trailer = file.indexOf('BRCM', 0, 'latin1');
  while (trailer >= 0 && file.readUInt32LE(trailer + 8) !== 32764) trailer = file.indexOf('BRCM', trailer + 1, 'latin1');
  if (trailer < 0) throw new Error('no BRCM block');
  // Frame size: named in the mode string for the older sensors ("2592x1944Slow"); otherwise the two
  // copies of the geometry in the block (0xd0/0xd2 and 0x10e/0x110) must agree.
  const mode = /^(\d+)x(\d+)/.exec(file.toString('latin1', trailer + 0xb0, trailer + 0xb0 + 32));
  const width = file.readUInt16LE(trailer + 0xd0);
  const height = file.readUInt16LE(trailer + 0xd2);
  if (width !== file.readUInt16LE(trailer + 0x10e) || height !== file.readUInt16LE(trailer + 0x110)) throw new Error('BRCM geometry copies disagree');
  if (mode && (Number(mode[1]) !== width || Number(mode[2]) !== height)) throw new Error('BRCM mode name disagrees with the geometry');
  const stride = file.readUInt32LE(trailer + 0xa0);
  return {
    previewJpeg: file.subarray(0, trailer),
    declaredWidth: width,
    declaredHeight: height,
    sensorWidth: width,
    sensorHeight: height,
    sensorDataOffset: trailer + 32768,
    sensorSectionLength: 0,
    sensorImageType: 0,
    sensorFormat: 0,
    stride,
  };
}

const REGION_GRID = 6;
const LUMA_RED = 0.2126;
const LUMA_GREEN = 0.7152;
const LUMA_BLUE = 0.0722;

interface Rgb8 {
  data: Buffer;
  width: number;
  height: number;
}

async function rgbPixels(image: sharp.Sharp): Promise<Rgb8> {
  const { data, info } = await image.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Mean R, G, B (0..255) of each cell of a REGION_GRID x REGION_GRID grid. */
function regionMeans(image: Rgb8): number[][] {
  const cellWidth = Math.floor(image.width / REGION_GRID);
  const cellHeight = Math.floor(image.height / REGION_GRID);
  const cells: number[][] = [];
  for (let row = 0; row < REGION_GRID; row += 1) {
    for (let column = 0; column < REGION_GRID; column += 1) {
      const sums = [0, 0, 0];
      for (let y = row * cellHeight; y < (row + 1) * cellHeight; y += 1) {
        for (let x = column * cellWidth; x < (column + 1) * cellWidth; x += 1) {
          const at = (y * image.width + x) * 3;
          sums[0] += image.data[at];
          sums[1] += image.data[at + 1];
          sums[2] += image.data[at + 2];
        }
      }
      cells.push(sums.map((sum) => sum / (cellWidth * cellHeight)));
    }
  }
  return cells;
}

const luma = (cell: number[]) => LUMA_RED * cell[0] + LUMA_GREEN * cell[1] + LUMA_BLUE * cell[2];
/** Red and blue shares of the cell's total: chromaticity without brightness. */
const chromaticity = (cell: number[]) => {
  const total = cell[0] + cell[1] + cell[2];
  return [cell[0] / total, cell[2] / total];
};
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Average ranks (ties share the mean of their positions) of the values. */
function ranksOf(values: number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  for (let start = 0; start < order.length; ) {
    let end = start;
    while (end + 1 < order.length && order[end + 1].value === order[start].value) end += 1;
    for (let k = start; k <= end; k += 1) ranks[order[k].index] = (start + end) / 2;
    start = end + 1;
  }
  return ranks;
}

/** Pearson correlation of the ranks: Spearman's rho. */
function spearman(a: number[], b: number[]): number {
  const ra = ranksOf(a);
  const rb = ranksOf(b);
  const ma = mean(ra);
  const mb = mean(rb);
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let k = 0; k < ra.length; k += 1) {
    covariance += (ra[k] - ma) * (rb[k] - mb);
    varianceA += (ra[k] - ma) ** 2;
    varianceB += (rb[k] - mb) ** 2;
  }
  return covariance / Math.sqrt(varianceA * varianceB);
}

export interface RegionComparison {
  /** Largest per-cell difference of luma divided by the image's own mean luma (exposure-invariant). */
  lumaRatioError: number;
  /** Largest per-cell chromaticity difference after removing each image's mean cast. */
  chromaRelativeError: number;
  /** Largest per-cell chromaticity difference without removing the cast. */
  chromaAbsoluteError: number;
  /**
   * Spearman rank correlation of the 36 cell lumas (1 = identical ordering). A monotonic tone curve, which
   * is what a camera's rendering applies, leaves it at 1, so it separates tone curves from wrong content.
   */
  lumaRankCorrelation: number;
}

/**
 * Compares a decoded image (any format sharp reads) with the camera's preview JPEG: the decoded
 * image is centre-cropped to the preview's aspect ratio, resized to the preview's size, and both are
 * reduced to a 6x6 grid of region means.
 */
export async function compareWithPreview(decoded: Buffer, previewJpeg: Buffer): Promise<RegionComparison> {
  const preview = await rgbPixels(sharp(previewJpeg));
  const meta = await sharp(decoded).metadata();
  const width = meta.width!;
  const height = meta.height!;
  const cropHeight = Math.min(height, Math.round((width * preview.height) / preview.width));
  const cropWidth = Math.min(width, Math.round((height * preview.width) / preview.height));
  const aligned = await rgbPixels(
    sharp(decoded)
      .extract({
        left: Math.floor((width - cropWidth) / 2),
        top: Math.floor((height - cropHeight) / 2),
        width: cropWidth,
        height: cropHeight,
      })
      .resize(preview.width, preview.height, { fit: 'fill', kernel: 'lanczos3' })
  );
  const previewCells = regionMeans(preview);
  const decodedCells = regionMeans(aligned);

  const previewLuma = previewCells.map(luma);
  const decodedLuma = decodedCells.map(luma);
  const previewMean = mean(previewLuma);
  const decodedMean = mean(decodedLuma);
  const previewChroma = previewCells.map(chromaticity);
  const decodedChroma = decodedCells.map(chromaticity);
  const previewCast = [0, 1].map((k) => mean(previewChroma.map((c) => c[k])));
  const decodedCast = [0, 1].map((k) => mean(decodedChroma.map((c) => c[k])));

  let lumaRatioError = 0;
  let chromaRelativeError = 0;
  let chromaAbsoluteError = 0;
  for (let cell = 0; cell < previewCells.length; cell += 1) {
    lumaRatioError = Math.max(lumaRatioError, Math.abs(previewLuma[cell] / previewMean - decodedLuma[cell] / decodedMean));
    for (let k = 0; k < 2; k += 1) {
      chromaAbsoluteError = Math.max(chromaAbsoluteError, Math.abs(previewChroma[cell][k] - decodedChroma[cell][k]));
      chromaRelativeError = Math.max(
        chromaRelativeError,
        Math.abs(previewChroma[cell][k] - previewCast[k] - (decodedChroma[cell][k] - decodedCast[k]))
      );
    }
  }
  return { lumaRatioError, chromaRelativeError, chromaAbsoluteError, lumaRankCorrelation: spearman(previewLuma, decodedLuma) };
}
