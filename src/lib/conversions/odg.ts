import JSZip from 'jszip';

const ODG_MIMETYPE = 'application/vnd.oasis.opendocument.graphics';
const PICTURE_PATH = 'Pictures/image1.png';
const PICTURE_MIMETYPE = 'image/png';
const CSS_PIXELS_PER_INCH = 96;
const CM_PER_INCH = 2.54;
/** Longest page side. Larger rasters are scaled down so the page stays within what editors open. */
const MAX_PAGE_SIDE_CM = 100;
const CM_DECIMALS = 3;

const NAMESPACES = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
  'xmlns:xlink="http://www.w3.org/1999/xlink"',
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
].join(' ');
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
const MASTER_PAGE_NAME = 'Default';
const PAGE_LAYOUT_NAME = 'PageLayout1';
const MASTER_BACKGROUND_STYLE = 'Mdp1';

/** Page size in centimetres for a raster of the given pixel size, at 96 dpi and capped at MAX_PAGE_SIDE_CM. */
function pageSizeCm(widthPx: number, heightPx: number): { width: string; height: string } {
  const naturalScale = CM_PER_INCH / CSS_PIXELS_PER_INCH;
  const scale = Math.min(naturalScale, MAX_PAGE_SIDE_CM / Math.max(widthPx, heightPx));
  return {
    width: `${(widthPx * scale).toFixed(CM_DECIMALS)}cm`,
    height: `${(heightPx * scale).toFixed(CM_DECIMALS)}cm`,
  };
}

/**
 * Builds an OpenDocument Drawing package with one page that holds the PNG picture as a full-page
 * frame (draw:frame + draw:image), stored under Pictures/ and listed in the manifest.
 */
export async function buildOdgPackage(png: Buffer, widthPx: number, heightPx: number): Promise<Buffer> {
  const size = pageSizeCm(widthPx, heightPx);
  const zip = new JSZip();
  const entry = { createFolders: false };
  // The mimetype entry comes first and is stored uncompressed, as the OpenDocument packaging rules require.
  zip.file('mimetype', ODG_MIMETYPE, { ...entry, compression: 'STORE' });
  zip.file(
    'META-INF/manifest.xml',
    `${XML_DECLARATION}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">` +
      `<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="${ODG_MIMETYPE}"/>` +
      '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
      '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
      `<manifest:file-entry manifest:full-path="${PICTURE_PATH}" manifest:media-type="${PICTURE_MIMETYPE}"/>` +
      '</manifest:manifest>',
    entry
  );
  zip.file(
    'styles.xml',
    `${XML_DECLARATION}<office:document-styles ${NAMESPACES} office:version="1.2">` +
      '<office:automatic-styles>' +
      `<style:page-layout style:name="${PAGE_LAYOUT_NAME}"><style:page-layout-properties fo:margin-top="0cm" fo:margin-bottom="0cm" fo:margin-left="0cm" fo:margin-right="0cm" fo:page-width="${size.width}" fo:page-height="${size.height}"/></style:page-layout>` +
      `<style:style style:name="${MASTER_BACKGROUND_STYLE}" style:family="drawing-page"><style:drawing-page-properties draw:background-size="border" draw:fill="none"/></style:style>` +
      '</office:automatic-styles>' +
      '<office:styles><style:default-style style:family="graphic"/></office:styles>' +
      `<office:master-styles><style:master-page style:name="${MASTER_PAGE_NAME}" style:page-layout-name="${PAGE_LAYOUT_NAME}" draw:style-name="${MASTER_BACKGROUND_STYLE}"/></office:master-styles>` +
      '</office:document-styles>',
    entry
  );
  zip.file(
    'content.xml',
    `${XML_DECLARATION}<office:document-content ${NAMESPACES} office:version="1.2">` +
      '<office:automatic-styles><style:style style:name="gr1" style:family="graphic"><style:graphic-properties draw:stroke="none" draw:fill="none"/></style:style></office:automatic-styles>' +
      `<office:body><office:drawing><draw:page draw:name="page1" draw:master-page-name="${MASTER_PAGE_NAME}">` +
      `<draw:frame draw:style-name="gr1" draw:name="image1" svg:x="0cm" svg:y="0cm" svg:width="${size.width}" svg:height="${size.height}">` +
      `<draw:image xlink:href="${PICTURE_PATH}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>` +
      '</draw:frame></draw:page></office:drawing></office:body></office:document-content>',
    entry
  );
  zip.file(PICTURE_PATH, png, entry);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
