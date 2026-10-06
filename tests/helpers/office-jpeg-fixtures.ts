import JSZip from 'jszip';
import sharp from 'sharp';

/**
 * Hand-written Office documents that carry one JPEG, two headings and one hyperlink. The JPEG is
 * produced here, so its bytes are the oracle for "the exported PDF kept the image stream": a
 * re-encoding changes the MD5 of the stream, a pass-through does not.
 */

export const FIXTURE_HEADINGS = ['Findings', 'Appendix'] as const;
export const FIXTURE_LINK_URL = 'https://example.com/report';

const JPEG_WIDTH = 320;
const JPEG_HEIGHT = 200;
const JPEG_QUALITY = 92;
const RGB_CHANNELS = 3;
/** Linear congruential generator constants (Numerical Recipes); any fixed noise source works. */
const LCG_MULTIPLIER = 1664525;
const LCG_INCREMENT = 1013904223;
const LCG_MODULUS = 2 ** 32;
const NOISE_AMPLITUDE = 48;
const BYTE_RANGE = 256;
const EMU_PER_PIXEL = 9525;

/** A noisy gradient: a lossy re-encode of it cannot reproduce the original bytes. */
export async function makeNoisyJpeg(): Promise<Buffer> {
  const raw = Buffer.alloc(JPEG_WIDTH * JPEG_HEIGHT * RGB_CHANNELS);
  let state = 1;
  for (let y = 0; y < JPEG_HEIGHT; y++) {
    for (let x = 0; x < JPEG_WIDTH; x++) {
      const offset = (y * JPEG_WIDTH + x) * RGB_CHANNELS;
      state = (Math.imul(state, LCG_MULTIPLIER) + LCG_INCREMENT) % LCG_MODULUS;
      const noise = (state >>> 16) % NOISE_AMPLITUDE;
      raw[offset] = Math.min(BYTE_RANGE - 1, Math.floor((x * BYTE_RANGE) / JPEG_WIDTH) + noise);
      raw[offset + 1] = Math.min(BYTE_RANGE - 1, Math.floor((y * BYTE_RANGE) / JPEG_HEIGHT) + noise);
      raw[offset + 2] = Math.min(BYTE_RANGE - 1, ((x + y) % BYTE_RANGE) + noise);
    }
  }
  return sharp(raw, { raw: { width: JPEG_WIDTH, height: JPEG_HEIGHT, channels: RGB_CHANNELS } })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';

/** Core properties with a creation date, as Office writes them. LibreOffice's PDF/A-1 XMP needs one to match the Info dictionary. */
const CORE_PROPERTIES_PART =
  `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Fixture</dc:title><dc:creator>EasyConvert tests</dc:creator>' +
  '<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-15T09:30:00Z</dcterms:created>' +
  '<dcterms:modified xsi:type="dcterms:W3CDTF">2026-01-15T09:30:00Z</dcterms:modified></cp:coreProperties>';
const CORE_PROPERTIES_RELATIONSHIP = `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>`;
const CORE_PROPERTIES_OVERRIDE =
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>';

export async function buildDocxWithJpeg(jpeg: Buffer): Promise<Buffer> {
  const cx = JPEG_WIDTH * EMU_PER_PIXEL;
  const cy = JPEG_HEIGHT * EMU_PER_PIXEL;
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `${XML_HEADER}<Types xmlns="${NS_CT}">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="jpg" ContentType="image/jpeg"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      `${CORE_PROPERTIES_OVERRIDE}</Types>`
  );
  zip.file(
    '_rels/.rels',
    `${XML_HEADER}<Relationships xmlns="${NS_PKG_REL}">` +
      `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="word/document.xml"/>${CORE_PROPERTIES_RELATIONSHIP}</Relationships>`
  );
  zip.file('docProps/core.xml', CORE_PROPERTIES_PART);
  zip.file(
    'word/_rels/document.xml.rels',
    `${XML_HEADER}<Relationships xmlns="${NS_PKG_REL}">` +
      `<Relationship Id="rId1" Type="${NS_REL}/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId2" Type="${NS_REL}/image" Target="media/image1.jpg"/>` +
      `<Relationship Id="rId3" Type="${NS_REL}/hyperlink" Target="${FIXTURE_LINK_URL}" TargetMode="External"/>` +
      '</Relationships>'
  );
  zip.file(
    'word/styles.xml',
    `${XML_HEADER}<w:styles xmlns:w="${NS_W}">` +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>' +
      '<w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>' +
      '</w:styles>'
  );
  const heading = (text: string) =>
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const image =
    '<w:p><w:r><w:drawing>' +
    `<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="Picture 1"/>` +
    `<a:graphic xmlns:a="${NS_A}"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    '<pic:nvPicPr><pic:cNvPr id="1" name="image1.jpg"/><pic:cNvPicPr/></pic:nvPicPr>' +
    `<pic:blipFill><a:blip xmlns:r="${NS_REL}" r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  const link =
    `<w:p><w:r><w:t xml:space="preserve">Read the full report: </w:t></w:r>` +
    `<w:hyperlink xmlns:r="${NS_REL}" r:id="rId3"><w:r><w:t>example.com/report</w:t></w:r></w:hyperlink></w:p>`;
  const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  zip.file(
    'word/document.xml',
    `${XML_HEADER}<w:document xmlns:w="${NS_W}"><w:body>` +
      heading(FIXTURE_HEADINGS[0]) +
      image +
      link +
      pageBreak +
      heading(FIXTURE_HEADINGS[1]) +
      '<w:p><w:r><w:t>Supporting tables follow.</w:t></w:r></w:p>' +
      '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>' +
      '</w:body></w:document>'
  );
  zip.file('word/media/image1.jpg', jpeg);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** A DOCX with one paragraph per string and no other content (no image, outline or link). */
export async function buildTextDocx(paragraphs: readonly string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `${XML_HEADER}<Types xmlns="${NS_CT}">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      `${CORE_PROPERTIES_OVERRIDE}</Types>`
  );
  zip.file(
    '_rels/.rels',
    `${XML_HEADER}<Relationships xmlns="${NS_PKG_REL}">` +
      `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="word/document.xml"/>${CORE_PROPERTIES_RELATIONSHIP}</Relationships>`
  );
  zip.file('docProps/core.xml', CORE_PROPERTIES_PART);
  const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
  zip.file('word/document.xml', `${XML_HEADER}<w:document xmlns:w="${NS_W}"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const SLIDE_WIDTH_EMU = 9144000;
const SLIDE_HEIGHT_EMU = 6858000;
const SLIDE_PICTURE_OFFSET_EMU = 914400;

export async function buildPptxWithJpeg(jpeg: Buffer): Promise<Buffer> {
  const cx = JPEG_WIDTH * EMU_PER_PIXEL;
  const cy = JPEG_HEIGHT * EMU_PER_PIXEL;
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `${XML_HEADER}<Types xmlns="${NS_CT}">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="jpg" ContentType="image/jpeg"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
      '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
      '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
      '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
      '</Types>'
  );
  zip.file(
    '_rels/.rels',
    `${XML_HEADER}<Relationships xmlns="${NS_PKG_REL}">` +
      `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`
  );
  zip.file(
    'ppt/presentation.xml',
    `${XML_HEADER}<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_REL}" xmlns:p="${NS_P}">` +
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
      '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>' +
      `<p:sldSz cx="${SLIDE_WIDTH_EMU}" cy="${SLIDE_HEIGHT_EMU}"/><p:notesSz cx="${SLIDE_HEIGHT_EMU}" cy="${SLIDE_WIDTH_EMU}"/>` +
      '</p:presentation>'
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `${XML_HEADER}<Relationships xmlns="${NS_PKG_REL}">` +
      `<Relationship Id="rId1" Type="${NS_REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
      `<Relationship Id="rId2" Type="${NS_REL}/slide" Target="slides/slide1.xml"/>` +
      '</Relationships>'
  );
  const emptyTree =
    '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>';
  zip.file(
    'ppt/slideMasters/slideMaster1.xml',
    `${XML_HEADER}<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_REL}" xmlns:p="${NS_P}">${emptyTree}` +
      '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
      '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>'
  );
  zip.file(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    `${XML_HEADER}<Relationships xmlns="${NS_PKG_REL}">` +
      `<Relationship Id="rId1" Type="${NS_REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
      `<Relationship Id="rId2" Type="${NS_REL}/theme" Target="../theme/theme1.xml"/></Relationships>`
  );
  zip.file(
    'ppt/slideLayouts/slideLayout1.xml',
    `${XML_HEADER}<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_REL}" xmlns:p="${NS_P}" type="blank">${emptyTree}</p:sldLayout>`
  );
  zip.file(
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    `${XML_HEADER}<Relationships xmlns="${NS_PKG_REL}">` +
      `<Relationship Id="rId1" Type="${NS_REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`
  );
  zip.file(
    'ppt/theme/theme1.xml',
    `${XML_HEADER}<a:theme xmlns:a="${NS_A}" name="Fixture"><a:themeElements>` +
      '<a:clrScheme name="Fixture"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>' +
      '<a:dk2><a:srgbClr val="1F1F1F"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2>' +
      '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
      '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
      '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
      '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
      '<a:fontScheme name="Fixture"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
      '<a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
      '<a:fmtScheme name="Fixture"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
      '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
      '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
      '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>' +
      '</a:themeElements></a:theme>'
  );
  zip.file(
    'ppt/slides/slide1.xml',
    `${XML_HEADER}<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_REL}" xmlns:p="${NS_P}"><p:cSld><p:spTree>` +
      '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
      '<p:pic><p:nvPicPr><p:cNvPr id="2" name="Picture 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
      '<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
      `<p:spPr><a:xfrm><a:off x="${SLIDE_PICTURE_OFFSET_EMU}" y="${SLIDE_PICTURE_OFFSET_EMU}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>` +
      '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Caption"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
      `<p:spPr><a:xfrm><a:off x="${SLIDE_PICTURE_OFFSET_EMU}" y="${SLIDE_HEIGHT_EMU / 2}"/><a:ext cx="${cx}" cy="${SLIDE_PICTURE_OFFSET_EMU}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
      '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"><a:hlinkClick r:id="rId3"/></a:rPr><a:t>Quarterly results</a:t></a:r></a:p></p:txBody></p:sp>' +
      '</p:spTree></p:cSld></p:sld>'
  );
  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    `${XML_HEADER}<Relationships xmlns="${NS_PKG_REL}">` +
      `<Relationship Id="rId1" Type="${NS_REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
      `<Relationship Id="rId2" Type="${NS_REL}/image" Target="../media/image1.jpg"/>` +
      `<Relationship Id="rId3" Type="${NS_REL}/hyperlink" Target="${FIXTURE_LINK_URL}" TargetMode="External"/>` +
      '</Relationships>'
  );
  zip.file('ppt/media/image1.jpg', jpeg);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
