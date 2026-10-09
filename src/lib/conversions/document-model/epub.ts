import crypto from 'node:crypto';
import JSZip from 'jszip';
import { ConversionFailedError, PayloadLimitError } from '../../types';
import { resolveLanguage } from '../document-language';
import { redrawAsPng } from '../image-to-png';
import { HtmlWriter, type HtmlRenderOptions } from './html';
import type { Block, DocumentImage, DocumentModel, HeadingBlock, ImageFormat, NoteDefinition } from './model';
import { IMAGE_EXTENSION, IMAGE_MIME, bodyBlocks, imagesById, notesOf, walkBlocks, walkRuns } from './support';
import { inlineText } from './text';
import { escapeXmlText } from './xml-text';

/**
 * Writes the document model as an EPUB 3.3 publication: one content document per top-level section (a new document
 * starts at each h1 and h2), a navigation document and an NCX built from the same heading list, nested by level,
 * language metadata on the package and on every content document, EPUB Accessibility 1.1 metadata that states only
 * what the content supports, and images packaged with their original bytes where the EPUB core media types allow.
 */

const UNDETERMINED_LANGUAGE = 'und';
/** Most content documents and images one book may hold. */
export const EPUB_WRITER_MAX_CHAPTERS = 10_000;
export const EPUB_WRITER_MAX_IMAGES = 5_000;
const NAV_DOCUMENT_PATH = 'nav.xhtml';
const NCX_PATH = 'toc.ncx';
const STYLESHEET_PATH = 'styles.css';
const IMAGE_DIRECTORY = 'images/';
const SPLIT_LEVEL = 2;
const XHTML_MEDIA_TYPE = 'application/xhtml+xml';
/** Image types EPUB 3.3 lists as core media types; anything else is redrawn as PNG. */
const EPUB_IMAGE_FORMATS: ReadonlySet<ImageFormat> = new Set(['png', 'jpeg', 'gif', 'svg']);
const escapeXmlAttribute = escapeXmlText;

const STYLESHEET = `body { font-family: serif; line-height: 1.5; margin: 1em; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.2em 0 0.5em; }
img { max-width: 100%; height: auto; }
table { border-collapse: collapse; margin: 1em 0; }
th, td { border: 1px solid #999; padding: 0.25em 0.5em; vertical-align: top; }
pre { white-space: pre-wrap; }
blockquote { margin: 1em 2em; }
aside.footnotes, aside.endnotes { font-size: 0.9em; border-top: 1px solid #999; margin-top: 2em; }
`;

export interface EpubWriteOptions {
  title: string;
  /** Requested content language; validated as a BCP 47 tag. */
  language?: string;
}

interface Chapter {
  blocks: Block[];
  /** Index of the first heading of this chapter in the document-wide heading order. */
  headingOffset: number;
}

interface NavEntry {
  level: number;
  text: string;
  chapter: number;
  id: string;
}

interface PackagedImage {
  readonly path: string;
  readonly mediaType: string;
  readonly data: Buffer;
  readonly id: string;
}

function blockHeadingText(block: HeadingBlock): string {
  const text = inlineText(block.runs).replace(/\s+/g, ' ').trim();
  if (text !== '') return text;
  for (const run of block.runs) if (run.image && run.image.alt.trim() !== '') return run.image.alt.trim();
  return '';
}

function assertChapterCount(count: number): void {
  if (count > EPUB_WRITER_MAX_CHAPTERS) throw new PayloadLimitError(`The book would have more than ${EPUB_WRITER_MAX_CHAPTERS} content documents.`);
}

/** Splits the top-level blocks into content documents: a new one starts at each h1 and h2 that follows content. */
function splitChapters(blocks: readonly Block[]): Chapter[] {
  const chapters: Chapter[] = [];
  let current: Chapter = { blocks: [], headingOffset: 0 };
  let headings = 0;
  for (const block of blocks) {
    if (block.type === 'pageBreak') continue;
    if (block.type === 'heading' && block.level <= SPLIT_LEVEL) {
      // A heading that directly follows another heading of the same document stays with it.
      const onlyHeadings = current.blocks.every((entry) => entry.type === 'heading' && entry.level < block.level);
      if (current.blocks.length > 0 && !onlyHeadings) {
        chapters.push(current);
        assertChapterCount(chapters.length + 1);
        current = { blocks: [], headingOffset: headings };
      }
    }
    if (block.type === 'heading') headings += 1;
    current.blocks.push(block);
  }
  if (current.blocks.length > 0) chapters.push(current);
  assertChapterCount(chapters.length);
  return chapters;
}

function chapterFile(index: number): string {
  return `chapter${index + 1}.xhtml`;
}

/** Pictures the book embeds, once per distinct file, by the id the model gives them. */
async function packageImages(model: DocumentModel): Promise<{ byId: Map<number, PackagedImage>; list: PackagedImage[] }> {
  const used = new Set<number>();
  const collect = (blocks: readonly Block[]): void => {
    walkBlocks(blocks, (block) => {
      if (block.type === 'image') used.add(block.imageId);
    });
    walkRuns(blocks, (run) => {
      if (run.image) used.add(run.image.imageId);
    });
  };
  collect(bodyBlocks(model));
  for (const note of [...(model.footnotes ?? []), ...(model.endnotes ?? [])]) collect(note.blocks);
  const images = imagesById(model);
  const byId = new Map<number, PackagedImage>();
  const list: PackagedImage[] = [];
  for (const id of used) {
    const image = images.get(id);
    if (!image) continue;
    if (list.length >= EPUB_WRITER_MAX_IMAGES) throw new PayloadLimitError(`The book would embed more than ${EPUB_WRITER_MAX_IMAGES} images.`);
    let data: Buffer = Buffer.from(image.data);
    let format: ImageFormat = image.format;
    if (!EPUB_IMAGE_FORMATS.has(format)) {
      data = await redrawAsPng(data, IMAGE_MIME[format]);
      format = 'png';
    }
    const packagedId = `image${list.length + 1}`;
    const packaged: PackagedImage = { path: `${IMAGE_DIRECTORY}${packagedId}.${IMAGE_EXTENSION[format]}`, mediaType: IMAGE_MIME[format], data, id: packagedId };
    list.push(packaged);
    byId.set(id, packaged);
  }
  return { byId, list };
}

function notesFor(blocks: readonly Block[], kind: 'footnote' | 'endnote', notes: readonly NoteDefinition[]): NoteDefinition[] {
  const cited = new Set<number>();
  walkRuns(blocks, (run) => {
    if (run.note && run.note.kind === kind) cited.add(run.note.id);
  });
  return notes.filter((note) => cited.has(note.id));
}

function xmlLanguageAttributes(language: string): string {
  return `lang="${escapeXmlAttribute(language)}" xml:lang="${escapeXmlAttribute(language)}"`;
}

function navList(entries: readonly NavEntry[], hrefOf: (entry: NavEntry) => string): string {
  return renderNavTree(buildTree(entries), hrefOf);
}

interface NavNode {
  entry: NavEntry;
  children: NavNode[];
}

function buildTree(entries: readonly NavEntry[]): NavNode[] {
  const roots: NavNode[] = [];
  const stack: NavNode[] = [];
  for (const entry of entries) {
    const node: NavNode = { entry, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].entry.level >= entry.level) stack.pop();
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return roots;
}

function renderNavTree(nodes: readonly NavNode[], hrefOf: (entry: NavEntry) => string, indent = '  '): string {
  const items = nodes
    .map((node) => {
      const link = `<a href="${escapeXmlAttribute(hrefOf(node.entry))}">${escapeXmlText(node.entry.text)}</a>`;
      const nested = node.children.length > 0 ? `\n${renderNavTree(node.children, hrefOf, `${indent}  `)}\n${indent}` : '';
      return `${indent}<li>${link}${nested}</li>`;
    })
    .join('\n');
  return `${indent.slice(2)}<ol>\n${items}\n${indent.slice(2)}</ol>`;
}

function treeDepth(nodes: readonly NavNode[]): number {
  return nodes.reduce((deepest, node) => Math.max(deepest, 1 + treeDepth(node.children)), 0);
}

function renderNcxPoints(nodes: readonly NavNode[], hrefOf: (entry: NavEntry) => string, counter: { value: number }): string {
  return nodes
    .map((node) => {
      counter.value += 1;
      const order = counter.value;
      const children = renderNcxPoints(node.children, hrefOf, counter);
      return `<navPoint id="navpoint-${order}" playOrder="${order}"><navLabel><text>${escapeXmlText(node.entry.text)}</text></navLabel><content src="${escapeXmlAttribute(hrefOf(node.entry))}"/>${children}</navPoint>`;
    })
    .join('\n');
}

function accessibilityMetadata(model: DocumentModel, hasHeadings: boolean): string[] {
  const alternatives: string[] = [];
  const collect = (blocks: readonly Block[]): void => {
    walkBlocks(blocks, (block) => {
      if (block.type === 'image') alternatives.push(block.alt ?? '');
    });
    walkRuns(blocks, (run) => {
      if (run.image) alternatives.push(run.image.alt);
    });
  };
  collect(bodyBlocks(model));
  for (const note of [...(model.footnotes ?? []), ...(model.endnotes ?? [])]) collect(note.blocks);
  const imageCount = alternatives.length;
  const everyImageDescribed = alternatives.every((alt) => alt.trim() !== '');
  const features = ['tableOfContents', 'readingOrder'];
  if (hasHeadings) features.push('structuralNavigation');
  if (imageCount > 0 && everyImageDescribed) features.push('alternativeText');
  const modes = imageCount > 0 ? ['textual', 'visual'] : ['textual'];
  const sufficient = imageCount > 0 && !everyImageDescribed ? 'textual,visual' : 'textual';
  const summaryParts = ['This publication has a table of contents and a linear reading order.'];
  if (hasHeadings) summaryParts.push('Its sections are marked with headings.');
  if (imageCount > 0) summaryParts.push(everyImageDescribed ? 'Every image has a text alternative.' : 'Some images have no text alternative.');
  return [
    ...modes.map((mode) => `<meta property="schema:accessMode">${mode}</meta>`),
    `<meta property="schema:accessModeSufficient">${sufficient}</meta>`,
    ...features.map((feature) => `<meta property="schema:accessibilityFeature">${feature}</meta>`),
    '<meta property="schema:accessibilityHazard">none</meta>',
    `<meta property="schema:accessibilitySummary">${escapeXmlText(summaryParts.join(' '))}</meta>`,
  ];
}

/** Writes the book. A document with no content, or an unusable `language`, is refused with a typed error. */
export async function documentToEpub(model: DocumentModel, options: EpubWriteOptions): Promise<Buffer> {
  const chapters = splitChapters(bodyBlocks(model));
  if (chapters.length === 0) throw new ConversionFailedError('The document has no content to put in an EPUB.');
  const language = resolveLanguage(model, options.language) ?? UNDETERMINED_LANGUAGE;
  const title = (model.title ?? options.title).trim() || options.title;
  const bookId = `urn:uuid:${crypto.randomUUID()}`;
  const { byId, list: images } = await packageImages(model);
  const imageIndex = imagesById(model);

  // Headings in document order, each with the content document that holds it.
  const entries: NavEntry[] = [];
  chapters.forEach((chapter, chapterIndex) => {
    let local = 0;
    for (const block of chapter.blocks) {
      if (block.type !== 'heading') continue;
      local += 1;
      const text = blockHeadingText(block);
      if (text !== '') entries.push({ level: block.level, text, chapter: chapterIndex, id: `h-${chapter.headingOffset + local}` });
    }
  });
  const hasHeadings = entries.length > 0;
  if (!hasHeadings) entries.push({ level: 1, text: title, chapter: 0, id: '' });
  const hrefOf = (entry: NavEntry): string => `${chapterFile(entry.chapter)}${entry.id === '' ? '' : `#${entry.id}`}`;

  // Which content document each bookmark is in, so links across documents resolve.
  const anchorChapter = new Map<string, number>();
  chapters.forEach((chapter, index) => {
    walkRuns(chapter.blocks, (run) => {
      if (run.anchor !== undefined && !anchorChapter.has(run.anchor)) anchorChapter.set(run.anchor, index);
    });
  });

  const zip = new JSZip();
  // No folder entries: an OCF container lists files only.
  const add = (name: string, data: string | Buffer, extra: JSZip.JSZipFileOptions = {}): void => {
    zip.file(name, data, { createFolders: false, ...extra });
  };
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE', createFolders: false });
  add(
    'META-INF/container.xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n  <rootfiles>\n    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n  </rootfiles>\n</container>\n'
  );
  add(`OEBPS/${STYLESHEET_PATH}`, STYLESHEET);
  for (const image of images) add(`OEBPS/${image.path}`, image.data);

  chapters.forEach((chapter, index) => {
    const render: HtmlRenderOptions = {
      imageSource: (image: DocumentImage) => (byId.get(image.id) as PackagedImage).path,
      anchorHref: (name) => {
        const target = anchorChapter.get(name);
        if (target === undefined) return undefined;
        return target === index ? `#${name}` : `${chapterFile(target)}#${name}`;
      },
      headingIdPrefix: 'h-',
    };
    const writer = new HtmlWriter(imageIndex, render);
    writer.headingCount = chapter.headingOffset;
    const body =
      writer.blocks(chapter.blocks) +
      new HtmlWriter(imageIndex, render).notes('footnote', notesFor(chapter.blocks, 'footnote', notesOf(model, 'footnote'))) +
      new HtmlWriter(imageIndex, render).notes('endnote', notesFor(chapter.blocks, 'endnote', notesOf(model, 'endnote')));
    const firstHeading = chapter.blocks.find((block): block is HeadingBlock => block.type === 'heading');
    const chapterTitle = (firstHeading ? blockHeadingText(firstHeading) : '') || title;
    add(
      `OEBPS/${chapterFile(index)}`,
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" ${xmlLanguageAttributes(language)}>\n<head>\n<meta charset="utf-8"/>\n<title>${escapeXmlText(chapterTitle)}</title>\n<link rel="stylesheet" type="text/css" href="${STYLESHEET_PATH}"/>\n</head>\n<body>\n<section>\n${body}\n</section>\n</body>\n</html>\n`
    );
  });

  const tree = buildTree(entries);
  add(
    `OEBPS/${NAV_DOCUMENT_PATH}`,
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" ${xmlLanguageAttributes(language)}>\n<head>\n<meta charset="utf-8"/>\n<title>${escapeXmlText(title)}</title>\n<link rel="stylesheet" type="text/css" href="${STYLESHEET_PATH}"/>\n</head>\n<body>\n<nav epub:type="toc" id="toc" role="doc-toc">\n${navList(entries, hrefOf)}\n</nav>\n</body>\n</html>\n`
  );
  add(
    `OEBPS/${NCX_PATH}`,
    `<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${escapeXmlAttribute(language)}">\n<head>\n<meta name="dtb:uid" content="${bookId}"/>\n<meta name="dtb:depth" content="${treeDepth(tree)}"/>\n<meta name="dtb:totalPageCount" content="0"/>\n<meta name="dtb:maxPageNumber" content="0"/>\n</head>\n<docTitle><text>${escapeXmlText(title)}</text></docTitle>\n<navMap>\n${renderNcxPoints(tree, hrefOf, { value: 0 })}\n</navMap>\n</ncx>\n`
  );

  const manifest = [
    ...chapters.map((_chapter, index) => `<item id="chapter${index + 1}" href="${chapterFile(index)}" media-type="${XHTML_MEDIA_TYPE}"/>`),
    `<item id="nav" href="${NAV_DOCUMENT_PATH}" media-type="${XHTML_MEDIA_TYPE}" properties="nav"/>`,
    `<item id="ncx" href="${NCX_PATH}" media-type="application/x-dtbncx+xml"/>`,
    `<item id="css" href="${STYLESHEET_PATH}" media-type="text/css"/>`,
    ...images.map((image) => `<item id="${image.id}" href="${image.path}" media-type="${image.mediaType}"/>`),
  ];
  const metadata = [
    `<dc:identifier id="BookId">${bookId}</dc:identifier>`,
    `<dc:title>${escapeXmlText(title)}</dc:title>`,
    `<dc:language>${escapeXmlText(language)}</dc:language>`,
    ...(model.author ? [`<dc:creator>${escapeXmlText(model.author)}</dc:creator>`] : []),
    `<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>`,
    ...accessibilityMetadata(model, hasHeadings),
  ];
  add(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0" xml:lang="${escapeXmlAttribute(language)}">\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n${metadata.join('\n')}\n</metadata>\n<manifest>\n${manifest.join('\n')}\n</manifest>\n<spine toc="ncx">\n${chapters.map((_chapter, index) => `<itemref idref="chapter${index + 1}"/>`).join('\n')}\n</spine>\n</package>\n`
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
