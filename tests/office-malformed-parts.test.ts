import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { ConversionFailedError, DataParseError } from '../src/lib/types';

/**
 * The document readers pick values out of a part with tag patterns, which read a part that is cut off mid-tag
 * as "no content" and let the conversion succeed with an empty result. Each reader must refuse a body part
 * that is not well-formed XML, and must still read the same package when the part is intact: every case below
 * converts a valid hand-written package first, then the same package with its body part cut off.
 */

const ODF_MIMETYPE_PARTS = {
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odt: 'application/vnd.oasis.opendocument.text',
  odp: 'application/vnd.oasis.opendocument.presentation',
} as const;

const ODF_NAMESPACES =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"';

async function odfPackage(kind: keyof typeof ODF_MIMETYPE_PARTS, body: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', ODF_MIMETYPE_PARTS[kind], { compression: 'STORE' });
  zip.file(
    'META-INF/manifest.xml',
    `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">` +
      `<manifest:file-entry manifest:full-path="/" manifest:media-type="${ODF_MIMETYPE_PARTS[kind]}"/>` +
      `<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`
  );
  zip.file('content.xml', `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODF_NAMESPACES}>${body}</office:document-content>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const ODS_BODY =
  '<office:body><office:spreadsheet><table:table table:name="Sheet1">' +
  '<table:table-row><table:table-cell office:value-type="string"><text:p>Item</text:p></table:table-cell>' +
  '<table:table-cell office:value-type="string"><text:p>Qty</text:p></table:table-cell></table:table-row>' +
  '<table:table-row><table:table-cell office:value-type="string"><text:p>Bolt</text:p></table:table-cell>' +
  '<table:table-cell office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell></table:table-row>' +
  '</table:table></office:spreadsheet></office:body>';
const ODT_BODY = '<office:body><office:text><text:p>First paragraph</text:p><text:p>Second paragraph</text:p></office:text></office:body>';
const ODP_BODY =
  '<office:body><office:presentation><draw:page draw:name="page1"><draw:frame><draw:text-box><text:p>Slide one title</text:p></draw:text-box></draw:frame></draw:page>' +
  '</office:presentation></office:body>';

const NOT_WELL_FORMED = (partName: string, label: string) =>
  new RegExp(`^Invalid ${label} package: ${partName.replace('.', '\\.').replace('/', '\\/')} is not well-formed XML`);

describe('office readers refuse a body part that is not well-formed XML', () => {
  const cases = [
    { kind: 'ods', target: 'csv', body: ODS_BODY, expectedText: 'Item,Qty\nBolt,7' },
    { kind: 'odt', target: 'txt', body: ODT_BODY, expectedText: 'First paragraph\n\nSecond paragraph' },
    { kind: 'odp', target: 'txt', body: ODP_BODY, expectedText: '--- Slide 1 ---\nSlide one title' },
  ] as const;

  for (const { kind, target, body, expectedText } of cases) {
    it(`${kind} -> ${target}: reads the intact package, refuses the cut-off one`, async () => {
      const intact = await convertFile(await odfPackage(kind, body), kind, target, {}, `sample.${kind}`);
      expect(intact.buffer.toString('utf-8').trim()).toBe(expectedText);

      // The same body, cut off inside the last element.
      const cutOff = await odfPackage(kind, body.slice(0, body.length - 40));
      const failure = await convertFile(cutOff, kind, target, {}, `sample.${kind}`).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(DataParseError);
      expect((failure as Error).message).toMatch(NOT_WELL_FORMED('content.xml', kind.toUpperCase()));
    });
  }

  it('docx -> txt: reads the intact package, refuses a cut-off word/document.xml', async () => {
    const build = async (documentXml: string) => {
      const zip = new JSZip();
      zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
      zip.file('word/document.xml', documentXml);
      return zip.generateAsync({ type: 'nodebuffer' });
    };
    const body =
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello body</w:t></w:r></w:p></w:body></w:document>';

    const intact = await convertFile(await build(body), 'docx', 'txt', {}, 'sample.docx');
    expect(intact.buffer.toString('utf-8').trim()).toBe('Hello body');

    const failure = await convertFile(await build(body.slice(0, body.length - 30)), 'docx', 'txt', {}, 'sample.docx').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DataParseError);
    expect((failure as Error).message).toMatch(NOT_WELL_FORMED('word/document.xml', 'DOCX'));
  });

  it('pptx -> txt: refuses a slide part that is cut off', async () => {
    const build = async (slideXml: string) => {
      const zip = new JSZip();
      zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
      zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>');
      zip.file('ppt/slides/slide1.xml', slideXml);
      return zip.generateAsync({ type: 'nodebuffer' });
    };
    const slide =
      '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
      '<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Slide title</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>';

    const failure = await convertFile(await build(slide.slice(0, slide.length - 25)), 'pptx', 'txt', {}, 'sample.pptx').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DataParseError);
    expect((failure as Error).message).toMatch(NOT_WELL_FORMED('ppt/slides/slide1.xml', 'PPTX'));
    // A DataParseError is a ConversionFailedError, which the API answers with 400.
    expect(failure).toBeInstanceOf(ConversionFailedError);
  });
});
