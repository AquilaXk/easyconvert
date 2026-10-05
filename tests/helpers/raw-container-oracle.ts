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
}

function startsWithJpegSoi(buffer: Buffer, at: number): boolean {
  return JPEG_SOI.every((byte, index) => buffer[at + index] === byte);
}

/** X3F: header columns/rows, directory walked from the pointer in the last four bytes. */
export function readX3fContainer(file: Buffer): ContainerInfo {
  if (file.toString('latin1', 0, 4) !== 'FOVb') throw new Error('not an X3F file');
  const headerColumns = file.readUInt32LE(28);
  const headerRows = file.readUInt32LE(32);
  const directory = file.readUInt32LE(file.length - 4);
  if (file.toString('latin1', directory, directory + 4) !== 'SECd') throw new Error('X3F directory marker missing');
  const count = file.readUInt32LE(directory + 8);
  let preview: Buffer | null = null;
  let sensor: { columns: number; rows: number; dataOffset: number } | null = null;
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
    if (imageType === 3) {
      sensor = { columns, rows, dataOffset: payload };
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
  };
}

/** Raspberry Pi: JPEG, then a 32768-byte "BRCM" block whose mode name ("2592x1944Slow") gives the frame size. */
export function readPiFrame(file: Buffer): ContainerInfo & { stride: number } {
  const trailer = file.indexOf('BRCM', 0, 'latin1');
  if (trailer < 0) throw new Error('no BRCM block');
  const mode = /^(\d+)x(\d+)/.exec(file.toString('latin1', trailer + 0xb0, trailer + 0xb0 + 32));
  if (!mode) throw new Error('BRCM block has no mode name');
  const stride = file.readUInt32LE(trailer + 0xa0);
  return {
    previewJpeg: file.subarray(0, trailer),
    declaredWidth: Number(mode[1]),
    declaredHeight: Number(mode[2]),
    sensorWidth: Number(mode[1]),
    sensorHeight: Number(mode[2]),
    sensorDataOffset: trailer + 32768,
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

export interface RegionComparison {
  /** Largest per-cell difference of luma divided by the image's own mean luma (exposure-invariant). */
  lumaRatioError: number;
  /** Largest per-cell chromaticity difference after removing each image's mean cast. */
  chromaRelativeError: number;
  /** Largest per-cell chromaticity difference without removing the cast. */
  chromaAbsoluteError: number;
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
  return { lumaRatioError, chromaRelativeError, chromaAbsoluteError };
}
