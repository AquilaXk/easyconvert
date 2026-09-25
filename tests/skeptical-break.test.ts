import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import { convertFile } from '../src/lib/conversions/index';
import { POST as convertRoute } from '../src/app/api/convert/route';

describe('Skeptical Review: Breaking Prior Implementation', () => {
  it('1. stl -> dxf must generate standard DXF 3DFACE entities without throwing Unsupported target', async () => {
    const stl = `solid TestModel
  facet normal 0 0 1
    outer loop
      vertex 0 0 10
      vertex 10 0 10
      vertex 10 10 10
    endloop
  endfacet
endsolid TestModel`;
    const res = await convertFile(Buffer.from(stl, 'utf-8'), 'stl', 'dxf', {}, 'model.stl');
    expect(res.mimeType).toBe('image/vnd.dxf');
    expect(res.filename).toBe('model.dxf');
    const dxfText = res.buffer.toString('utf-8');
    expect(dxfText).toContain('3DFACE');
    expect(dxfText).toContain('ENTITIES');
  });

  it('2. binary STL must be parsed accurately into real vertices, not dummy cube', async () => {
    // 80 bytes header + 4 bytes triangle count (1) + 50 bytes triangle data
    const buf = Buffer.alloc(84 + 50);
    buf.write('Binary STL Test', 0, 'ascii');
    buf.writeUInt32LE(1, 80); // 1 triangle
    // normal (0, 0, 1)
    buf.writeFloatLE(0, 84);
    buf.writeFloatLE(0, 88);
    buf.writeFloatLE(1, 92);
    // vertex 1 (1.5, 2.5, 3.5)
    buf.writeFloatLE(1.5, 96);
    buf.writeFloatLE(2.5, 100);
    buf.writeFloatLE(3.5, 104);
    // vertex 2 (4.5, 5.5, 6.5)
    buf.writeFloatLE(4.5, 108);
    buf.writeFloatLE(5.5, 112);
    buf.writeFloatLE(6.5, 116);
    // vertex 3 (7.5, 8.5, 9.5)
    buf.writeFloatLE(7.5, 120);
    buf.writeFloatLE(8.5, 124);
    buf.writeFloatLE(9.5, 128);

    const res = await convertFile(buf, 'stl', 'obj', {}, 'binmodel.stl');
    const objText = res.buffer.toString('utf-8');
    expect(objText).toContain('v 1.5 2.5 3.5');
    expect(objText).toContain('v 4.5 5.5 6.5');
    expect(objText).toContain('v 7.5 8.5 9.5');
  });

  it('3. ndjson / jsonl / tab in data category must be converted properly', async () => {
    // NDJSON -> JSON
    const ndjson = '{"id":1,"name":"Alice"}\n{"id":2,"name":"Bob"}';
    const ndjsonRes = await convertFile(Buffer.from(ndjson, 'utf-8'), 'ndjson', 'json', {}, 'users.ndjson');
    expect(ndjsonRes.mimeType).toBe('application/json');
    const parsedNd = JSON.parse(ndjsonRes.buffer.toString('utf-8'));
    expect(parsedNd).toHaveLength(2);
    expect(parsedNd[0].name).toBe('Alice');

    // JSONL -> CSV
    const jsonl = '{"sku":"A1","qty":5}\n{"sku":"B2","qty":10}';
    const jsonlRes = await convertFile(Buffer.from(jsonl, 'utf-8'), 'jsonl', 'csv', {}, 'stock.jsonl');
    expect(jsonlRes.mimeType).toBe('text/csv');
    expect(jsonlRes.buffer.toString('utf-8')).toContain('sku');
    expect(jsonlRes.buffer.toString('utf-8')).toContain('A1');

    // TAB -> CSV
    const tabData = 'col1\tcol2\nval1\tval2';
    const tabRes = await convertFile(Buffer.from(tabData, 'utf-8'), 'tab', 'csv', {}, 'table.tab');
    expect(tabRes.mimeType).toBe('text/csv');
    expect(tabRes.buffer.toString('utf-8')).toContain('col1,col2');
  });

  it('4. xml -> yaml and xml -> csv must succeed without throwing Unsupported', async () => {
    const xml = '<users><user><id>1</id><name>Alice</name></user><user><id>2</id><name>Bob</name></user></users>';
    const yamlRes = await convertFile(Buffer.from(xml, 'utf-8'), 'xml', 'yaml', {}, 'data.xml');
    expect(yamlRes.mimeType).toBe('application/x-yaml');
    expect(yamlRes.buffer.toString('utf-8')).toContain('name: Alice');

    const csvRes = await convertFile(Buffer.from(xml, 'utf-8'), 'xml', 'csv', {}, 'data.xml');
    expect(csvRes.mimeType).toBe('text/csv');
    expect(csvRes.buffer.toString('utf-8')).toContain('Alice');
  });

  it('5. eps -> svg must be routed to Vector engine, not image engine', async () => {
    const eps = `%!PS-Adobe-3.0 EPSF-3.0\n10 10 moveto 100 100 lineto stroke`;
    const res = await convertFile(Buffer.from(eps, 'utf-8'), 'eps', 'svg', {}, 'drawing.eps');
    expect(res.mimeType).toBe('image/svg+xml');
    expect(res.filename).toBe('drawing.svg');
    expect(res.buffer.toString('utf-8')).toContain('<svg');
  });

  it('6. odt -> epub must succeed as declared in FORMAT_REGISTRY', async () => {
    const odtZip = new JSZip();
    odtZip.file('mimetype', 'application/vnd.oasis.opendocument.text');
    odtZip.file('content.xml', '<?xml version="1.0"?><office:document-content><office:body><office:text><text:p>Ebook Paragraph</text:p></office:text></office:body></office:document-content>');
    const odtBuf = await odtZip.generateAsync({ type: 'nodebuffer' });

    const res = await convertFile(odtBuf, 'odt', 'epub', {}, 'novel.odt');
    expect(res.mimeType).toBe('application/epub+zip');
    expect(res.filename).toBe('novel.epub');
  });

  it('7. xls -> tsv and xls -> html must succeed as declared in FORMAT_REGISTRY', async () => {
    const xlsXml = `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Sheet1"><Table><Row><Cell><Data ss:Type="String">Item</Data></Cell><Cell><Data ss:Type="String">Price</Data></Cell></Row><Row><Cell><Data ss:Type="String">Widget</Data></Cell><Cell><Data ss:Type="String">9.99</Data></Cell></Row></Table></Worksheet></Workbook>`;
    const tsvRes = await convertFile(Buffer.from(xlsXml, 'utf-8'), 'xls', 'tsv', {}, 'sheet.xls');
    expect(tsvRes.mimeType).toBe('text/tab-separated-values');
    expect(tsvRes.buffer.toString('utf-8')).toContain('Item\tPrice');

    const htmlRes = await convertFile(Buffer.from(xlsXml, 'utf-8'), 'xls', 'html', {}, 'sheet.xls');
    expect(htmlRes.mimeType).toBe('text/html');
    expect(htmlRes.buffer.toString('utf-8')).toContain('Widget');
  });

  it('8. csv with quoted commas converted to ods must preserve cells without mangling columns', async () => {
    const csv = 'Name,Department,Salary\n"Doe, Jane",Sales,"$100,000"';
    const res = await convertFile(Buffer.from(csv, 'utf-8'), 'csv', 'ods', {}, 'payroll.csv');
    const zip = await JSZip.loadAsync(res.buffer);
    const content = await zip.file('content.xml')!.async('text');
    expect(content).toContain('Doe, Jane');
    expect(content).toContain('$100,000');
  });

  it('9. POST /api/convert with 0-byte file must fail closed with 400 Bad Request', async () => {
    const formData = new FormData();
    formData.append('file', new File([''], 'empty.csv', { type: 'text/csv' }));
    formData.append('targetFormat', 'json');

    const req = new NextRequest('http://localhost/api/convert', {
      method: 'POST',
      body: formData,
    });

    const res = await convertRoute(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('10. POST /api/convert with unsupported target format must fail closed with 400 Bad Request', async () => {
    const formData = new FormData();
    formData.append('file', new File(['col1,col2'], 'valid.csv', { type: 'text/csv' }));
    formData.append('targetFormat', 'unsupported_extension_xyz');

    const req = new NextRequest('http://localhost/api/convert', {
      method: 'POST',
      body: formData,
    });

    const res = await convertRoute(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('11. pdf -> png, svg, dxf, rtf must succeed without throwing Unsupported document conversion', async () => {
    // Create a minimal PDF buffer
    const chunks: Buffer[] = [];
    const doc = new PDFDocument();
    doc.on('data', (c) => chunks.push(c));
    const pdfPromise = new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
    });
    doc.fontSize(14).text('EasyConvert PDF Render Test Page');
    doc.end();
    const pdfBuf = await pdfPromise;

    // PDF -> PNG
    const pngRes = await convertFile(pdfBuf, 'pdf', 'png', {}, 'sample.pdf');
    expect(pngRes.mimeType).toBe('image/png');
    expect(pngRes.size).toBeGreaterThan(0);

    // PDF -> SVG
    const svgRes = await convertFile(pdfBuf, 'pdf', 'svg', {}, 'sample.pdf');
    expect(svgRes.mimeType).toBe('image/svg+xml');
    expect(svgRes.buffer.toString('utf-8')).toContain('<svg');

    // PDF -> DXF
    const dxfRes = await convertFile(pdfBuf, 'pdf', 'dxf', {}, 'sample.pdf');
    expect(dxfRes.mimeType).toBe('image/vnd.dxf');
    expect(dxfRes.buffer.toString('utf-8')).toContain('SECTION');

    // PDF -> RTF
    const rtfRes = await convertFile(pdfBuf, 'pdf', 'rtf', {}, 'sample.pdf');
    expect(rtfRes.mimeType).toBe('application/rtf');
    expect(rtfRes.buffer.toString('utf-8')).toContain('{\\rtf1');
  });

  it('12. iges with 116 points must be converted to Wavefront OBJ with real vertices', async () => {
    const iges = `S      1
EasyConvert IGES 3D Model                                               G      1
1H,,1H;,sample,,20260925.120000,1.0,1,1,1,,1.0,1,,,;                    G      2
     116       1       0       0       0       0       0       000010001D      1
     116       0       1       1       0                               0D      2
     116       2       0       0       0       0       0       000010001D      3
     116       0       1       1       0                               0D      4
     116       3       0       0       0       0       0       000010001D      5
     116       0       1       1       0                               0D      6
116,10.0,20.0,30.0;                                                     1P      1
116,40.0,50.0,60.0;                                                     1P      2
116,70.0,80.0,90.0;                                                     1P      3
S      1G      2D      6P      3                                        T      1
`;
    const res = await convertFile(Buffer.from(iges, 'utf-8'), 'iges', 'obj', {}, 'triangle.iges');
    expect(res.mimeType).toBe('model/obj');
    const objText = res.buffer.toString('utf-8');
    expect(objText).toContain('v 10 20 30');
    expect(objText).toContain('v 40 50 60');
    expect(objText).toContain('v 70 80 90');
  });
});
