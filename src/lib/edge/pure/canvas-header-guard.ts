import { EdgeUnsupportedError } from '../workers/worker-errors';

/**
 * Bounded single-pass binary header inspection for the browser Canvas 2D fast-path (L0).
 *
 * `createImageBitmap` + `OffscreenCanvas` rasterizes one 8-bit sRGB frame and discards container
 * metadata. Inputs carrying multiple animation frames (GIF87a/89a, WebP VP8X/ANIM, APNG `acTL`),
 * >8-bit channel precision (16-bit PNG, 12-bit/CMYK JPEG), or embedded colour profiles / EXIF /
 * XMP / IPTC metadata (unless `stripMetadata === true`) throw `EdgeUnsupportedError` so the tier
 * router escalates cleanly to the server engine (`sharp` / `MozJPEG` / `libwebp`).
 *
 * Reference specifications:
 *  - W3C GIF89a Specification §§18-27 (Logical Screen, Image Descriptor 0x2C, Sub-blocks)
 *  - Google libwebp Container Specification (RIFF/WEBP VP8X flags: Animation 0x02, XMP 0x04, EXIF 0x08, ICCP 0x20)
 *  - W3C PNG 3rd Edition §§5, 11.2.2, 11.3.3 (`IHDR`, `acTL`, `iCCP`, `cICP`, `eXIf`, `iTXt`/`zTXt`/`tEXt`)
 *  - ITU-T T.81 / Exif 2.32 / ICC.1 (`APP1` Exif/XMP, `APP2` ICC_PROFILE/MPF, `APP13` IPTC, `SOFn` precision/CMYK)
 */

/**
 * WebKit HTMLCanvasElement universal 16,777,216 pixel limit (4096 * 4096 = 64 MiB RGBA backing
 * store) and WebP VP8X / GPU maxTextureDimension2D 16,384 side ceiling.
 */
export const MAX_BROWSER_CANVAS_SIDE = 16_384;
export const MAX_BROWSER_CANVAS_PIXELS = 16_777_216;

export function assertBrowserCanvasDimensions(width: number, height: number, label = 'Image'): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_BROWSER_CANVAS_SIDE ||
    height > MAX_BROWSER_CANVAS_SIDE ||
    width * height > MAX_BROWSER_CANVAS_PIXELS
  ) {
    throw new EdgeUnsupportedError(
      `${label} dimensions (${width}x${height}) exceed browser Canvas 2D limits; escalating to the server encoder.`
    );
  }
}

const RASTER_SCAN_LIMIT_BYTES = 1024 * 1024;
const GIF_SCAN_LIMIT_BYTES = 8 * 1024 * 1024;
const MAX_CONTAINER_BLOCKS = 65_536;

export const HEX_BACKGROUND_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const PNG_SIG_HI = 0x89504e47;
const PNG_SIG_LO = 0x0d0a1a0a;
const PNG_TAG_IHDR = 0x49484452;
const PNG_TAG_IDAT = 0x49444154;
const PNG_TAG_IEND = 0x49454e44;
const PNG_TAG_ACTL = 0x6163544c;
const PNG_TAG_ICCP = 0x69434350;
const PNG_TAG_CICP = 0x63494350;
const PNG_TAG_EXIF = 0x65584966;
const PNG_TAG_ITXT = 0x69545874;
const PNG_TAG_ZTXT = 0x7a545874;
const PNG_TAG_TEXT = 0x74455874;

const RIFF_TAG = 0x52494646;
const WEBP_TAG = 0x57454250;
const VP8X_TAG = 0x56503858;
const VP8_TAG = 0x56503820;
const VP8L_TAG = 0x5650384c;
const ANIM_TAG = 0x414e494d;
const ANMF_TAG = 0x414e4d46;
const ICCP_TAG = 0x49434350;
const EXIF_TAG = 0x45584946;
const XMP_TAG = 0x584d5020;

const WEBP_FLAG_ANIMATION = 0x02;
const WEBP_FLAG_METADATA_MASK = 0x20 | 0x08 | 0x04;

function matchesAsciiAt(bytes: Uint8Array, offset: number, ascii: string): boolean {
  if (offset + ascii.length > bytes.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

function skipGifSubBlocks(bytes: Uint8Array, start: number): number {
  let pos = start;
  let blocks = 0;
  while (pos < bytes.length && blocks < MAX_CONTAINER_BLOCKS) {
    const subLen = bytes[pos++];
    if (subLen === 0) return pos;
    pos += subLen;
    blocks++;
  }
  if (blocks >= MAX_CONTAINER_BLOCKS) {
    throw new EdgeUnsupportedError('GIF sub-block count exceeds edge frame-inspection budget; escalating to server.');
  }
  return bytes.length + 1;
}

function assertGifStaticSingleFrame(bytes: Uint8Array, totalSize: number): void {
  if (bytes.length < 13) return;
  if (
    bytes[0] !== 0x47 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x38 ||
    (bytes[4] !== 0x37 && bytes[4] !== 0x39) ||
    bytes[5] !== 0x61
  ) {
    return;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lsdW = view.getUint16(6, true);
  const lsdH = view.getUint16(8, true);
  assertBrowserCanvasDimensions(lsdW, lsdH, 'GIF');

  const lsdPacked = bytes[10];
  let pos = 13 + ((lsdPacked & 0x80) !== 0 ? 3 * (1 << ((lsdPacked & 0x07) + 1)) : 0);
  let frames = 0;
  let steps = 0;

  while (pos < bytes.length && steps < MAX_CONTAINER_BLOCKS) {
    steps++;
    const introducer = bytes[pos++];
    if (introducer === 0x3b) return;
    if (introducer === 0x2c) {
      if (pos + 9 > bytes.length) break;
      frames++;
      if (frames > 1) {
        throw new EdgeUnsupportedError('Animated GIF requires the server encoder to preserve all frames.');
      }
      const left = view.getUint16(pos, true);
      const top = view.getUint16(pos + 2, true);
      const frameW = view.getUint16(pos + 4, true);
      const frameH = view.getUint16(pos + 6, true);
      assertBrowserCanvasDimensions(frameW, frameH, 'GIF frame');
      assertBrowserCanvasDimensions(Math.max(lsdW, left + frameW), Math.max(lsdH, top + frameH), 'GIF');

      const lctPacked = bytes[pos + 8];
      pos += 9 + ((lctPacked & 0x80) !== 0 ? 3 * (1 << ((lctPacked & 0x07) + 1)) : 0);
      if (pos >= bytes.length) break;
      pos = skipGifSubBlocks(bytes, pos + 1);
      continue;
    }
    if (introducer === 0x21) {
      if (pos >= bytes.length) break;
      pos = skipGifSubBlocks(bytes, pos + 1);
      continue;
    }
    return;
  }

  if (steps >= MAX_CONTAINER_BLOCKS) {
    throw new EdgeUnsupportedError('GIF block count exceeds edge frame-inspection budget; escalating to server.');
  }
  if (bytes.length < totalSize) {
    throw new EdgeUnsupportedError('Large GIF exceeds edge frame-inspection budget; escalating to server.');
  }
}

function inspectWebpChunk(
  tag: number,
  bytes: Uint8Array,
  view: DataView,
  payloadOffset: number,
  chunkLen: number,
  stripMetadata: boolean
): void {
  if (tag === VP8X_TAG && chunkLen >= 10 && payloadOffset < bytes.length) {
    const flags = bytes[payloadOffset];
    if ((flags & WEBP_FLAG_ANIMATION) !== 0) {
      throw new EdgeUnsupportedError('Animated WebP requires the server encoder to preserve all frames.');
    }
    if (!stripMetadata && (flags & WEBP_FLAG_METADATA_MASK) !== 0) {
      throw new EdgeUnsupportedError('WebP ICC profile or EXIF/XMP metadata requires the server encoder.');
    }
    if (payloadOffset + 10 <= bytes.length) {
      const width = 1 + (bytes[payloadOffset + 4] | (bytes[payloadOffset + 5] << 8) | (bytes[payloadOffset + 6] << 16));
      const height = 1 + (bytes[payloadOffset + 7] | (bytes[payloadOffset + 8] << 8) | (bytes[payloadOffset + 9] << 16));
      assertBrowserCanvasDimensions(width, height, 'WebP');
    }
    return;
  }
  if (
    tag === VP8_TAG &&
    chunkLen >= 10 &&
    payloadOffset + 10 <= bytes.length &&
    (bytes[payloadOffset] & 1) === 0 &&
    bytes[payloadOffset + 3] === 0x9d &&
    bytes[payloadOffset + 4] === 0x01 &&
    bytes[payloadOffset + 5] === 0x2a
  ) {
    const width = view.getUint16(payloadOffset + 6, true) & 0x3fff;
    const height = view.getUint16(payloadOffset + 8, true) & 0x3fff;
    assertBrowserCanvasDimensions(width, height, 'WebP');
    return;
  }
  if (tag === VP8L_TAG && chunkLen >= 5 && payloadOffset + 5 <= bytes.length && bytes[payloadOffset] === 0x2f) {
    const bits = view.getUint32(payloadOffset + 1, true);
    const width = 1 + (bits & 0x3fff);
    const height = 1 + ((bits >>> 14) & 0x3fff);
    assertBrowserCanvasDimensions(width, height, 'WebP');
    return;
  }
  if (tag === ANIM_TAG || tag === ANMF_TAG) {
    throw new EdgeUnsupportedError('Animated WebP requires the server encoder to preserve all frames.');
  }
  if (!stripMetadata && (tag === ICCP_TAG || tag === EXIF_TAG || tag === XMP_TAG)) {
    throw new EdgeUnsupportedError('WebP ICC profile or EXIF/XMP metadata requires the server encoder.');
  }
}

function assertWebpSafeForCanvas(bytes: Uint8Array, stripMetadata: boolean): void {
  if (bytes.length < 16) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== RIFF_TAG || view.getUint32(8, false) !== WEBP_TAG) return;

  let pos = 12;
  let chunks = 0;
  while (pos + 8 <= bytes.length && chunks < MAX_CONTAINER_BLOCKS) {
    chunks++;
    const tag = view.getUint32(pos, false);
    const chunkLen = view.getUint32(pos + 4, true);
    const payloadOffset = pos + 8;

    inspectWebpChunk(tag, bytes, view, payloadOffset, chunkLen, stripMetadata);

    const padded = chunkLen + (chunkLen & 1);
    if (padded > bytes.length - payloadOffset) break;
    pos = payloadOffset + padded;
  }

  if (chunks >= MAX_CONTAINER_BLOCKS) {
    throw new EdgeUnsupportedError('WebP chunk count exceeds edge inspection budget; escalating to the server encoder.');
  }
}

function isXmpOrProfileTextChunk(bytes: Uint8Array, payloadOffset: number, chunkLen: number): boolean {
  if (chunkLen < 17 || payloadOffset + 17 > bytes.length) return false;
  return (
    matchesAsciiAt(bytes, payloadOffset, 'XML:com.adobe.xmp') ||
    matchesAsciiAt(bytes, payloadOffset, 'Raw profile type ')
  );
}

function assertPngSafeForCanvas(bytes: Uint8Array, totalSize: number, stripMetadata: boolean): void {
  if (bytes.length < 29) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== PNG_SIG_HI || view.getUint32(4, false) !== PNG_SIG_LO) return;

  let pos = 8;
  let chunks = 0;
  let sawIdat = false;
  let sawIend = false;

  while (pos + 12 <= bytes.length && chunks < MAX_CONTAINER_BLOCKS) {
    chunks++;
    const chunkLen = view.getUint32(pos, false);
    const tag = view.getUint32(pos + 4, false);
    const payloadOffset = pos + 8;

    if (tag === PNG_TAG_IHDR && chunkLen >= 13 && payloadOffset + 9 <= bytes.length) {
      const width = view.getUint32(payloadOffset, false);
      const height = view.getUint32(payloadOffset + 4, false);
      assertBrowserCanvasDimensions(width, height, 'PNG');
      if (bytes[payloadOffset + 8] > 8) {
        throw new EdgeUnsupportedError('16-bit PNG requires the server encoder to preserve channel precision.');
      }
    } else if (tag === PNG_TAG_ACTL) {
      throw new EdgeUnsupportedError('Animated PNG requires the server encoder.');
    } else if (tag === PNG_TAG_IDAT) {
      sawIdat = true;
    } else if (tag === PNG_TAG_IEND) {
      sawIend = true;
      break;
    } else if (!stripMetadata) {
      if (tag === PNG_TAG_ICCP || tag === PNG_TAG_CICP || tag === PNG_TAG_EXIF) {
        throw new EdgeUnsupportedError('PNG colour profile or EXIF metadata requires the server encoder.');
      }
      if (
        (tag === PNG_TAG_ITXT || tag === PNG_TAG_ZTXT || tag === PNG_TAG_TEXT) &&
        isXmpOrProfileTextChunk(bytes, payloadOffset, chunkLen)
      ) {
        throw new EdgeUnsupportedError('PNG XMP metadata requires the server encoder.');
      }
    }

    if (chunkLen > bytes.length - (pos + 12)) break;
    pos += 12 + chunkLen;
  }

  if (chunks >= MAX_CONTAINER_BLOCKS && !sawIend) {
    throw new EdgeUnsupportedError('PNG chunk count exceeds edge inspection budget; escalating to the server encoder.');
  }
  if (bytes.length < totalSize && !sawIend) {
    if (!stripMetadata) {
      throw new EdgeUnsupportedError(
        'Large PNG exceeds the 1 MiB header inspection window and may carry post-IDAT metadata; escalating to the server encoder.'
      );
    }
    if (!sawIdat) {
      throw new EdgeUnsupportedError(
        'Large PNG pre-IDAT header exceeds the 1 MiB inspection window; escalating to the server encoder.'
      );
    }
  }
}

/** 16-bit bitmask of JPEG SOF0..SOF15 markers (0xC0..0xCF excluding DHT 0xC4, JPG 0xC8, DAC 0xCC). */
const SOF_MARKER_MASK = 0xeeef;

function isSofMarker(marker: number): boolean {
  const offset = marker - 0xc0;
  return offset >= 0 && offset < 16 && ((SOF_MARKER_MASK >>> offset) & 1) === 1;
}

function hasJpegTaggedMetadata(marker: number, bytes: Uint8Array, payloadOffset: number): boolean {
  if (marker === 0xe1) {
    return (
      matchesAsciiAt(bytes, payloadOffset, 'Exif\0\0') ||
      matchesAsciiAt(bytes, payloadOffset, 'http://ns.adobe.com/xap/1.0/\0') ||
      matchesAsciiAt(bytes, payloadOffset, 'http://ns.adobe.com/xmp/extension/\0')
    );
  }
  if (marker === 0xe2) {
    return matchesAsciiAt(bytes, payloadOffset, 'ICC_PROFILE\0') || matchesAsciiAt(bytes, payloadOffset, 'MPF\0');
  }
  return marker === 0xed && matchesAsciiAt(bytes, payloadOffset, 'Photoshop 3.0\0');
}

function inspectJpegSegment(
  marker: number,
  bytes: Uint8Array,
  payloadOffset: number,
  segLen: number,
  stripMetadata: boolean
): boolean {
  if (isSofMarker(marker) && segLen >= 8) {
    if (bytes[payloadOffset] > 8 || bytes[payloadOffset + 5] === 4) {
      throw new EdgeUnsupportedError('High-bit-depth or CMYK JPEG requires the server encoder.');
    }
    const height = (bytes[payloadOffset + 1] << 8) | bytes[payloadOffset + 2];
    const width = (bytes[payloadOffset + 3] << 8) | bytes[payloadOffset + 4];
    assertBrowserCanvasDimensions(width, height, 'JPEG');
    return true;
  }
  if (!stripMetadata && hasJpegTaggedMetadata(marker, bytes, payloadOffset)) {
    throw new EdgeUnsupportedError('JPEG colour profile or EXIF/XMP/IPTC metadata requires the server encoder.');
  }
  return false;
}

function assertJpegSafeForCanvas(bytes: Uint8Array, totalSize: number, stripMetadata: boolean): void {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return;

  let pos = 2;
  let segments = 0;
  let sawSof = false;
  let sawSosOrEoi = false;

  while (pos < bytes.length && segments < MAX_CONTAINER_BLOCKS) {
    segments++;
    while (pos < bytes.length && bytes[pos] === 0xff) pos++;
    if (pos >= bytes.length) break;
    const marker = bytes[pos++];
    if (marker === 0x00) break;
    if (marker === 0xd9 || marker === 0xda) {
      sawSosOrEoi = true;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (pos + 2 > bytes.length) break;

    const segLen = (bytes[pos] << 8) | bytes[pos + 1];
    if (segLen < 2 || pos + segLen > bytes.length) break;
    if (inspectJpegSegment(marker, bytes, pos + 2, segLen, stripMetadata)) {
      sawSof = true;
    }
    pos += segLen;
  }

  if (segments >= MAX_CONTAINER_BLOCKS) {
    throw new EdgeUnsupportedError('JPEG segment count exceeds edge inspection budget; escalating to the server encoder.');
  }
  if (bytes.length < totalSize && (!sawSof || (!stripMetadata && !sawSosOrEoi))) {
    throw new EdgeUnsupportedError('Large JPEG header exceeds edge inspection window; escalating to the server encoder.');
  }
}

function assertBmpSafeForCanvas(bytes: Uint8Array): void {
  if (bytes.length < 22 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dibSize = view.getUint32(14, true);
  if (dibSize === 12) {
    const width = view.getUint16(18, true);
    const height = view.getUint16(20, true);
    assertBrowserCanvasDimensions(width, height, 'BMP');
    return;
  }
  if (dibSize >= 16 && bytes.length >= 26) {
    const width = view.getInt32(18, true);
    const rawHeight = view.getInt32(22, true);
    if (rawHeight === -0x80000000) {
      throw new EdgeUnsupportedError('BMP dimensions exceed browser Canvas 2D limits; escalating to the server encoder.');
    }
    assertBrowserCanvasDimensions(width, Math.abs(rawHeight), 'BMP');
  }
}

export async function assertCanvasInputSupported(
  input: Blob | Uint8Array,
  sourceFormat: string,
  stripMetadata: boolean
): Promise<void> {
  const totalSize = input instanceof Blob ? input.size : input.byteLength;
  const maxBytes = sourceFormat === 'gif' ? GIF_SCAN_LIMIT_BYTES : RASTER_SCAN_LIMIT_BYTES;
  const probe =
    input instanceof Blob
      ? new Uint8Array(await input.slice(0, Math.min(totalSize, maxBytes)).arrayBuffer())
      : input.subarray(0, Math.min(totalSize, maxBytes));

  assertGifStaticSingleFrame(probe, totalSize);
  assertWebpSafeForCanvas(probe, stripMetadata);
  assertPngSafeForCanvas(probe, totalSize, stripMetadata);
  assertJpegSafeForCanvas(probe, totalSize, stripMetadata);
  assertBmpSafeForCanvas(probe);
}
