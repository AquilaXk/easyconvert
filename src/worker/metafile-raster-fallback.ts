import sharp from 'sharp';
import type { RegionBitmap } from '../lib/conversions/metafile-bitmap';
import { readMetafilePage, wholePageAsPicture, type MetafilePage } from '../lib/conversions/vector-metafile';
import { isTooComplexToDraw, type PixelRect } from '../lib/conversions/svg-raster-regions';
import { CadGeometryUnavailableError, ConversionFailedError } from '../lib/types';

/**
 * The pictures that stand for the parts of a PDF page an EMF or WMF writer cannot draw (`readMetafilePage`): Poppler draws the whole
 * page once as a PNG, and each region is cut from it. cairo draws its fallback images at 300 pixels per inch by default
 * (`CAIRO_SURFACE_FALLBACK_RESOLUTION_DEFAULT`, `cairoint.h` line 741); this writer takes half of that so that a full letter page is
 * 6.4 MB and not 26 MB, and lowers it for a large region so a page never holds more than `MAX_REGION_PIXELS` of picture.
 */

/** Draws page `page` of the PDF as a PNG at `dpi`. */
export type PageRasterRun = (page: number, dpi: number) => Promise<Buffer>;

/** What the worker's Poppler step is asked for the picture of one page: the page, its density, and the options that make the render a one-page PNG. */
interface PageRasterRequest {
  page: undefined;
  pages: string;
  multiPageOutput: undefined;
  dpi: number;
}

/** The result of that step: the PNG's bytes and where the worker persisted it, if it did. */
type PageRasterConvert = (request: PageRasterRequest) => Promise<{ buffer: Buffer; filePath?: string } | null>;

/** The run that draws one page of the PDF as a PNG at a density, from the worker's Poppler step; `discard` removes the file that step persisted. */
export function pageRasterRun(convert: PageRasterConvert, discard: (filePath: string | undefined) => void): PageRasterRun {
  return async (page, dpi) => {
    const rendered = await convert({ page: undefined, pages: String(page), multiPageOutput: undefined, dpi });
    if (!rendered) throw new ConversionFailedError(`Poppler drew no picture of page ${page}.`);
    try {
      return rendered.buffer;
    } finally {
      discard(rendered.filePath);
    }
  };
}

/** Pixels per inch of the pictures: a page region is drawn this finely when it is small enough. */
export const RASTER_FALLBACK_DPI = 150;
/** The coarsest picture written; a page that would need less is refused (the page renderer takes no lower density). */
export const RASTER_FALLBACK_MIN_DPI = 72;
/** Pixels of picture one page may hold in all its regions: 12 million is 36 MB of colour (the writers cap a file at 50 MB), 5.4 letter pages at 150 dpi, a 48 by 36 inch page at 72. */
export const MAX_REGION_PIXELS = 12_000_000;
/** Pixels of the whole page as Poppler draws it, of which the regions are cut: the page is held decoded at 3 bytes a pixel. */
export const MAX_RENDERED_PAGE_PIXELS = 16_000_000;
const CSS_PX_PER_INCH = 96;
const CHANNELS = 3;

/**
 * A page whose regions need a density below the least, or a render that is not a picture of the page. It is not an
 * `UnsupportedOptionError`: that is what sends a page to the office suite, which draws these pages wrong.
 */
export class RasterFallbackTooLargeError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'RasterFallbackTooLargeError';
  }
}

/** The whole-inch density at which the regions of a page (device pixels at 96 per inch) hold at most `MAX_REGION_PIXELS`, within the bounds of the page's own render. */
export function rasterFallbackDpi(regions: readonly PixelRect[], page: { width: number; height: number }): number {
  const regionArea = regions.reduce((sum, r) => sum + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
  const byRegions = (CSS_PX_PER_INCH * Math.sqrt(MAX_REGION_PIXELS / regionArea));
  const byPage = (CSS_PX_PER_INCH * Math.sqrt(MAX_RENDERED_PAGE_PIXELS / (page.width * page.height)));
  const dpi = Math.floor(Math.min(RASTER_FALLBACK_DPI, byRegions, byPage));
  if (!(dpi >= RASTER_FALLBACK_MIN_DPI)) {
    throw new RasterFallbackTooLargeError(
      `The parts of the page that need a picture would take ${Math.round(regionArea)} device pixels on a page of ${Math.round(page.width)} by ${Math.round(page.height)}: more than ${RASTER_FALLBACK_MIN_DPI} dpi allows within ${MAX_REGION_PIXELS} pixels.`
    );
  }
  return dpi;
}

/** The pixel rectangle of a region in a render that is `scale` render pixels to a device pixel (across and down), on whole render pixels inside the render. */
function sourceRect(rect: PixelRect, scale: { x: number; y: number }, render: { width: number; height: number }): { left: number; top: number; width: number; height: number } {
  const left = Math.max(0, Math.floor(rect.x0 * scale.x));
  const top = Math.max(0, Math.floor(rect.y0 * scale.y));
  const right = Math.min(render.width, Math.ceil(rect.x1 * scale.x));
  const bottom = Math.min(render.height, Math.ceil(rect.y1 * scale.y));
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * The picture of each region, cut from one render of the page. A region is cut on whole pixels of the render and drawn on the device
 * rectangle of exactly those pixels, so a picture is never resampled.
 * @throws RasterFallbackTooLargeError when the regions need more than `MAX_REGION_PIXELS` at the least density.
 */
export async function renderRegionBitmaps(
  regions: readonly PixelRect[],
  page: { width: number; height: number },
  pageNumber: number,
  draw: PageRasterRun
): Promise<RegionBitmap[]> {
  const dpi = rasterFallbackDpi(regions, page);
  const decoded = await sharp(await draw(pageNumber, dpi)).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const render = { width: decoded.info.width, height: decoded.info.height };
  if (decoded.info.channels !== CHANNELS) throw new RasterFallbackTooLargeError(`The page render has ${decoded.info.channels} colour channels, not ${CHANNELS}.`);
  const scaleX = render.width / page.width;
  const scaleY = render.height / page.height;
  return regions.map((rect) => {
    const source = sourceRect(rect, { x: scaleX, y: scaleY }, render);
    const rgb = Buffer.alloc(source.width * source.height * CHANNELS);
    for (let y = 0; y < source.height; y++) {
      const from = ((source.top + y) * render.width + source.left) * CHANNELS;
      decoded.data.copy(rgb, y * source.width * CHANNELS, from, from + source.width * CHANNELS);
    }
    return {
      rect: { x0: source.left / scaleX, y0: source.top / scaleY, x1: (source.left + source.width) / scaleX, y1: (source.top + source.height) / scaleY },
      width: source.width,
      height: source.height,
      rgb,
    };
  });
}

async function writeWithPictures(page: MetafilePage, pageNumber: number, draw: PageRasterRun): Promise<Buffer> {
  return page.write(await renderRegionBitmaps(page.regions, page, pageNumber, draw));
}

/**
 * Page `pageNumber` of a PDF as the in-process writer of `format` writes it, with a picture for each part it cannot draw, and a picture
 * of the whole page when the page is more than the vector writers hold.
 * @throws what `readMetafilePage` throws for a page refused as a whole (malformed, a bitmap font, nothing to draw), which the caller hands to
 * the office suite or refuses.
 */
export async function writeMetafilePageWithPictures(svg: Buffer, format: 'emf' | 'wmf', pageNumber: number, draw: PageRasterRun): Promise<Buffer> {
  let page: MetafilePage;
  try {
    page = readMetafilePage(svg, format);
  } catch (error) {
    if (!(error instanceof CadGeometryUnavailableError) || !isTooComplexToDraw(error)) throw error;
    return writeWithPictures(wholePageAsPicture(svg, format, error), pageNumber, draw);
  }
  if (page.regions.length === 0) return page.write([]);
  try {
    return await writeWithPictures(page, pageNumber, draw);
  } catch (error) {
    if (!(error instanceof CadGeometryUnavailableError) || !isTooComplexToDraw(error)) throw error;
    return writeWithPictures(wholePageAsPicture(svg, format, error), pageNumber, draw);
  }
}
