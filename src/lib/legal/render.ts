import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { addHeadingIds } from '@/lib/conversions/markdown';

/** A numbered section of a legal page, as its table of contents links to it. */
export interface LegalSection {
  id: string;
  title: string;
}

/** A legal page read from its Markdown: the title (its `#` heading), the HTML before and after the first section, and the sections. */
export interface LegalPageContent {
  title: string;
  /** The text of the first paragraph, which is the page's description. */
  summary: string;
  introHtml: string;
  sections: readonly LegalSection[];
  bodyHtml: string;
}

const parser = new MarkdownIt('commonmark', { html: false }).enable('table');

function plainText(inline: Token | undefined): string {
  return (inline?.children ?? [])
    .filter((child) => child.type === 'text' || child.type === 'code_inline')
    .map((child) => child.content)
    .join('');
}

const isHeading = (token: Token, tag: 'h1' | 'h2') => token.type === 'heading_open' && token.tag === tag;

/** Reads a legal Markdown text: a `#` title, an introduction, then `##` sections whose ids match a code host's anchors. */
export function readLegalPage(markdown: string): LegalPageContent {
  const tokens = parser.parse(markdown, {});
  addHeadingIds(tokens);
  const titleAt = tokens.findIndex((token) => isHeading(token, 'h1'));
  const afterTitle = tokens.slice(titleAt + 3);
  const firstSection = afterTitle.findIndex((token) => isHeading(token, 'h2'));
  const intro = afterTitle.slice(0, firstSection);
  const body = afterTitle.slice(firstSection);
  const render = (part: Token[]) => parser.renderer.render(part, parser.options, {});
  return {
    title: plainText(tokens[titleAt + 1]),
    summary: plainText(intro[intro.findIndex((token) => token.type === 'paragraph_open') + 1]),
    introHtml: render(intro),
    sections: body.flatMap((token, index) =>
      isHeading(token, 'h2') ? [{ id: token.attrGet('id') ?? '', title: plainText(body[index + 1]) }] : []
    ),
    bodyHtml: render(body),
  };
}
