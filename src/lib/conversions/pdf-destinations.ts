import type { PdfAnchor, PdfTextSegment } from './pdf-fonts';

/**
 * Named destinations of the in-process PDF writers (ISO 32000-1, 12.3.2.3): every anchor of the document is a name in
 * the catalog's `/Dests` name tree that stands for the top left of the line it lands on, `[page /XYZ left top null]`,
 * and an internal link is a `/Link` annotation whose `/GoTo` action names it (12.5.6.5, 12.6.4.2).
 *

 * pdfkit has a name tree, but it is not a valid one: it orders names with the locale's collation where 7.9.6 asks for the
 * byte order of the strings (a reader that searches the tree misses names), writes `/Limits` on the root, and loses a
 * name such as `__proto__`. So pdfkit only records each position, under a key of this module's making, and `finish`
 * writes the tree from the names.
 */

const KEY_PREFIX = 'destination-';
const XYZ = 'XYZ';
/** Characters a PDF text string keeps in its single-byte form (ISO 32000-1, 7.9.2.2): US-ASCII here, which every encoding shares. */
const LAST_ASCII_CODE_UNIT = 0x7f;

/** The names of the destinations a content has, in order. */
export function anchorsOf(content: readonly PdfTextSegment[]): string[] {
  return content.flatMap((segment) => segment.anchors?.map((anchor) => anchor.name) ?? []);
}

/** `names` as anchors at the start of a segment. */
export function anchorsAt(names: readonly string[]): PdfAnchor[] {
  return names.map((name) => ({ name, at: 0 }));
}

/**
 * The destinations of items that show nothing (an empty heading, a list item with no text) wait for the next item that
 * shows text, which they lead, so that a link lands on text. What still waits at the end stands where the content ends.
 */
export class WaitingDestinations<T> {
  private held: T[] = [];

  /** Holds `items` for the next item that shows text. */
  hold(items: readonly T[]): void {
    this.held.push(...items);
  }

  /** Takes what is held: the items to put before the item that shows text, or after the last one at the end. */
  release(): T[] {
    return this.held.splice(0);
  }
}

/** The text string of a name as the PDF stores it: US-ASCII, or UTF-16BE with a byte order mark (ISO 32000-1, 7.9.2.2). */
function storedBytes(name: string): Buffer {
  for (let index = 0; index < name.length; index += 1) {
    if (name.charCodeAt(index) > LAST_ASCII_CODE_UNIT) return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(name, 'utf16le').swap16()]);
  }
  return Buffer.from(name, 'ascii');
}

/** The underline pdfkit draws under a link: half a point under 10 pt text, else a tenth of the font size rounded down. */
const UNDERLINE_SMALL_FONT = 10;
const UNDERLINE_SMALL_WIDTH = 0.5;
const UNDERLINE_FONT_DIVISOR = 10;
const UNDERLINE_COLOR = '#000000';

/** The box a link covers: its top left corner and size, in points from the top left of the page. */
export interface LinkBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Draws a link to the destination `name`: a go-to annotation over the box and, under it, the underline that a link to
 * a web address has. It is drawn over the text, so the text next to it is laid out as it is without the link.
 */
export function linkToDestination(doc: PDFKit.PDFDocument, box: LinkBox, name: string, fontSize: number): void {
  doc.goTo(box.x, box.y, box.width, box.height, name);
  const thickness = fontSize < UNDERLINE_SMALL_FONT ? UNDERLINE_SMALL_WIDTH : Math.floor(fontSize / UNDERLINE_FONT_DIVISOR);
  const y = box.y + box.height - thickness;
  doc.save().strokeColor(UNDERLINE_COLOR).lineWidth(thickness).moveTo(box.x, y).lineTo(box.x + box.width, y).stroke().restore();
}

/** The parts of pdfkit this module uses that its type definitions lack: recording a destination, and the catalog they go to. */
interface PdfkitDestinations {
  addNamedDestination(name: string, ...position: unknown[]): void;
  _root: { data: { Names: { data: { Dests: { get(key: string): unknown[] | undefined } | { Names: unknown[] } } } } };
}

export class PdfDestinations {
  /** The key under which pdfkit recorded the position of each name. */
  private readonly places = new Map<string, string>();
  private readonly declared = new Set<string>();
  private keys = 0;

  constructor(private readonly doc: PDFKit.PDFDocument) {}

  /** Makes the names destinations a link may go to: a link to any other name is left as text. */
  declare(names: Iterable<string>): void {
    for (const name of names) this.declared.add(name);
  }

  /** Whether a link to `name` goes anywhere. */
  has(name: string): boolean {
    return this.declared.has(name);
  }

  /** Puts the names at the top left of a line on the current page, (`left`, `top`) from the top left of the page. */
  place(names: readonly string[], left: number, top: number): void {
    if (names.length === 0) return;
    this.keys += 1;
    const key = `${KEY_PREFIX}${this.keys}`;
    for (const name of names) {
      if (!this.places.has(name)) this.places.set(name, key);
    }
    (this.doc as unknown as PdfkitDestinations).addNamedDestination(key, XYZ, left, top, null);
  }

  /** Writes the name tree. Call it once, after the last page is drawn and before the document ends. */
  finish(): void {
    if (this.places.size === 0) return;
    const catalog = (this.doc as unknown as PdfkitDestinations)._root.data.Names.data;
    const recorded = catalog.Dests as { get(key: string): unknown[] | undefined };
    const entries: Array<{ bytes: Buffer; name: string; destination: unknown[] }> = [];
    for (const [name, key] of this.places) {
      const position = recorded.get(key);
      if (position) entries.push({ bytes: storedBytes(name), name, destination: [position[0], XYZ, position[2], position[3], null] });
    }
    entries.sort((a, b) => Buffer.compare(a.bytes, b.bytes));
    catalog.Dests = { Names: entries.flatMap(({ name, destination }) => [new String(name), destination]) };
  }
}
