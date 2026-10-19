import JSZip from 'jszip';
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { SaxesParser } from 'saxes';
import { inspectEpub } from './epub-inspect';
import { zipEntryText } from './zip-entry';

/**
 * The ids a document defines and the internal links that point at them, read from the output with parse5 and an XML
 * parser (saxes) so a test can ask whether every link has a target and no target is defined twice. It shares no code with the writers.
 */

type Node = DefaultTreeAdapterMap['node'];

export interface AnchorReport {
  /** Ids defined more than once in one document, as `document#id`. */
  duplicates: string[];
  /** Ids or bookmark names that are not valid names (an XML NCName, which has no space). */
  invalidNames: string[];
  /** Internal links whose target is not defined, as `document -> target`. */
  broken: string[];
  /** Internal links found (to prove the check looked at something). */
  links: string[];
}

const NCNAME = /^[\p{L}_][\p{L}\p{N}_.-]*$/u;

function collect(tag: Node, visit: (name: string, attrs: Map<string, string>) => void): void {
  if ('tagName' in tag) visit(tag.tagName, new Map(tag.attrs.map((attr) => [attr.name, attr.value])));
  if ('childNodes' in tag) for (const child of tag.childNodes) collect(child, visit);
}

/** The ids and internal links of every content document of an EPUB. */
export async function epubAnchors(epub: Buffer): Promise<AnchorReport> {
  const book = await inspectEpub(epub);
  const ids = new Map<string, Set<string>>();
  const report: AnchorReport = { duplicates: [], invalidNames: [], broken: [], links: [] };
  const hrefs: Array<[string, string]> = [];
  for (const chapter of book.chapters) {
    const defined = new Set<string>();
    ids.set(chapter.path, defined);
    collect(parse(chapter.html) as unknown as Node, (name, attrs) => {
      const id = attrs.get('id');
      if (id !== undefined) {
        if (defined.has(id)) report.duplicates.push(`${chapter.path}#${id}`);
        if (!NCNAME.test(id)) report.invalidNames.push(`${chapter.path}#${id}`);
        defined.add(id);
      }
      const href = attrs.get('href');
      if (name === 'a' && href !== undefined && (href.startsWith('#') || /^chapter\d+\.xhtml#/.test(href))) hrefs.push([chapter.path, href]);
    });
  }
  for (const [from, href] of hrefs) {
    const [file, fragment] = href.split('#');
    const target = file === '' ? from : file;
    report.links.push(`${from} -> ${href}`);
    if (!ids.get(target)?.has(decodeURIComponent(fragment))) report.broken.push(`${from} -> ${href}`);
  }
  return report;
}

function xmlElements(xml: string): Array<{ name: string; attrs: Record<string, string> }> {
  const found: Array<{ name: string; attrs: Record<string, string> }> = [];
  const parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', (tag) => found.push({ name: tag.name, attrs: tag.attributes as Record<string, string> }));
  parser.on('error', (error) => {
    throw error;
  });
  parser.write(xml).close();
  return found;
}

function reportOf(defined: string[], linked: string[]): AnchorReport {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const name of defined) {
    if (seen.has(name)) duplicates.push(name);
    seen.add(name);
  }
  return {
    duplicates,
    invalidNames: [],
    broken: linked.filter((name) => !seen.has(name)).map((name) => `-> ${name}`),
    links: linked.map((name) => `-> ${name}`),
  };
}

/** The bookmarks of a Word document and the internal hyperlinks that name them. */
export async function docxAnchors(docx: Buffer): Promise<AnchorReport> {
  const zip = await JSZip.loadAsync(docx);
  const elements = xmlElements(await zipEntryText(zip, 'word/document.xml'));
  return reportOf(
    elements.filter((element) => element.name === 'w:bookmarkStart').map((element) => element.attrs['w:name']),
    elements.filter((element) => element.name === 'w:hyperlink' && element.attrs['w:anchor'] !== undefined).map((element) => element.attrs['w:anchor'])
  );
}

/** The bookmarks of an ODF text document and the internal links that name them. */
export async function odtAnchors(odt: Buffer): Promise<AnchorReport> {
  const zip = await JSZip.loadAsync(odt);
  const elements = xmlElements(await zipEntryText(zip, 'content.xml'));
  return reportOf(
    elements.filter((element) => element.name === 'text:bookmark').map((element) => element.attrs['text:name']),
    elements.filter((element) => element.name === 'text:a' && element.attrs['xlink:href']?.startsWith('#')).map((element) => element.attrs['xlink:href'].slice(1))
  );
}
