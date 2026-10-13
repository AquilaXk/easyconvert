import JSZip from 'jszip';

/**
 * Small OOXML packages that hold one chart, written from ECMA-376 (the chart part with cached values, the drawing or
 * graphic frame that places it, and the relationships between them), for the tests of the chart text of every office format.
 */

export interface TestChart {
  type: 'bar' | 'pie';
  title?: string;
  valueAxisTitle?: string;
  categoryAxisTitle?: string;
  categories: readonly string[];
  series: ReadonlyArray<{ name: string; values: readonly number[] }>;
}

const C_NS = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const COLUMN_LETTERS = 'BCDEFGHIJ';

const titleXml = (text: string | undefined): string =>
  text === undefined ? '' : `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;

function seriesXml(chart: TestChart): string {
  return chart.series
    .map((series, index) => {
      const column = COLUMN_LETTERS[index];
      const last = chart.categories.length + 1;
      const categories = chart.categories.map((category, i) => `<c:pt idx="${i}"><c:v>${category}</c:v></c:pt>`).join('');
      const values = series.values.map((value, i) => `<c:pt idx="${i}"><c:v>${value}</c:v></c:pt>`).join('');
      return (
        `<c:ser><c:idx val="${index}"/><c:order val="${index}"/>` +
        `<c:tx><c:strRef><c:f>Sheet1!$${column}$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${series.name}</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
        `<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$${last}</c:f><c:strCache><c:ptCount val="${chart.categories.length}"/>${categories}</c:strCache></c:strRef></c:cat>` +
        `<c:val><c:numRef><c:f>Sheet1!$${column}$2:$${column}$${last}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${series.values.length}"/>${values}</c:numCache></c:numRef></c:val></c:ser>`
      );
    })
    .join('');
}

export function chartPart(chart: TestChart): string {
  const plot =
    chart.type === 'pie'
      ? `<c:pieChart><c:varyColors val="1"/>${seriesXml(chart)}</c:pieChart>`
      : `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>${seriesXml(chart)}<c:axId val="1"/><c:axId val="2"/></c:barChart>` +
        `<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>${titleXml(chart.categoryAxisTitle)}<c:crossAx val="2"/></c:catAx>` +
        `<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/>${titleXml(chart.valueAxisTitle)}<c:crossAx val="1"/></c:valAx>`;
  return `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace ${C_NS}><c:chart>${titleXml(chart.title)}<c:plotArea><c:layout/>${plot}</c:plotArea><c:legend><c:legendPos val="r"/></c:legend><c:plotVisOnly val="1"/></c:chart></c:chartSpace>`;
}

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const rels = (...entries: Array<[string, string, string]>): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL_NS}">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${OFFICE_REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;

const CONTENT_TYPE_HEAD =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>';
const override = (part: string, type: string): string => `<Override PartName="${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}"/>`;

/** A workbook whose one sheet holds `rows` and a drawing with the chart. */
export async function xlsxWithChart(rows: ReadonlyArray<readonly string[]>, chart: TestChart): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `${CONTENT_TYPE_HEAD}${override('/xl/workbook.xml', 'spreadsheetml.sheet.main+xml')}${override('/xl/worksheets/sheet1.xml', 'spreadsheetml.worksheet+xml')}${override('/xl/drawings/drawing1.xml', 'drawing+xml')}${override('/xl/charts/chart1.xml', 'drawingml.chart+xml')}</Types>`
  );
  zip.file('_rels/.rels', rels(['rId1', 'officeDocument', 'xl/workbook.xml']));
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${OFFICE_REL}"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', rels(['rId1', 'worksheet', 'worksheets/sheet1.xml']));
  const sheetRows = rows.map((row, r) => `<row r="${r + 1}">${row.map((text, c) => `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${text}</t></is></c>`).join('')}</row>`).join('');
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${OFFICE_REL}"><sheetData>${sheetRows}</sheetData><drawing r:id="rId1"/></worksheet>`);
  zip.file('xl/worksheets/_rels/sheet1.xml.rels', rels(['rId1', 'drawing', '../drawings/drawing1.xml']));
  zip.file(
    'xl/drawings/drawing1.xml',
    `<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${OFFICE_REL}"><xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>8</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>24</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`
  );
  zip.file('xl/drawings/_rels/drawing1.xml.rels', rels(['rId1', 'chart', '../charts/chart1.xml']));
  zip.file('xl/charts/chart1.xml', chartPart(chart));
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** A document of one paragraph and the chart. */
export async function docxWithChart(paragraph: string, chart: TestChart): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `${CONTENT_TYPE_HEAD}${override('/word/document.xml', 'wordprocessingml.document.main+xml')}${override('/word/charts/chart1.xml', 'drawingml.chart+xml')}</Types>`);
  zip.file('_rels/.rels', rels(['rId1', 'officeDocument', 'word/document.xml']));
  zip.file('word/_rels/document.xml.rels', rels(['rId1', 'chart', 'charts/chart1.xml']));
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${OFFICE_REL}"><w:body><w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:inline><wp:extent cx="5486400" cy="3200400"/><wp:docPr id="1" name="Chart"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId1"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>`
  );
  zip.file('word/charts/chart1.xml', chartPart(chart));
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** A one-slide presentation with a title text box and the chart. */
export async function pptxWithChart(title: string, chart: TestChart): Promise<Buffer> {
  const zip = new JSZip();
  const ns = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
  const tree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';
  zip.file(
    '[Content_Types].xml',
    `${CONTENT_TYPE_HEAD}${override('/ppt/presentation.xml', 'presentationml.presentation.main+xml')}${override('/ppt/slideMasters/slideMaster1.xml', 'presentationml.slideMaster+xml')}${override('/ppt/slideLayouts/slideLayout1.xml', 'presentationml.slideLayout+xml')}${override('/ppt/slides/slide1.xml', 'presentationml.slide+xml')}${override('/ppt/theme/theme1.xml', 'theme+xml')}${override('/ppt/charts/chart1.xml', 'drawingml.chart+xml')}</Types>`
  );
  zip.file('_rels/.rels', rels(['rId1', 'officeDocument', 'ppt/presentation.xml']));
  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${ns}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', rels(['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'slide', 'slides/slide1.xml'], ['rId3', 'theme', 'theme/theme1.xml']));
  zip.file('ppt/slideMasters/slideMaster1.xml', `<?xml version="1.0" encoding="UTF-8"?><p:sldMaster ${ns}><p:cSld><p:spTree>${tree}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`);
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels(['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']));
  zip.file('ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0" encoding="UTF-8"?><p:sldLayout ${ns} type="blank"><p:cSld><p:spTree>${tree}</p:spTree></p:cSld></p:sldLayout>`);
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels(['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']));
  const colour = (name: string, hex: string): string => `<a:${name}><a:srgbClr val="${hex}"/></a:${name}>`;
  const fills = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3);
  const lines = '<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'.repeat(3);
  zip.file(
    'ppt/theme/theme1.xml',
    `<?xml version="1.0" encoding="UTF-8"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="t"><a:themeElements><a:clrScheme name="c">${colour('dk1', '000000')}${colour('lt1', 'FFFFFF')}${colour('dk2', '1F497D')}${colour('lt2', 'EEECE1')}${['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'].map((name) => colour(name, '4F81BD')).join('')}${colour('hlink', '0000FF')}${colour('folHlink', '800080')}</a:clrScheme><a:fontScheme name="f"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="s"><a:fillStyleLst>${fills}</a:fillStyleLst><a:lnStyleLst>${lines}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${fills}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`
  );
  zip.file(
    'ppt/slides/slide1.xml',
    `<?xml version="1.0" encoding="UTF-8"?><p:sld ${ns}><p:cSld><p:spTree>${tree}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="228600"/><a:ext cx="8229600" cy="609600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US"/><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp><p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="1143000"/><a:ext cx="8229600" cy="4572000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId2"/></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`
  );
  zip.file('ppt/slides/_rels/slide1.xml.rels', rels(['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'chart', '../charts/chart1.xml']));
  zip.file('ppt/charts/chart1.xml', chartPart(chart));
  return zip.generateAsync({ type: 'nodebuffer' });
}
