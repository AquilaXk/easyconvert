/**
 * Generates the PDF structure corpus in tests/fixtures/pdf-structure/: 24 documents whose structure is known from the
 * way they are written. Each document is built here from a seeded generator (original words, no third-party text), written
 * as HTML (single column) or flat OpenDocument XML (two columns) in `sources/`, and rendered to PDF by LibreOffice. The
 * expected structure (`<name>.truth.json`) is written from the same blocks, never read back from a PDF.
 *
 *   npx tsx scripts/generate-pdf-structure-fixtures.ts
 *
 * See tests/fixtures/pdf-structure/PROVENANCE.md.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const OUTPUT_DIR = path.join(__dirname, '..', 'tests', 'fixtures', 'pdf-structure');
const SOURCE_DIR = path.join(OUTPUT_DIR, 'sources');
const SOFFICE_TIMEOUT_MS = 180_000;
const SINGLE_COLUMN_DOCS = 18;
const TWO_COLUMN_DOCS = 6;
const UINT32 = 0x100000000;
const BODY_POINTS = 11;
const IMAGE_WIDTH = 240;
const IMAGE_HEIGHT = 140;
const IMAGE_QUALITY = 85;
const COLOR_RANGE = 255;
const IMAGE_DOCS = new Set([3, 12]);

export type TruthBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; bordered: boolean; rows: string[][] }
  | { type: 'image'; file: string; width: number; height: number };

interface Truth {
  columns: number;
  blocks: TruthBlock[];
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  };
}

const NOUNS = ['harbor', 'orchard', 'ledger', 'lantern', 'bridge', 'meadow', 'archive', 'compass', 'quarry', 'garden', 'railway', 'workshop', 'library', 'station', 'market'];
const ADJECTIVES = ['quiet', 'broad', 'amber', 'narrow', 'steady', 'bright', 'hollow', 'distant', 'gentle', 'rugged', 'early', 'careful'];
const VERBS = ['crosses', 'follows', 'circles', 'shelters', 'mirrors', 'borders', 'outlasts', 'guides', 'joins', 'divides', 'records', 'supports'];
const PLACES = ['the northern road', 'an old mill', 'the river bend', 'a stone wall', 'the lower field', 'the east gate'];
const LABELS = ['Region', 'Units', 'Share', 'Owner', 'Status', 'Count', 'Period', 'Grade'];
const WORDS = ['north', 'south', 'east', 'west', 'open', 'closed', 'pending', 'active', 'minor', 'major', 'alpha', 'beta', 'gamma', 'delta'];

class Writer {
  constructor(private readonly random: () => number) {}

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.random() * items.length)];
  }

  int(low: number, high: number): number {
    return low + Math.floor(this.random() * (high - low + 1));
  }

  phrase(words: number): string {
    const parts: string[] = [];
    for (let i = 0; i < words; i++) parts.push(i % 2 === 0 ? this.pick(ADJECTIVES) : this.pick(NOUNS));
    return parts.join(' ');
  }

  heading(): string {
    const text = this.phrase(this.int(2, 4));
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  sentence(): string {
    return `The ${this.pick(ADJECTIVES)} ${this.pick(NOUNS)} ${this.pick(VERBS)} the ${this.pick(ADJECTIVES)} ${this.pick(NOUNS)} near ${this.pick(PLACES)}, and the keeper of record ${this.int(10, 99)} notes it in the weekly register.`;
  }

  paragraph(): string {
    return Array.from({ length: this.int(2, 4) }, () => this.sentence()).join(' ');
  }

  listItem(): string {
    return `${this.pick(ADJECTIVES)} ${this.pick(NOUNS)} ${this.pick(VERBS)} ${this.pick(NOUNS)} ${this.int(1, 40)}`;
  }

  table(bordered: boolean): TruthBlock {
    const columns = this.int(2, 4);
    const rowsCount = this.int(3, 5);
    const rows: string[][] = [];
    const labels = [...LABELS].sort(() => this.random() - 0.5).slice(0, columns);
    rows.push(labels);
    for (let r = 1; r < rowsCount; r++) {
      rows.push(Array.from({ length: columns }, (_, c) => (c === 0 ? `${this.pick(WORDS)} ${this.int(1, 9)}` : String(this.int(10, 9999)))));
    }
    return { type: 'table', bordered, rows };
  }
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function singleColumnBlocks(writer: Writer, docIndex: number): TruthBlock[] {
  const blocks: TruthBlock[] = [{ type: 'heading', level: 1, text: writer.heading() }, { type: 'paragraph', text: writer.paragraph() }];
  const sections = writer.int(2, 3);
  for (let s = 0; s < sections; s++) {
    blocks.push({ type: 'heading', level: 2, text: writer.heading() });
    blocks.push({ type: 'paragraph', text: writer.paragraph() });
    if (s === 0 && IMAGE_DOCS.has(docIndex)) blocks.push({ type: 'image', file: `photo-${docIndex + 1}.jpg`, width: IMAGE_WIDTH, height: IMAGE_HEIGHT });
    const extra = (docIndex + s) % 4;
    if (extra === 0) blocks.push({ type: 'list', ordered: false, items: Array.from({ length: writer.int(3, 5) }, () => writer.listItem()) });
    if (extra === 1) blocks.push({ type: 'list', ordered: true, items: Array.from({ length: writer.int(3, 5) }, () => writer.listItem()) });
    if (extra === 2) blocks.push(writer.table(docIndex % 3 !== 0));
    if (extra === 3) blocks.push({ type: 'heading', level: 3, text: writer.heading() });
    blocks.push({ type: 'paragraph', text: writer.paragraph() });
  }
  return blocks;
}

function htmlOf(blocks: TruthBlock[]): string {
  const body = blocks
    .map((block) => {
      switch (block.type) {
        case 'heading':
          return `<h${block.level}>${esc(block.text)}</h${block.level}>`;
        case 'paragraph':
          return `<p>${esc(block.text)}</p>`;
        case 'list': {
          const tag = block.ordered ? 'ol' : 'ul';
          return `<${tag}>${block.items.map((item) => `<li>${esc(item)}</li>`).join('')}</${tag}>`;
        }
        case 'table': {
          const attributes = block.bordered ? 'border="1" cellpadding="4" cellspacing="0"' : 'border="0" cellpadding="6" cellspacing="0"';
          const rows = block.rows
            .map((row, index) => `<tr>${row.map((cell) => `<${index === 0 ? 'th' : 'td'}>${esc(cell)}</${index === 0 ? 'th' : 'td'}>`).join('')}</tr>`)
            .join('');
          return `<table ${attributes}>${rows}</table><p></p>`;
        }
        case 'image':
          return `<p><img src="${block.file}" width="${block.width}" height="${block.height}"></p>`;
        default:
          return '';
      }
    })
    .join('\n');
  return `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>fixture</title>\n<style>body{font-family:'Liberation Sans';font-size:${BODY_POINTS}pt}h1{font-size:22pt}h2{font-size:16pt}h3{font-size:13pt}</style></head>\n<body>\n${body}\n</body></html>\n`;
}

const ODF_NAMESPACES = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
].join(' ');

function twoColumnBlocks(writer: Writer): TruthBlock[] {
  const blocks: TruthBlock[] = [{ type: 'heading', level: 1, text: writer.heading() }];
  const sections = writer.int(3, 4);
  for (let s = 0; s < sections; s++) {
    blocks.push({ type: 'heading', level: 2, text: writer.heading() });
    blocks.push({ type: 'paragraph', text: writer.paragraph() });
    blocks.push({ type: 'paragraph', text: writer.paragraph() });
  }
  return blocks;
}

function flatOdtOf(blocks: TruthBlock[]): string {
  const [title, ...rest] = blocks;
  const body = rest
    .map((block) => {
      if (block.type === 'heading') return `  <text:h text:style-name="H2" text:outline-level="2">${esc(block.text)}</text:h>`;
      if (block.type === 'paragraph') return `  <text:p text:style-name="Body">${esc(block.text)}</text:p>`;
      return '';
    })
    .join('\n');
  const heading = title.type === 'heading' ? title.text : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document ${ODF_NAMESPACES} office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
 <office:font-face-decls><style:font-face style:name="Liberation Sans" svg:font-family="'Liberation Sans'"/></office:font-face-decls>
 <office:styles>
  <style:default-style style:family="paragraph"><style:text-properties style:font-name="Liberation Sans" fo:font-size="${BODY_POINTS}pt" fo:language="en" fo:country="US"/></style:default-style>
  <style:style style:name="Body" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.25cm"/></style:style>
  <style:style style:name="H1" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.3cm"/><style:text-properties fo:font-size="22pt" fo:font-weight="bold"/></style:style>
  <style:style style:name="H2" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.2cm" fo:margin-bottom="0.15cm" fo:keep-with-next="always"/><style:text-properties fo:font-size="16pt" fo:font-weight="bold"/></style:style>
 </office:styles>
 <office:automatic-styles>
  <style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"/></style:page-layout>
  <style:style style:name="Cols" style:family="section"><style:section-properties text:dont-balance-text-columns="true"><style:columns fo:column-count="2" fo:column-gap="1cm"/></style:section-properties></style:style>
 </office:automatic-styles>
 <office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles>
 <office:body><office:text>
  <text:h text:style-name="H1" text:outline-level="1">${esc(heading)}</text:h>
  <text:section text:style-name="Cols" text:name="Body1">
${body}
  </text:section>
 </office:text></office:body>
</office:document>
`;
}

/** A JPEG with a smooth gradient and a diagonal pattern, written from the document number so it is the same on every run. */
async function writeJpeg(file: string, seed: number): Promise<void> {
  const raw = Buffer.alloc(IMAGE_WIDTH * IMAGE_HEIGHT * 3);
  for (let y = 0; y < IMAGE_HEIGHT; y++) {
    for (let x = 0; x < IMAGE_WIDTH; x++) {
      const at = (y * IMAGE_WIDTH + x) * 3;
      raw[at] = Math.round((x / IMAGE_WIDTH) * COLOR_RANGE);
      raw[at + 1] = Math.round((y / IMAGE_HEIGHT) * COLOR_RANGE);
      raw[at + 2] = (x * 7 + y * 13 + seed * 29) % (COLOR_RANGE + 1);
    }
  }
  await sharp(raw, { raw: { width: IMAGE_WIDTH, height: IMAGE_HEIGHT, channels: 3 } }).jpeg({ quality: IMAGE_QUALITY }).toFile(file);
}

function renderPdf(sourceFile: string, outDir: string): string {
  execFileSync(
    'soffice',
    ['--headless', `-env:UserInstallation=file://${path.join(outDir, 'profile')}`, '--convert-to', 'pdf', '--outdir', outDir, sourceFile],
    { timeout: SOFFICE_TIMEOUT_MS, stdio: 'ignore' }
  );
  return path.join(outDir, `${path.basename(sourceFile).replace(/\.[^.]+$/, '')}.pdf`);
}

/** A ruled table with a column span and a row span, rendered like the corpus documents. Its cells are the expected result. */
const MERGED_TABLE_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>fixture</title>
<style>body{font-family:'Liberation Sans';font-size:${BODY_POINTS}pt}h1{font-size:22pt}</style></head>
<body>
<h1>Merged cells</h1>
<table border="1" cellpadding="5" cellspacing="0">
<tr><th colspan="2">Region</th><th>Total</th></tr>
<tr><td rowspan="2">North</td><td>Q1</td><td>10</td></tr>
<tr><td>Q2</td><td>20</td></tr>
<tr><td>South</td><td>Q1</td><td>30</td></tr>
</table>
</body></html>
`;
const MERGED_TABLE_TRUTH = {
  rows: [
    [{ text: 'Region', colSpan: 2, rowSpan: 1 }, { text: 'Total', colSpan: 1, rowSpan: 1 }],
    [{ text: 'North', colSpan: 1, rowSpan: 2 }, { text: 'Q1', colSpan: 1, rowSpan: 1 }, { text: '10', colSpan: 1, rowSpan: 1 }],
    [{ text: 'Q2', colSpan: 1, rowSpan: 1 }, { text: '20', colSpan: 1, rowSpan: 1 }],
    [{ text: 'South', colSpan: 1, rowSpan: 1 }, { text: 'Q1', colSpan: 1, rowSpan: 1 }, { text: '30', colSpan: 1, rowSpan: 1 }],
  ],
};

async function main(): Promise<void> {
  fs.mkdirSync(SOURCE_DIR, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-structure-fixtures-'));
  try {
    const total = SINGLE_COLUMN_DOCS + TWO_COLUMN_DOCS;
    for (let index = 0; index < total; index++) {
      const name = `doc-${String(index + 1).padStart(2, '0')}`;
      const writer = new Writer(mulberry32(1000 + index));
      const twoColumns = index >= SINGLE_COLUMN_DOCS;
      const blocks = twoColumns ? twoColumnBlocks(writer) : singleColumnBlocks(writer, index);
      const truth: Truth = { columns: twoColumns ? 2 : 1, blocks };
      const source = path.join(SOURCE_DIR, twoColumns ? `${name}.fodt` : `${name}.html`);
      for (const block of blocks) if (block.type === 'image') await writeJpeg(path.join(SOURCE_DIR, block.file), index);
      fs.writeFileSync(source, twoColumns ? flatOdtOf(blocks) : htmlOf(blocks), 'utf-8');
      fs.writeFileSync(path.join(OUTPUT_DIR, `${name}.truth.json`), `${JSON.stringify(truth, null, 1)}\n`, 'utf-8');
      fs.copyFileSync(renderPdf(source, work), path.join(OUTPUT_DIR, `${name}.pdf`));
      console.log(`${name}: ${twoColumns ? '2 columns' : '1 column'}, ${blocks.length} blocks`);
    }
    const merged = path.join(SOURCE_DIR, 'merged-table.html');
    fs.writeFileSync(merged, MERGED_TABLE_HTML, 'utf-8');
    fs.writeFileSync(path.join(OUTPUT_DIR, 'merged-table.truth.json'), `${JSON.stringify(MERGED_TABLE_TRUTH, null, 1)}\n`, 'utf-8');
    fs.copyFileSync(renderPdf(merged, work), path.join(OUTPUT_DIR, 'merged-table.pdf'));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

void main();
