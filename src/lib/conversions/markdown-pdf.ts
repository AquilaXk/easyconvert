/**
 * Markdown to HTML for the PDF routes (in-process renderer and LibreOffice staging).
 *
 * Every piece of source text is HTML-escaped first, so raw HTML and text such as `List<String>`
 * or `a<b` stay literal; the only tags are the ones built here. Block parsing is line by line and
 * the inline patterns are bounded, so the work is linear in the input size. Covers ATX headings,
 * paragraphs, bullet and ordered lists, pipe tables, fenced code, code spans, strong and emphasis
 * with asterisks, links and images.
 */

const MAX_HEADING_LEVEL = 6;
const MIN_FENCE_LENGTH = 3;
const MAX_LINK_TEXT = 1000;
const MAX_LINK_TARGET = 2000;
const LIST_ITEM = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/;
const ORDERED_MARKER = /^\d/;
const TABLE_DELIMITER_CELL = /^:?-+:?$/;
const IMAGE = new RegExp(`!\\[([^\\]\\n]{0,${MAX_LINK_TEXT}})\\]\\(([^()\\s]{1,${MAX_LINK_TARGET}})\\)`, 'g');
const LINK = new RegExp(`\\[([^\\]\\n]{1,${MAX_LINK_TEXT}})\\]\\(([^()\\s]{1,${MAX_LINK_TARGET}})\\)`, 'g');
/** Asterisk emphasis that opens and closes next to non-space characters; `2 * 3 * 4` stays literal. */
const STRONG = /\*\*(?=\S)([^*\n]*?\S)\*\*/g;
const EMPHASIS = /\*(?=\S)([^*\n]*?\S)\*/g;
const CODE_SPAN_MARK = '`';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Inline Markdown of already-escaped text outside code spans. */
function inlineOutsideCode(escaped: string): string {
  return escaped
    .replace(IMAGE, (_match, alt: string, src: string) => `<img alt="${alt}" src="${src}">`)
    .replace(LINK, (_match, text: string, href: string) => `<a href="${href}">${text}</a>`)
    .replace(STRONG, '<strong>$1</strong>')
    .replace(EMPHASIS, '<em>$1</em>');
}

/** Escapes inline text and renders code spans, links, images and asterisk emphasis. */
function renderInline(text: string): string {
  const parts = escapeHtml(text).split(CODE_SPAN_MARK);
  // An unmatched last backtick is literal text.
  const closed = parts.length % 2 === 1 ? parts.length : parts.length - 1;
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i >= closed) html += CODE_SPAN_MARK + parts[i];
    else if (i % 2 === 1) html += `<code>${parts[i]}</code>`;
    else html += inlineOutsideCode(parts[i]);
  }
  return html;
}

function headingLevel(trimmed: string): number {
  let level = 0;
  while (level < trimmed.length && trimmed[level] === '#') level++;
  const next = trimmed[level];
  return level >= 1 && level <= MAX_HEADING_LEVEL && (next === undefined || next === ' ' || next === '\t') ? level : 0;
}

/** Heading text without the opening marks and an optional closing run of '#'. */
function headingText(trimmed: string, level: number): string {
  let text = trimmed.slice(level).trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  if (end === 0 || text[end - 1] === ' ') text = text.slice(0, end).trim();
  return text;
}

function tableCells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').map((cell) => cell.trim());
}

function isTableDelimiter(line: string | undefined): boolean {
  if (line === undefined || !line.includes('-')) return false;
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => TABLE_DELIMITER_CELL.test(cell));
}

function fenceOf(trimmed: string): string | null {
  const mark = trimmed[0];
  if (mark !== '`' && mark !== '~') return null;
  let length = 0;
  while (length < trimmed.length && trimmed[length] === mark) length++;
  return length >= MIN_FENCE_LENGTH ? mark.repeat(length) : null;
}

/** Renders Markdown as a complete HTML document whose text is escaped everywhere. */
export function markdownToSafeHtml(markdown: string, title: string): string {
  const lines = markdown.replace(/^﻿/, '').split(/\r\n?|\n/);
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) out.push(`<p>${renderInline(paragraph.join('\n'))}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (!list) return;
    const tag = list.ordered ? 'ol' : 'ul';
    out.push(`<${tag}>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${tag}>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const fence = fenceOf(trimmed);
    if (fence) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i++]);
      out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`);
      continue;
    }
    if (trimmed.length === 0) {
      flushParagraph();
      flushList();
      continue;
    }
    const level = headingLevel(trimmed);
    if (level > 0) {
      flushParagraph();
      flushList();
      out.push(`<h${level}>${renderInline(headingText(trimmed, level))}</h${level}>`);
      continue;
    }
    if (trimmed.startsWith('|') && isTableDelimiter(lines[i + 1])) {
      flushParagraph();
      flushList();
      const header = tableCells(line).map((cell) => `<th>${renderInline(cell)}</th>`).join('');
      const rows: string[] = [`<tr>${header}</tr>`];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(`<tr>${tableCells(lines[i]).map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`);
        i++;
      }
      i--;
      out.push(`<table>${rows.join('')}</table>`);
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flushParagraph();
      const ordered = ORDERED_MARKER.test(item[1]);
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push(item[2]);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>\n${out.join('\n')}\n</body></html>\n`;
}
