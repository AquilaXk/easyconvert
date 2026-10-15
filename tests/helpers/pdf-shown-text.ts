import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
} from 'pdf-lib';

/**
 * Reads the text a PDF page shows, in content-stream order, straight from its structure: every
 * `<hex> Tj` of a composite font is decoded through that font's own ToUnicode CMap. It shares no
 * code with the writers under test, and sees the order the operators were written in, which the
 * extraction tools reorder by position.
 */

function decoded(stream: PDFRawStream): string {
  return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
}

function utf16beHexToString(hex: string): string {
  const units: number[] = [];
  for (let i = 0; i < hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
  return String.fromCharCode(...units);
}

/** CID to text of a Type 0 font's ToUnicode CMap (`bfchar` entries). */
function toUnicodeMap(doc: PDFDocument, font: PDFDict): Map<number, string> {
  const stream = doc.context.lookup(font.get(PDFName.of('ToUnicode'))) as PDFRawStream;
  const map = new Map<number, string>();
  for (const block of decoded(stream).matchAll(/beginbfchar\s+([\s\S]*?)endbfchar/g)) {
    for (const line of block[1].split('\n')) {
      const entry = /^<([0-9A-F]{4})>\s+<([0-9A-F]{4,8})>$/.exec(line.trim());
      if (entry) map.set(parseInt(entry[1], 16), utf16beHexToString(entry[2]));
    }
  }
  return map;
}

/** The words shown on one page, in the order of the content stream, spaces trimmed. */
export function shownWords(doc: PDFDocument, pageIndex = 0): string[] {
  const page = doc.getPage(pageIndex);
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
  const content = streams.map((ref) => decoded(doc.context.lookup(ref) as PDFRawStream)).join('\n');
  const fonts = (page.node.Resources() as PDFDict).lookup(PDFName.of('Font'), PDFDict);
  const maps = new Map<string, Map<number, string>>();
  for (const key of fonts.keys()) {
    const font = fonts.lookup(key, PDFDict);
    if (font.get(PDFName.of('Subtype'))?.toString() === '/Type0') maps.set(key.decodeText(), toUnicodeMap(doc, font));
  }
  const words: string[] = [];
  for (const shown of content.matchAll(/\/([^\s/]+)\s+[\d.]+\s+Tf[^<]*<([0-9A-Fa-f]*)>\s*Tj/g)) {
    const map = maps.get(shown[1]);
    if (!map) continue;
    let text = '';
    for (let i = 0; i < shown[2].length; i += 4) text += map.get(parseInt(shown[2].slice(i, i + 4), 16)) ?? '�';
    words.push(text.trim());
  }
  return words;
}
