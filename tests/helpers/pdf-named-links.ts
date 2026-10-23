import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireOracleTool } from './differential-oracle';
import { wordsOf, type Word } from './pdf-link-targets';

/**
 * The links of a PDF as qpdf (the objects, as JSON) and pdftotext (the words of each page with their boxes) read them,
 * for PDFs that write named destinations (ISO 32000-1, 12.3.2) as well as explicit ones. Neither shares code with the
 * converter. Rectangles and destination points are in page coordinates from the top left, as pdftotext reports words.
 */

export interface PdfPoint {
  page: number;
  left: number;
  /** Distance from the top edge of the page. */
  top: number;
}

export interface PdfLink {
  page: number;
  /** Left, top, right and bottom of the annotation, from the top left of the page. */
  rect: { left: number; top: number; right: number; bottom: number };
  /** The words inside the annotation's rectangle. */
  text: string;
  uri?: string;
  /** The destination name of a GoTo action. */
  name?: string;
  /** Where the destination lies (a name is looked up in the catalog's name tree). */
  destination?: PdfPoint;
  /** The words of the line the destination is at: the first line at or below its point on its page, from the left. */
  line?: string[];
}

export interface PdfNamedDestination {
  name: string;
  point: PdfPoint | undefined;
  /** The words of the line the point is at (see PdfLink). */
  line: string[];
}

type PdfDict = Record<string, unknown>;

interface QpdfJson {
  pages: Array<{ object: string }>;
  qpdf: [unknown, Record<string, { value?: unknown }>];
}

const POINT_TOLERANCE = 1;
const SAME_LINE_TOLERANCE = 2;
const STRING_PREFIX = /^u:/;

function plain(value: unknown): string {
  return String(value).replace(STRING_PREFIX, '');
}

class PdfFacts {
  private readonly json: QpdfJson;
  private readonly objects: Record<string, { value?: unknown }>;
  private readonly pageOf: Map<string, number>;
  private readonly words: Word[];
  private readonly heights: number[];

  constructor(file: string) {
    this.json = JSON.parse(execFileSync(requireOracleTool('qpdf'), ['--json', file], { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 })) as QpdfJson;
    this.objects = this.json.qpdf[1];
    this.pageOf = new Map(this.json.pages.map((page, index) => [page.object, index + 1]));
    const listing = wordsOf(file);
    this.words = listing.words;
    this.heights = listing.heights;
  }

  private dereference(reference: unknown): PdfDict {
    if (typeof reference !== 'string') return (reference ?? {}) as PdfDict;
    return (this.objects[`obj:${reference}`]?.value ?? {}) as PdfDict;
  }

  /** The name tree of the catalog's /Names /Dests, flat or nested, as [name, destination array] in stored order. */
  destinations(): Array<[string, unknown[]]> {
    const catalog = this.dereference((this.objects.trailer?.value as PdfDict | undefined)?.['/Root']);
    const entries: Array<[string, unknown[]]> = [];
    const walk = (node: PdfDict): void => {
      const leaf = node['/Names'] as unknown[] | undefined;
      for (let index = 0; leaf && index < leaf.length; index += 2) {
        const value = leaf[index + 1];
        entries.push([plain(leaf[index]), Array.isArray(value) ? value : ((this.dereference(value)['/D'] as unknown[] | undefined) ?? [])]);
      }
      for (const kid of (node['/Kids'] as unknown[] | undefined) ?? []) walk(this.dereference(kid));
    };
    walk(this.dereference(this.dereference(catalog['/Names'])['/Dests']));
    return entries;
  }

  point(destination: unknown[] | undefined): PdfPoint | undefined {
    if (!Array.isArray(destination) || typeof destination[0] !== 'string') return undefined;
    const page = this.pageOf.get(destination[0]);
    if (page === undefined) return undefined;
    return { page, left: Number(destination[2]), top: this.heights[page - 1] - Number(destination[3]) };
  }

  line(point: PdfPoint): string[] {
    const below = this.words.filter((word) => word.page === point.page && word.yMin >= point.top - POINT_TOLERANCE).sort((a, b) => a.yMin - b.yMin || a.xMin - b.xMin);
    const first = below[0];
    if (!first) return [];
    return below.filter((word) => Math.abs(word.yMin - first.yMin) <= SAME_LINE_TOLERANCE).sort((a, b) => a.xMin - b.xMin).map((word) => word.text);
  }

  private wordsIn(page: number, rect: PdfLink['rect']): string {
    return this.words
      .filter(
        (word) =>
          word.page === page &&
          word.xMin >= rect.left - POINT_TOLERANCE &&
          word.xMax <= rect.right + POINT_TOLERANCE &&
          word.yMin >= rect.top - POINT_TOLERANCE &&
          word.yMax <= rect.bottom + POINT_TOLERANCE
      )
      .sort((a, b) => a.yMin - b.yMin || a.xMin - b.xMin)
      .map((word) => word.text)
      .join(' ');
  }

  links(): PdfLink[] {
    const named = new Map(this.destinations());
    const links: PdfLink[] = [];
    this.json.pages.forEach((entry, pageIndex) => {
      const annotations = ((this.dereference(entry.object)['/Annots'] as string[] | undefined) ?? []).map((reference) => this.dereference(reference));
      for (const annotation of annotations) {
        if (annotation['/Subtype'] !== '/Link') continue;
        const [left, bottom, right, top] = annotation['/Rect'] as number[];
        const height = this.heights[pageIndex];
        const rect = { left, top: height - top, right, bottom: height - bottom };
        const action = this.dereference(annotation['/A']);
        const link: PdfLink = { page: pageIndex + 1, rect, text: this.wordsIn(pageIndex + 1, rect) };
        if (action['/S'] === '/URI') link.uri = plain(action['/URI']);
        const target = annotation['/Dest'] ?? (action['/S'] === '/GoTo' ? action['/D'] : undefined);
        if (typeof target === 'string') {
          link.name = plain(target);
          link.destination = this.point(named.get(link.name));
        } else if (Array.isArray(target)) {
          link.destination = this.point(target);
        }
        if (link.destination) link.line = this.line(link.destination);
        links.push(link);
      }
    });
    return links;
  }
}

/** Runs `use` on the PDF written to a temporary file. */
function withPdfFile<T>(pdf: Buffer, use: (file: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-named-links-'));
  try {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    return use(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Every link annotation of the PDF, page by page in the order each page lists them. */
export function pdfLinks(pdf: Buffer): PdfLink[] {
  return withPdfFile(pdf, (file) => new PdfFacts(file).links());
}

/** The destinations of the catalog's name tree in the order it stores them, with the point each one is at. */
export function pdfNamedDestinations(pdf: Buffer): PdfNamedDestination[] {
  return withPdfFile(pdf, (file) => {
    const facts = new PdfFacts(file);
    return facts.destinations().map(([name, array]) => {
      const point = facts.point(array);
      return { name, point, line: point ? facts.line(point) : [] };
    });
  });
}

/** Every word of the PDF with its page and box, as pdftotext lists them. */
export function pdfWordBoxes(pdf: Buffer): Word[] {
  return withPdfFile(pdf, (file) => wordsOf(file).words);
}

/** What `qpdf --check` prints as warnings or errors, and its exit status (0: no problem, 3: warnings only, 2: errors). */
export function qpdfCheck(pdf: Buffer): { status: number; messages: string } {
  return withPdfFile(pdf, (file) => {
    const run = spawnSync(requireOracleTool('qpdf'), ['--check', file], { encoding: 'utf-8' });
    const messages = `${run.stdout}${run.stderr}`
      .split('\n')
      .filter((line) => /^(warning|error):/i.test(line))
      .join('\n');
    return { status: run.status ?? -1, messages };
  });
}
