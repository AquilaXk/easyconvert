import type JSZip from 'jszip';
import { ConversionFailedError, CorruptStreamError, PayloadLimitError } from '../../types';
import { InflateBudget, MAX_DOCUMENT_INFLATE_BYTES } from '../bounded-inflate';
import { decodeXmlBytes, openPackage, readPackageEntry, resolvePackagePath } from '../package-access';
import { childElements, parseXmlTree, type XmlElement } from '../xml-tree';

/**
 * Text of an XPS (Microsoft XML Paper Specification) or OpenXPS (ECMA-388) document: the fixed pages of the fixed document
 * sequence hold glyph runs, each with the position of its first glyph (OriginX, OriginY), the font size
 * (FontRenderingEmSize) and the characters it draws (UnicodeString). A page is read the way a person reads it: the runs
 * that sit on one baseline form a line, from left to right, and the lines run from the top of the page down. Pictures
 * and vector drawings carry no text and are not part of the result.
 */

const LABEL = 'XPS';
/** The relationship that points a package at its fixed document sequence (XPS 2005 and OpenXPS names end the same way). */
const FIXED_REPRESENTATION_SUFFIX = '/fixedrepresentation';
const RELATIONSHIPS_PART = '_rels/.rels';
/**
 * Most bytes one package part may inflate to, the most bytes all parts of a package may inflate to together, and the most
 * documents, pages and glyph runs a package may hold. A part is read once, however many references name it.
 */
export const XPS_MAX_PART_BYTES = 64 * 1024 * 1024;
const XPS_MAX_DOCUMENT_REFERENCES = 1_000;
const XPS_MAX_PAGES = 10_000;
const XPS_MAX_GLYPH_RUNS = 5_000_000;
const XPS_MAX_TEXT_CHARS = 128 * 1024 * 1024;
/** A baseline differing by less than this share of the font size is the same line (superscripts and mixed sizes sit a little off). */
const SAME_LINE_SHARE_OF_EM = 0.4;
/** The width of a glyph as a share of the font size when no font is at hand: where a right to left run's left edge lies, to order it among the runs next to it. */
const AVERAGE_ADVANCE_EMS = 0.5;
/** Advances in Indices are in hundredths of the font size. */
const ADVANCE_UNITS_PER_EM = 100;
/**
 * A gap between two runs that stands for a space the run text does not carry (a hyperlink or a style change ends a run
 * before the space), as a share of the font size: from the measured width of the run before it, or from the estimated one.
 */
const SPACE_GAP_MEASURED_EMS = 0.15;
const SPACE_GAP_ESTIMATED_EMS = 0.6;
/** The prefix that marks a UnicodeString whose braces are literal text (ECMA 388 section 5.3.1). */
const LITERAL_PREFIX = '{}';
const LINE_SEPARATOR = '\n';
const PAGE_SEPARATOR = '\n\n';

interface GlyphRun {
  x: number;
  y: number;
  em: number;
  text: string;
  /** An odd BidiLevel: a right to left run, whose origin is its right edge. */
  rightToLeft: boolean;
  /** The width of the run when its Indices give the advance of every glyph; absent when a glyph uses the font's own advance. */
  width: number | undefined;
}

function numberAttr(element: XmlElement, name: string): number {
  const value = Number(element.attrs.get(name));
  return Number.isFinite(value) ? value : 0;
}

/**
 * The width of a run from its Indices (ECMA 388 section 5.3.3): `glyph,advance,uOffset,vOffset` entries separated by
 * semicolons, the advance in hundredths of the font size. Undefined unless every glyph states its advance.
 */
function runWidth(glyphs: XmlElement): number | undefined {
  const indices = glyphs.attrs.get('Indices');
  if (indices === undefined || indices === '') return undefined;
  let hundredths = 0;
  for (const entry of indices.split(';').filter((candidate) => candidate !== '')) {
    const advance = entry.split(',')[1];
    if (advance === undefined || advance === '' || !Number.isFinite(Number(advance))) return undefined;
    hundredths += Number(advance);
  }
  return (hundredths / ADVANCE_UNITS_PER_EM) * numberAttr(glyphs, 'FontRenderingEmSize');
}

/** The glyph runs of a fixed page in document order, wherever they sit in its canvases. */
function glyphRunsOf(page: XmlElement, partName: string): GlyphRun[] {
  const runs: GlyphRun[] = [];
  const pending: XmlElement[] = [page];
  while (pending.length > 0) {
    const element = pending.pop() as XmlElement;
    if (element.local === 'Glyphs') {
      let text = element.attrs.get('UnicodeString') ?? '';
      if (text.startsWith(LITERAL_PREFIX)) text = text.slice(LITERAL_PREFIX.length);
      if (text !== '') {
        runs.push({
          x: numberAttr(element, 'OriginX'),
          y: numberAttr(element, 'OriginY'),
          em: numberAttr(element, 'FontRenderingEmSize'),
          text,
          rightToLeft: numberAttr(element, 'BidiLevel') % 2 === 1,
          width: runWidth(element),
        });
        if (runs.length > XPS_MAX_GLYPH_RUNS) throw new PayloadLimitError(`${partName} holds more than ${XPS_MAX_GLYPH_RUNS} glyph runs.`);
      }
    }
    for (const child of childElements(element).reverse()) pending.push(child);
  }
  return runs;
}

/** The runs of a page as lines: top to bottom, and left to right within a line. */
function linesOf(runs: readonly GlyphRun[]): string[] {
  const byBaseline = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: GlyphRun[][] = [];
  for (const run of byBaseline) {
    const line = lines.at(-1);
    const sameLine = line !== undefined && Math.abs(run.y - line[0].y) <= SAME_LINE_SHARE_OF_EM * Math.max(run.em, line[0].em);
    if (sameLine) line.push(run);
    else lines.push([run]);
  }
  return lines.map((line) => joinLine(line));
}

/** The left edge of a run: its origin, or for a right to left run (whose origin is its right edge) the origin less its estimated width. */
function leftEdge(run: GlyphRun): number {
  return run.rightToLeft ? run.x - AVERAGE_ADVANCE_EMS * run.em * run.text.length : run.x;
}

/** Whether the gap between two neighbouring runs of the same direction is wide enough to hold a space. Runs of different directions are never spaced by their positions. */
function hasSpaceBetween(previous: GlyphRun, next: GlyphRun): boolean {
  if (previous.rightToLeft !== next.rightToLeft) return false;
  const measured = previous.width !== undefined;
  const width = previous.width ?? AVERAGE_ADVANCE_EMS * previous.em * previous.text.length;
  const gap = previous.rightToLeft ? previous.x - width - next.x : next.x - (previous.x + width);
  return gap > (measured ? SPACE_GAP_MEASURED_EMS : SPACE_GAP_ESTIMATED_EMS) * previous.em;
}

/** The text of one line: the runs from left to right, with every stretch of right to left runs turned into reading order (right to left). */
function joinLine(line: readonly GlyphRun[]): string {
  const ordered = [...line].sort((a, b) => leftEdge(a) - leftEdge(b));
  const reading: GlyphRun[] = [];
  for (let start = 0; start < ordered.length; ) {
    let end = start + 1;
    while (ordered[start].rightToLeft && end < ordered.length && ordered[end].rightToLeft) end += 1;
    const stretch = ordered.slice(start, end);
    for (const run of ordered[start].rightToLeft ? stretch.reverse() : stretch) reading.push(run);
    start = end;
  }
  let text = reading[0].text;
  for (let index = 1; index < reading.length; index += 1) {
    const previous = reading[index - 1];
    const next = reading[index];
    const unspaced = !previous.text.endsWith(' ') && !next.text.startsWith(' ');
    text += (unspaced && hasSpaceBetween(previous, next) ? ' ' : '') + next.text;
  }
  return text.trimEnd();
}

/** The parts of one package, read under the budget of the whole package and the signal of the job. */
class XpsPackage {
  private readonly budget = new InflateBudget(MAX_DOCUMENT_INFLATE_BYTES);

  constructor(
    private readonly zip: JSZip,
    private readonly signal: AbortSignal | undefined
  ) {}

  async readXml(path: string, what: string): Promise<XmlElement> {
    this.signal?.throwIfAborted();
    const bytes = await readPackageEntry(this.zip, path, XPS_MAX_PART_BYTES, what, this.budget);
    return parseXmlTree(decodeXmlBytes(bytes, `${LABEL} ${path}`), path, LABEL);
  }
}

function directoryOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/') + 1);
}

/** The parts a list of references names, resolved against the directory of the part that holds them. */
function referencedParts(holder: string, root: XmlElement, referenceName: string): string[] {
  return childElements(root, referenceName).flatMap((reference) => {
    const source = reference.attrs.get('Source');
    return source === undefined ? [] : [resolvePackagePath(directoryOf(holder), source)];
  });
}

/** The fixed document sequences the package relationships name, in their order. */
async function fixedDocumentSequenceParts(source: XpsPackage): Promise<string[]> {
  const relationships = await source.readXml(RELATIONSHIPS_PART, `${LABEL} package relationships`);
  const targets = childElements(relationships, 'Relationship')
    .filter((relationship) => relationship.attrs.get('Type')?.toLowerCase().endsWith(FIXED_REPRESENTATION_SUFFIX))
    .flatMap((relationship) => relationship.attrs.get('Target') ?? []);
  if (targets.length === 0) throw new ConversionFailedError(`The ${LABEL} package has no fixed document sequence: it is not an XPS document.`);
  return targets.map((target) => resolvePackagePath('', target));
}

async function fixedDocumentSequencePart(source: XpsPackage): Promise<string> {
  return (await fixedDocumentSequenceParts(source))[0];
}

/** Records that `part` is named, refusing a package that names it a second time: every part is read once, so a repeated name is not a way to make the reader work longer. */
function claimOnce(named: Set<string>, part: string, kind: string): void {
  if (named.has(part)) throw new CorruptStreamError(`The ${LABEL} package references the ${kind} "${part}" more than once.`);
  named.add(part);
}

/** The text of each fixed page, in reading order: one string per page, lines separated by a newline. The signal stops the reading between parts. */
export async function readXpsPages(input: Buffer, signal?: AbortSignal): Promise<string[]> {
  const source = new XpsPackage(await openPackage(input, LABEL), signal);
  const sequencePart = await fixedDocumentSequencePart(source);
  const sequence = await source.readXml(sequencePart, `${LABEL} fixed document sequence`);
  const documentParts = referencedParts(sequencePart, sequence, 'DocumentReference');
  if (documentParts.length > XPS_MAX_DOCUMENT_REFERENCES) {
    throw new PayloadLimitError(`The ${LABEL} package names more than ${XPS_MAX_DOCUMENT_REFERENCES} documents.`);
  }
  const pages: string[] = [];
  const namedDocuments = new Set<string>();
  const namedPages = new Set<string>();
  let totalChars = 0;
  for (const documentPart of documentParts) {
    claimOnce(namedDocuments, documentPart, 'fixed document');
    const document = await source.readXml(documentPart, `${LABEL} fixed document`);
    for (const pagePart of referencedParts(documentPart, document, 'PageContent')) {
      if (pages.length >= XPS_MAX_PAGES) throw new PayloadLimitError(`The ${LABEL} document has more than ${XPS_MAX_PAGES} pages.`);
      claimOnce(namedPages, pagePart, 'fixed page');
      const page = linesOf(glyphRunsOf(await source.readXml(pagePart, `${LABEL} fixed page`), pagePart)).join(LINE_SEPARATOR);
      totalChars += page.length;
      if (totalChars > XPS_MAX_TEXT_CHARS) throw new PayloadLimitError(`The ${LABEL} text is longer than ${XPS_MAX_TEXT_CHARS} characters.`);
      pages.push(page);
    }
  }
  if (pages.length === 0) throw new ConversionFailedError(`The ${LABEL} document has no pages.`);
  return pages;
}

/** Every element below `root`, at any depth, in document order. */
export function descendantsOf(root: XmlElement): XmlElement[] {
  const found: XmlElement[] = [];
  const pending = childElements(root).reverse();
  while (pending.length > 0) {
    const element = pending.pop() as XmlElement;
    found.push(element);
    for (const child of childElements(element).reverse()) pending.push(child);
  }
  return found;
}

/**
 * The fixed page parts GhostXPS draws from a package, in the order the documents name them, found the way it finds them
 * (GhostPDL xps/xpszip.c `xps_process_file`, xps/xpsdoc.c `xps_parse_metadata_imp`): every DocumentReference and PageContent
 * element at any depth of the fixed document sequence and then of each fixed document in turn, a document named by a
 * document joining the list. The reader's limits hold: at most 1,000 documents and 10,000 pages, every part named once
 * (GhostXPS skips a repeated name; here it is refused, so a cycle of documents ends at once), one inflate budget for the
 * parts read. A package that names more than one sequence is refused: GhostXPS draws the last one, and the list would be of
 * another. The names are those the documents give, resolved to package paths; the page parts themselves are not read.
 */
export async function renderedXpsPageParts(input: Buffer, signal?: AbortSignal): Promise<string[]> {
  const source = new XpsPackage(await openPackage(input, LABEL), signal);
  const sequences = await fixedDocumentSequenceParts(source);
  if (sequences.length > 1) throw new CorruptStreamError(`The ${LABEL} package names ${sequences.length} fixed document sequences.`);
  const metadataParts = [sequences[0]];
  const namedParts = new Set(metadataParts);
  const namedPages = new Set<string>();
  for (let index = 0; index < metadataParts.length; index += 1) {
    const part = metadataParts[index];
    const root = await source.readXml(part, index === 0 ? `${LABEL} fixed document sequence` : `${LABEL} fixed document`);
    for (const element of descendantsOf(root)) {
      const reference = element.attrs.get('Source');
      if (reference === undefined) continue;
      const target = resolvePackagePath(directoryOf(part), reference);
      if (element.local === 'DocumentReference') {
        claimOnce(namedParts, target, 'fixed document');
        metadataParts.push(target);
        if (metadataParts.length - 1 > XPS_MAX_DOCUMENT_REFERENCES) {
          throw new PayloadLimitError(`The ${LABEL} package names more than ${XPS_MAX_DOCUMENT_REFERENCES} documents.`);
        }
      } else if (element.local === 'PageContent') {
        claimOnce(namedPages, target, 'fixed page');
        if (namedPages.size > XPS_MAX_PAGES) throw new PayloadLimitError(`The ${LABEL} document has more than ${XPS_MAX_PAGES} pages.`);
      }
    }
  }
  if (namedPages.size === 0) throw new ConversionFailedError(`The ${LABEL} document has no pages.`);
  return [...namedPages];
}

/** The text of an XPS or OpenXPS document: its pages one after another, a blank line between them. */
export async function readXpsText(input: Buffer, signal?: AbortSignal): Promise<string> {
  const text = (await readXpsPages(input, signal)).join(PAGE_SEPARATOR).trim();
  if (text === '') throw new ConversionFailedError(`The ${LABEL} document holds no text.`);
  return text;
}
