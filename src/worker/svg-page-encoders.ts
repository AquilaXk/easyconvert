import { encodeSvgPageToDxf } from '../lib/conversions/vector-dxf';
import { encodeEmf, encodeWmf } from '../lib/conversions/vector-metafile';

/**
 * Targets written from the SVG page that Poppler draws for a page of a PDF: the in-process writers read its geometry and
 * write DXF entities or an EMF or WMF metafile. The registry offers them only for the sources whose pages these writers can
 * represent; a page with a picture or a clip region that is not the page is refused by the writer.
 */
const SVG_PAGE_ENCODERS: Readonly<Record<string, (svg: Buffer) => Buffer>> = {
  dxf: encodeSvgPageToDxf,
  emf: encodeEmf,
  wmf: encodeWmf,
};

export function isSvgPageTarget(target: string): boolean {
  return Object.hasOwn(SVG_PAGE_ENCODERS, target);
}

/** The writer of an SVG page target (see `isSvgPageTarget`). */
export function svgPageEncoder(target: string): (svg: Buffer) => Buffer {
  return SVG_PAGE_ENCODERS[target];
}
