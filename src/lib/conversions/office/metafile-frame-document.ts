import JSZip from 'jszip';
import type { MetafileFormat, MetafilePage } from '../metafile-page-frame';

/**
 * A drawing whose one page has the size of a metafile's frame and whose one picture is the metafile, filling the page. The
 * office suite's Draw application opens it and its PDF export writes a page of that size, where opening the metafile itself
 * puts the picture at its preferred size on an A4 page (`SdGRFFilter::InsertSdrGrafObj`, LibreOffice
 * `sd/source/filter/grf/sdgrffilter.cxx`: centred, and reduced to fit when larger than the page).
 *
 * The package is an OpenDocument Graphics file (ODF 1.3: part 3 for the package and its manifest; part 1 for the page layout
 * of a master page, `draw:page`, and a `draw:frame` that holds a `draw:image` whose picture is a package part and is drawn in the
 * frame's rectangle). The bytes of the metafile are stored as they are; nothing the file holds is written into the XML, whose
 * text is made of constants and numbers.
 */

const ODG_MIME = 'application/vnd.oasis.opendocument.graphics';
const ODF_VERSION = '1.3';
const PICTURE_MIME: Readonly<Record<MetafileFormat, string>> = { emf: 'image/x-emf', wmf: 'image/x-wmf' };
const PICTURE_DECIMALS = 3;

const NAMESPACES = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
  'xmlns:xlink="http://www.w3.org/1999/xlink"',
].join(' ');
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';

function points(value: number): string {
  return `${value.toFixed(PICTURE_DECIMALS)}pt`;
}

function stylesXml(page: MetafilePage): string {
  const layout =
    '<style:page-layout style:name="PM1"><style:page-layout-properties fo:margin-top="0pt" fo:margin-bottom="0pt" fo:margin-left="0pt" fo:margin-right="0pt" ' +
    `fo:page-width="${points(page.widthPt)}" fo:page-height="${points(page.heightPt)}" style:print-orientation="portrait"/></style:page-layout>`;
  return (
    `${XML_DECLARATION}<office:document-styles ${NAMESPACES} office:version="${ODF_VERSION}">` +
    `<office:styles/><office:automatic-styles>${layout}</office:automatic-styles>` +
    '<office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles></office:document-styles>'
  );
}

function contentXml(page: MetafilePage, picturePath: string): string {
  const frameStyle = '<style:style style:name="gr1" style:family="graphic"><style:graphic-properties draw:stroke="none" draw:fill="none"/></style:style>';
  const frame =
    `<draw:frame draw:style-name="gr1" svg:x="${points(0)}" svg:y="${points(0)}" svg:width="${points(page.widthPt)}" svg:height="${points(page.heightPt)}">` +
    `<draw:image xlink:href="${picturePath}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>`;
  return (
    `${XML_DECLARATION}<office:document-content ${NAMESPACES} office:version="${ODF_VERSION}">` +
    `<office:automatic-styles>${frameStyle}</office:automatic-styles>` +
    `<office:body><office:drawing><draw:page draw:name="page1" draw:master-page-name="Default">${frame}</draw:page></office:drawing></office:body></office:document-content>`
  );
}

function manifestXml(picturePath: string, pictureMime: string): string {
  const entries = [
    `<manifest:file-entry manifest:full-path="/" manifest:version="${ODF_VERSION}" manifest:media-type="${ODG_MIME}"/>`,
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>',
    '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>',
    `<manifest:file-entry manifest:full-path="${picturePath}" manifest:media-type="${pictureMime}"/>`,
  ];
  return `${XML_DECLARATION}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="${ODF_VERSION}">${entries.join('')}</manifest:manifest>`;
}

/** The OpenDocument Graphics package of a metafile on a page of the given size. */
export async function metafileFrameDocument(metafile: Buffer, format: MetafileFormat, page: MetafilePage): Promise<Buffer> {
  const picturePath = `Pictures/metafile.${format}`;
  const zip = new JSZip();
  zip.file('mimetype', ODG_MIME, { compression: 'STORE' });
  zip.file('META-INF/manifest.xml', manifestXml(picturePath, PICTURE_MIME[format]));
  zip.file('styles.xml', stylesXml(page));
  zip.file('content.xml', contentXml(page, picturePath));
  zip.file(picturePath, metafile);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
