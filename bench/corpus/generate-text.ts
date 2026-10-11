/**
 * Deterministic text assets of the benchmark corpus: a typed table (JSON lines and RFC 4180 CSV) and a short book
 * (EPUB 3, FB2 and the plain text it was written from). Everything is a pure function of the constants below and of
 * the small vocabulary written for this repository, so a re-run yields the checksums in manifest.json. The table has
 * the cells that break converters (commas, quotes and line breaks inside a cell, digit strings with leading zeros,
 * strings that read as exponents, empty cells, East Asian text, emoji).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

const TOOL_TIMEOUT_MS = 120_000;
const FIXED_ZIP_DATE = new Date(Date.UTC(2020, 0, 1));
const TABLE_ROWS = 2_500;
const TABLE_SEED = 0x7a3be9c1;
const TABLE_START_MS = Date.UTC(2024, 0, 1);
const TABLE_STEP_MS = 90_000;
const BOOK_SEED = 0x51ed270b;
const BOOK_CHAPTERS = 10;
const PARAGRAPHS_PER_CHAPTER = [5, 8] as const;
const SENTENCES_PER_PARAGRAPH = [4, 7] as const;
const FIGURE_WIDTH_PX = 320;
const BOOK_ID = 'urn:uuid:6f1a0d3e-5b7c-4c1e-9d52-0a8b3f7c2e10';
const BOOK_TITLE = 'The Quiet Harbour Survey';
const BOOK_AUTHOR = 'Mara Ellison';
const MS_PER_SECOND = 1_000;

/** Small deterministic generator (mulberry32). */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Random = () => number;
const pick = <T>(random: Random, items: readonly T[]): T => items[Math.floor(random() * items.length)];
const between = (random: Random, range: readonly [number, number]): number => range[0] + Math.floor(random() * (range[1] - range[0] + 1));

const NAMES = [
  'Anna Müller', 'Müller, Anna', 'Dwayne "The Rock" Jones', "Siobhán O'Neill", 'Zoë Ångström', '김민준', '山田太郎', '李小龍', 'Ольга Петрова', 'José Álvarez-Peña',
  'Line one\nLine two', 'Quoted "inside" text, with a comma', '😀 Happy Harbour', 'Plain Name', 'Ünal Çelik', 'Noor al-Din', 'Tab\tseparated', 'Semi;colon', 'Ørjan Håkonsen', 'Mei Lin',
] as const;
const CITIES = ['Reykjavík', 'Seoul', 'São Paulo', 'Kraków', 'Nairobi', 'Oslo', 'Osaka', 'Lima', 'Hanoi', 'Cork', 'Porto', 'Tromsø'] as const;
const NOTES = ['first visit', 'follow-up, same week', 'said "ok" twice', 'moved to storage; pending', 'needs review', 'café order', 'two lines\nof notes', '100% done', '1e5 units', 'plain'] as const;
const CODE_KINDS = ['digits', 'exponent', 'hex', 'word'] as const;
const TABLE_COLUMNS = ['id', 'code', 'name', 'city', 'amount', 'score', 'active', 'note', 'ts'] as const;
type Cell = string | number | boolean | null;
type TableRecord = Record<(typeof TABLE_COLUMNS)[number], Cell>;

function codeOf(random: Random, index: number): string {
  const kind = pick(random, CODE_KINDS);
  if (kind === 'digits') return String(index).padStart(5, '0');
  if (kind === 'exponent') return `${1 + Math.floor(random() * 9)}e${Math.floor(random() * 9)}`;
  if (kind === 'hex') return Math.floor(random() * 0xffffff).toString(16).padStart(6, '0');
  return `K-${Math.floor(random() * 900) + 100}`;
}

function tableRecords(): TableRecord[] {
  const random = prng(TABLE_SEED);
  const records: TableRecord[] = [];
  for (let i = 1; i <= TABLE_ROWS; i++) {
    records.push({
      id: i,
      code: codeOf(random, i),
      name: pick(random, NAMES),
      city: pick(random, CITIES),
      amount: Math.floor(random() * 9_999_999),
      // Eighths: the shortest decimal form of the double is the same in every language, so JSON and CSV agree on the text.
      score: Math.floor(random() * 8_000) / 8,
      active: random() < 0.5,
      note: random() < 0.3 ? null : pick(random, NOTES),
      ts: new Date(TABLE_START_MS + i * TABLE_STEP_MS + Math.floor(random() * MS_PER_SECOND)).toISOString(),
    });
  }
  return records;
}

function csvCell(value: Cell): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\r\n]|^ | $/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function makeTable(outDir: string): void {
  const records = tableRecords();
  fs.mkdirSync(path.join(outDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'data/table.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  const lines = [TABLE_COLUMNS.join(','), ...records.map((record) => TABLE_COLUMNS.map((column) => csvCell(record[column])).join(','))];
  fs.writeFileSync(path.join(outDir, 'data/table.csv'), `${lines.join('\r\n')}\r\n`);
}

const WORDS = {
  subject: ['the surveyor', 'the harbour master', 'a young cartographer', 'the ferry captain', 'our guide', 'the old lighthouse keeper', 'the crew', 'a visiting engineer', 'the night watchman', 'the net mender'],
  verb: ['measured', 'recorded', 'carried', 'repaired', 'questioned', 'followed', 'photographed', 'counted', 'described', 'remembered', 'mapped', 'compared'],
  object: ['the northern jetty', 'a ledger of tide tables', 'seven coils of rope', 'the café on the quay', 'every mooring post', 'the silted channel', 'a brass compass', 'the fish market ledger', 'the old sea wall', 'a naïve sketch of the bay', 'the winter timetable'],
  place: ['before the morning fog lifted', 'while the tide was still low', 'under a pale grey sky', 'near the Tide & Timber warehouse', 'at the edge of the slipway', 'beside the crooked mill', 'during the long afternoon', 'after the last ferry left'],
  link: ['However', 'Meanwhile', 'Later that week', 'In the end', 'To everyone’s surprise', 'As usual', 'Without a word', 'By evening'],
  tail: ['and nobody objected', 'although the wind kept rising', 'which pleased the harbour board', 'so the notes were filed at once', 'because the charts were out of date', 'while gulls circled overhead', 'and the figures were checked twice'],
} as const;

function sentence(random: Random): string {
  const lead = random() < 0.35 ? `${pick(random, WORDS.link)}, ` : '';
  const core = `${pick(random, WORDS.subject)} ${pick(random, WORDS.verb)} ${pick(random, WORDS.object)} ${pick(random, WORDS.place)}`;
  const tail = random() < 0.6 ? `${random() < 0.5 ? ' —' : ','} ${pick(random, WORDS.tail)}` : '';
  const text = `${lead}${core}${tail}`;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

interface Chapter {
  title: string;
  paragraphs: string[];
  items: string[];
  rows: string[][];
}

function chapters(): Chapter[] {
  const random = prng(BOOK_SEED);
  const result: Chapter[] = [];
  for (let c = 1; c <= BOOK_CHAPTERS; c++) {
    const paragraphs: string[] = [];
    const count = between(random, PARAGRAPHS_PER_CHAPTER);
    for (let p = 0; p < count; p++) {
      const sentences: string[] = [];
      const length = between(random, SENTENCES_PER_PARAGRAPH);
      for (let s = 0; s < length; s++) sentences.push(sentence(random));
      paragraphs.push(sentences.join(' '));
    }
    const hasList = c % 3 === 0;
    const hasTable = c % 4 === 0;
    result.push({
      title: `Chapter ${c}: ${pick(random, ['The Tide Tables', 'A Ledger of Ropes', 'Fog on the Quay', 'The Silted Channel', 'Night Watch', 'The Ferry Timetable', 'Winter Soundings', 'Brass and Salt'])}`,
      paragraphs,
      items: hasList ? [0, 1, 2].map(() => sentence(random)) : [],
      rows: hasTable ? [['Post', 'Depth', 'Note'], ...[1, 2, 3].map((n) => [`Post ${n}`, `${n + Math.floor(random() * 4)} m`, pick(random, ['clear', 'silted', 'repaired']) as string])] : [],
    });
  }
  return result;
}

const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The text the book was written from, one block per chapter heading, paragraph, list item and table row; the title and the author are metadata. */
function groundTruth(book: Chapter[]): string {
  const blocks: string[] = [];
  for (const chapter of book) {
    blocks.push(chapter.title, ...chapter.paragraphs, ...chapter.items, ...chapter.rows.map((row) => row.join(' ')));
  }
  return `${blocks.join('\n\n')}\n`;
}

function chapterXhtml(chapter: Chapter, index: number, figure: boolean): string {
  const list = chapter.items.length > 0 ? `<ul>${chapter.items.map((item) => `<li>${escapeXml(item)}</li>`).join('')}</ul>` : '';
  const table =
    chapter.rows.length > 0
      ? `<table><thead><tr>${chapter.rows[0].map((cell) => `<th>${escapeXml(cell)}</th>`).join('')}</tr></thead><tbody>${chapter.rows
          .slice(1)
          .map((row) => `<tr>${row.map((cell) => `<td>${escapeXml(cell)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`
      : '';
  const picture = figure ? '<p><img src="images/figure.jpg" alt="The harbour at low tide"/></p>' : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head><meta charset="utf-8"/><title>${escapeXml(chapter.title)}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head>
<body><section epub:type="chapter" id="chapter-${index}"><h1>${escapeXml(chapter.title)}</h1>${picture}${chapter.paragraphs.map((paragraph) => `<p>${escapeXml(paragraph)}</p>`).join('')}${list}${table}</section></body>
</html>
`;
}

async function writeEpub(outDir: string, book: Chapter[], figure: Buffer): Promise<void> {
  const zip = new JSZip();
  const opts = { date: FIXED_ZIP_DATE, createFolders: false };
  zip.file('mimetype', 'application/epub+zip', { ...opts, compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>', opts);
  const ids = book.map((_, index) => `chapter-${index + 1}`);
  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="css" href="styles.css" media-type="text/css"/>',
    '<item id="figure" href="images/figure.jpg" media-type="image/jpeg" properties="cover-image"/>',
    ...ids.map((id) => `<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`),
  ];
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId" xml:lang="en">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="BookId">${BOOK_ID}</dc:identifier><dc:title>${BOOK_TITLE}</dc:title><dc:creator>${BOOK_AUTHOR}</dc:creator><dc:language>en</dc:language><meta property="dcterms:modified">2020-01-01T00:00:00Z</meta></metadata>
<manifest>${manifest.join('')}</manifest>
<spine toc="ncx">${ids.map((id) => `<itemref idref="${id}"/>`).join('')}</spine>
</package>
`,
    opts
  );
  zip.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en"><head><meta charset="utf-8"/><title>Contents</title></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${book.map((chapter, index) => `<li><a href="${ids[index]}.xhtml">${escapeXml(chapter.title)}</a></li>`).join('')}</ol></nav></body></html>
`,
    opts
  );
  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${BOOK_ID}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head><docTitle><text>${BOOK_TITLE}</text></docTitle>
<navMap>${book.map((chapter, index) => `<navPoint id="np-${index + 1}" playOrder="${index + 1}"><navLabel><text>${escapeXml(chapter.title)}</text></navLabel><content src="${ids[index]}.xhtml"/></navPoint>`).join('')}</navMap></ncx>
`,
    opts
  );
  zip.file('OEBPS/styles.css', 'body { font-family: serif; line-height: 1.4; }\nh1 { font-size: 1.6em; margin: 1em 0 0.5em; }\np { margin: 0 0 0.8em; text-align: justify; }\ntable { border-collapse: collapse; }\nth, td { border: 1px solid #888; padding: 0.2em 0.5em; }\n', opts);
  zip.file('OEBPS/images/figure.jpg', figure, opts);
  book.forEach((chapter, index) => zip.file(`OEBPS/${ids[index]}.xhtml`, chapterXhtml(chapter, index + 1, index === 0), opts));
  fs.writeFileSync(path.join(outDir, 'ebooks/book.epub'), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 }, mimeType: 'application/epub+zip' }));
}

function writeFb2(outDir: string, book: Chapter[], figure: Buffer): void {
  const sections = book
    .map((chapter, index) => {
      const lead = index === 0 ? '<image l:href="#figure.jpg"/>' : '';
      const list = chapter.items.map((item) => `<p>• ${escapeXml(item)}</p>`).join('');
      const table =
        chapter.rows.length > 0
          ? `<table>${chapter.rows.map((row, r) => `<tr>${row.map((cell) => `<${r === 0 ? 'th' : 'td'}>${escapeXml(cell)}</${r === 0 ? 'th' : 'td'}>`).join('')}</tr>`).join('')}</table>`
          : '';
      return `<section><title><p>${escapeXml(chapter.title)}</p></title>${lead}${chapter.paragraphs.map((paragraph) => `<p>${escapeXml(paragraph)}</p>`).join('')}${list}${table}</section>`;
    })
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><genre>prose_contemporary</genre><author><first-name>Mara</first-name><last-name>Ellison</last-name></author><book-title>${BOOK_TITLE}</book-title><lang>en</lang></title-info>
<document-info><author><nickname>bench</nickname></author><date value="2020-01-01">2020-01-01</date><id>${BOOK_ID}</id><version>1.0</version></document-info></description>
<body>
${sections}
</body>
<binary id="figure.jpg" content-type="image/jpeg">${figure.toString('base64').replace(/(.{76})/g, '$1\n')}</binary>
</FictionBook>
`;
  fs.writeFileSync(path.join(outDir, 'ebooks/book.fb2'), xml);
}

export async function makeBook(outDir: string): Promise<void> {
  fs.mkdirSync(path.join(outDir, 'ebooks'), { recursive: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-book-'));
  let figure: Buffer;
  try {
    const figurePath = path.join(scratch, 'figure.jpg');
    execFileSync('/usr/bin/convert', [path.join(outDir, 'photo-a.jpg'), '-resize', `${FIGURE_WIDTH_PX}x`, '-strip', '-quality', '80', figurePath], { stdio: ['ignore', 'ignore', 'pipe'], timeout: TOOL_TIMEOUT_MS });
    figure = fs.readFileSync(figurePath);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const book = chapters();
  fs.writeFileSync(path.join(outDir, 'ebooks/book.gt.txt'), groundTruth(book));
  await writeEpub(outDir, book, figure);
  writeFb2(outDir, book, figure);
}
