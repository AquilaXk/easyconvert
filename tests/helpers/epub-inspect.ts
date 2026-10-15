import JSZip from 'jszip';
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

/**
 * Reads an EPUB the way a reading system does, for tests of EPUB output: the package document, the content documents in
 * spine order, their headings and pictures (parsed by parse5), the navigation document and the packaged files. It shares no
 * code with the writers under test.
 */

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

export interface EpubInspection {
  zip: JSZip;
  opf: string;
  /** Content documents in spine order, with their package-relative paths and sources. */
  chapters: Array<{ path: string; html: string }>;
  navigation: string;
  /** Manifest items by href (relative to the package document): media type and properties. */
  manifest: Map<string, { mediaType: string; properties: string }>;
}

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

export function elementsOf(html: string, tags: ReadonlySet<string>): Array<{ tag: string; text: string; attrs: Map<string, string> }> {
  const found: Array<{ tag: string; text: string; attrs: Map<string, string> }> = [];
  const textOf = (node: Node): string => {
    if (node.nodeName === '#text') return (node as unknown as { value: string }).value;
    return 'childNodes' in node ? node.childNodes.map(textOf).join('') : '';
  };
  const walk = (node: Node): void => {
    if (isElement(node) && tags.has(node.tagName)) {
      found.push({ tag: node.tagName, text: textOf(node).replace(/\s+/g, ' ').trim(), attrs: new Map(node.attrs.map((attr) => [attr.name, attr.value])) });
    }
    if ('childNodes' in node) node.childNodes.forEach(walk);
  };
  walk(parse(html) as unknown as Node);
  return found;
}

const HEADINGS: ReadonlySet<string> = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** The headings of a content document as `[level, text]`. */
export function headingsOf(html: string): Array<[number, string]> {
  return elementsOf(html, HEADINGS).map((heading) => [Number(heading.tag.slice(1)), heading.text]);
}

export async function inspectEpub(epub: Buffer): Promise<EpubInspection> {
  const zip = await JSZip.loadAsync(epub);
  const container = await (zip.file('META-INF/container.xml') as JSZip.JSZipObject).async('string');
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1] as string;
  const opf = await (zip.file(opfPath) as JSZip.JSZipObject).async('string');
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const manifest = new Map<string, { mediaType: string; properties: string }>();
  const byId = new Map<string, string>();
  for (const item of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = /\bid="([^"]+)"/.exec(item[0])?.[1];
    const href = /\bhref="([^"]+)"/.exec(item[0])?.[1];
    if (!id || !href) continue;
    manifest.set(href, { mediaType: /\bmedia-type="([^"]+)"/.exec(item[0])?.[1] ?? '', properties: /\bproperties="([^"]*)"/.exec(item[0])?.[1] ?? '' });
    byId.set(id, href);
  }
  const chapters: EpubInspection['chapters'] = [];
  for (const itemref of opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)) {
    const href = byId.get(itemref[1]) as string;
    if (manifest.get(href)?.properties.split(' ').includes('nav')) continue;
    chapters.push({ path: href, html: await (zip.file(base + href) as JSZip.JSZipObject).async('string') });
  }
  const navHref = [...manifest].find(([, item]) => item.properties.split(' ').includes('nav'))?.[0] as string;
  return { zip, opf, chapters, navigation: await (zip.file(base + navHref) as JSZip.JSZipObject).async('string'), manifest };
}

/** Bytes of a packaged file, by its href relative to the package document (the writers put it under OEBPS/). */
export async function packagedFile(inspection: EpubInspection, href: string): Promise<Buffer> {
  const entry = inspection.zip.file(`OEBPS/${href}`) ?? inspection.zip.file(href);
  return Buffer.from(await (entry as JSZip.JSZipObject).async('uint8array'));
}
