/**
 * Markdown to HTML for the PDF routes (in-process renderer and LibreOffice staging).
 *
 * Inline Markdown is tokenized in one left-to-right pass: code spans, images, links and plain text
 * are recognised once and each is emitted as escaped HTML, so no pattern ever runs over generated
 * markup. Raw HTML and text such as `List<String>` or `a<b` stay literal. Links keep only http,
 * https and mailto targets, and images only embedded PNG/JPEG data URIs (as on the HTML route);
 * anything else keeps its text without a link or image, so nothing is fetched or opened.
 * Block parsing is line by line and every scan is bounded, so the work is linear in the input.
 */

const MAX_HEADING_LEVEL = 6;
const MIN_FENCE_LENGTH = 3;
/** Longest link or image label recognised; a longer bracket run stays literal text. */
const MAX_LINK_LABEL = 200;
const LIST_ITEM = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/;
const ORDERED_MARKER = /^\d/;
const DECIMAL_RADIX = 10;
const TABLE_DELIMITER_CELL = /^:?-+:?$/;
/** Link targets kept: web and mail addresses. */
const LINK_TARGET = /^(?:https?:|mailto:)/i;
/** Image sources kept: embedded PNG or JPEG data. */
const IMAGE_SOURCE = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/i;
/** Asterisk emphasis that opens and closes next to non-space characters; `2 * 3 * 4` stays literal. */
const STRONG = /\*\*(?=\S)([^*\n]*?\S)\*\*/g;
const EMPHASIS = /\*(?=\S)([^*\n]*?\S)\*/g;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Plain text: escaped, then asterisk emphasis, which only ever sees this text segment. */
function renderText(text: string): string {
  return escapeHtml(text).replace(STRONG, '<strong>$1</strong>').replace(EMPHASIS, '<em>$1</em>');
}

/** A `[label](target)` at `open` (the '[' index), or null when the syntax does not match. */
function parseLinkAt(text: string, open: number): { label: string; target: string; end: number } | null {
  let close = open + 1;
  const labelLimit = Math.min(text.length, open + 1 + MAX_LINK_LABEL);
  while (close < labelLimit && text[close] !== ']' && text[close] !== '\n') close++;
  if (text[close] !== ']' || text[close + 1] !== '(') return null;
  let end = close + 2;
  while (end < text.length && text[end] !== ')' && text[end] !== '(' && !/\s/.test(text[end])) end++;
  if (text[end] !== ')' || end === close + 2) return null;
  return { label: text.slice(open + 1, close), target: text.slice(close + 2, end), end: end + 1 };
}

/** Renders inline Markdown in a single pass: code spans, images, links, then plain text. */
function renderInline(text: string): string {
  let html = '';
  let plainStart = 0;
  let i = 0;
  const flushPlain = (until: number): void => {
    if (until > plainStart) html += renderText(text.slice(plainStart, until));
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      if (close > i) {
        flushPlain(i);
        html += `<code>${escapeHtml(text.slice(i + 1, close))}</code>`;
        i = close + 1;
        plainStart = i;
        continue;
      }
    } else if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
      const isImage = ch === '!';
      const link = parseLinkAt(text, isImage ? i + 1 : i);
      if (link) {
        flushPlain(i);
        if (isImage) {
          html += IMAGE_SOURCE.test(link.target)
            ? `<img alt="${escapeHtml(link.label)}" src="${escapeHtml(link.target)}">`
            : escapeHtml(link.label);
        } else if (LINK_TARGET.test(link.target)) {
          html += `<a href="${escapeHtml(link.target)}">${renderText(link.label)}</a>`;
        } else {
          html += renderText(link.label);
        }
        i = link.end;
        plainStart = i;
        continue;
      }
    }
    i++;
  }
  flushPlain(text.length);
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
  let list: { ordered: boolean; start: number; items: string[] } | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) out.push(`<p>${renderInline(paragraph.join('\n'))}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (!list) return;
    const tag = list.ordered ? 'ol' : 'ul';
    const start = list.ordered && list.start !== 1 ? ` start="${list.start}"` : '';
    out.push(`<${tag}${start}>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${tag}>`);
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
      if (!list) list = { ordered, start: ordered ? Number.parseInt(item[1], DECIMAL_RADIX) : 1, items: [] };
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
