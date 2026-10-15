import JSZip from 'jszip';

/**
 * Independent XPS reader for tests, written from ECMA-388: it follows FixedDocumentSequence to the
 * FixedDocument, then to each FixedPage in order, and returns the Glyphs of every page with their
 * font part. It shares no code with the package builder.
 */

export interface XpsGlyphRun {
  text: string;
  fontUri: string | undefined;
  fontSize: number;
  originX: number;
  originY: number;
}

export interface XpsPage {
  width: number;
  height: number;
  glyphs: XpsGlyphRun[];
  /** Number of Path elements on the page (rules, bars and picture frames). */
  pathCount: number;
}

export interface XpsPackage {
  zip: JSZip;
  pages: XpsPage[];
  /** Font part names the pages refer to, de-duplicated. */
  fontParts: string[];
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? match[1] : undefined;
}

function unescapeXml(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function resolvePart(from: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const base = from.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '..') base.pop();
    else if (segment !== '.') base.push(segment);
  }
  return base.join('/');
}

export async function readXps(buffer: Buffer): Promise<XpsPackage> {
  const zip = await JSZip.loadAsync(buffer);
  const sequence = await zip.file('FixedDocumentSequence.fdseq')!.async('string');
  const documents = [...sequence.matchAll(/<DocumentReference[^>]*Source="([^"]+)"/g)].map((m) => resolvePart('FixedDocumentSequence.fdseq', m[1]));
  const pages: XpsPage[] = [];
  const fontParts = new Set<string>();
  for (const documentPart of documents) {
    const document = await zip.file(documentPart)!.async('string');
    for (const pageRef of document.matchAll(/<PageContent[^>]*Source="([^"]+)"/g)) {
      const pagePart = resolvePart(documentPart, pageRef[1]);
      const xml = await zip.file(pagePart)!.async('string');
      const pageTag = /<FixedPage[^>]*>/.exec(xml)![0];
      const glyphs: XpsGlyphRun[] = [...xml.matchAll(/<Glyphs\b[^>]*>/g)].map((m) => {
        const fontUri = attribute(m[0], 'FontUri');
        if (fontUri) fontParts.add(resolvePart(pagePart, fontUri.split('#')[0]));
        return {
          text: unescapeXml(attribute(m[0], 'UnicodeString') ?? ''),
          fontUri,
          fontSize: Number(attribute(m[0], 'FontRenderingEmSize')),
          originX: Number(attribute(m[0], 'OriginX')),
          originY: Number(attribute(m[0], 'OriginY')),
        };
      });
      pages.push({
        width: Number(attribute(pageTag, 'Width')),
        height: Number(attribute(pageTag, 'Height')),
        glyphs,
        pathCount: [...xml.matchAll(/<Path\b/g)].length,
      });
    }
  }
  return { zip, pages, fontParts: [...fontParts] };
}

/** Reverses the ECMA-388 font obfuscation: the first 32 bytes are XORed with the GUID in the part name. */
export function deobfuscateFont(partName: string, data: Buffer): Buffer {
  const guid = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.odttf$/.exec(partName)?.[1];
  if (!guid) throw new Error(`font part ${partName} has no GUID name`);
  const hex = guid.replace(/-/g, '');
  const key = Buffer.from(hex, 'hex').reverse();
  const out = Buffer.from(data);
  const OBFUSCATED_BYTES = 32;
  for (let i = 0; i < Math.min(OBFUSCATED_BYTES, out.length); i++) out[i] ^= key[i % key.length];
  return out;
}
