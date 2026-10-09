import JSZip from 'jszip';

/**
 * Builds small WordprocessingML packages for hostile-input tests: the body XML, the styles and the numbering part
 * come from the test, the surrounding package parts are the minimum a reader needs. The markup follows ECMA-376
 * Part 1 and shares nothing with the reader.
 */

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export interface CraftedDocx {
  /** Content of `<w:body>`. */
  body: string;
  styles?: string;
  numbering?: string;
  /** Extra package parts by path. */
  parts?: Record<string, string | Buffer>;
  /** Relationship elements added to word/_rels/document.xml.rels. */
  relationships?: string;
}

export async function craftDocx(spec: CraftedDocx): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>'
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="word/document.xml"/></Relationships>`
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${spec.body}</w:body></w:document>`
  );
  const relationships = [
    spec.styles ? `<Relationship Id="rIdS" Type="${R_NS}/styles" Target="styles.xml"/>` : '',
    spec.numbering ? `<Relationship Id="rIdN" Type="${R_NS}/numbering" Target="numbering.xml"/>` : '',
    spec.relationships ?? '',
  ].join('');
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`
  );
  if (spec.styles) zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${W_NS}">${spec.styles}</w:styles>`);
  if (spec.numbering) zip.file('word/numbering.xml', `<?xml version="1.0" encoding="UTF-8"?><w:numbering xmlns:w="${W_NS}">${spec.numbering}</w:numbering>`);
  for (const [name, data] of Object.entries(spec.parts ?? {})) zip.file(name, data);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export const paragraph = (text: string): string => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
