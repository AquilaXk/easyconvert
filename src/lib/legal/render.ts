import type Token from 'markdown-it/lib/token.mjs';
import { getPathname } from '@/i18n/navigation';
import type { AppLocale } from '@/i18n/routing';
import { parseMarkdownTokens, renderMarkdownTokens } from '@/lib/markdown/safe-markdown';
import type { LegalDocumentId } from './documents';
import { LEGAL_TEXTS } from './texts';

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

function plainText(inline: Token | undefined): string {
  return (inline?.children ?? [])
    .filter((child) => child.type === 'text' || child.type === 'code_inline')
    .map((child) => child.content)
    .join('');
}

const isHeading = (token: Token, tag: 'h1' | 'h2') => token.type === 'heading_open' && token.tag === tag;

/** Points each link to a page of the site (`/contact`) at that page in `locale`, so that both languages of a text link alike. */
function localizeSiteLinks(tokens: readonly Token[], locale: AppLocale): void {
  for (const token of tokens) {
    if (token.children) localizeSiteLinks(token.children, locale);
    const href = token.type === 'link_open' ? token.attrGet('href') : null;
    if (href?.startsWith('/') && !href.startsWith('//')) token.attrSet('href', getPathname({ locale, href }));
  }
}

/**
 * Reads a legal Markdown text: a `#` title, an introduction, then `##` sections whose ids match a code host's anchors. It is
 * parsed and rendered by the parser and policy of the Markdown conversion. A text without a title or a section is an error.
 */
export function readLegalPage(markdown: string, locale: AppLocale): LegalPageContent {
  const tokens = parseMarkdownTokens(markdown);
  localizeSiteLinks(tokens, locale);
  const titleAt = tokens.findIndex((token) => isHeading(token, 'h1'));
  if (titleAt < 0) throw new Error('A legal text needs a `#` title.');
  const afterTitle = tokens.slice(titleAt + 3);
  const firstSection = afterTitle.findIndex((token) => isHeading(token, 'h2'));
  if (firstSection < 0) throw new Error('A legal text needs at least one `##` section.');
  const intro = afterTitle.slice(0, firstSection);
  const body = afterTitle.slice(firstSection);
  return {
    title: plainText(tokens[titleAt + 1]),
    summary: plainText(intro[intro.findIndex((token) => token.type === 'paragraph_open') + 1]),
    introHtml: renderMarkdownTokens(intro),
    sections: body.flatMap((token, index) =>
      isHeading(token, 'h2') ? [{ id: token.attrGet('id') ?? '', title: plainText(body[index + 1]) }] : []
    ),
    bodyHtml: renderMarkdownTokens(body),
  };
}

const readPages = new Map<string, LegalPageContent>();

/** The legal page `id` in `locale`, read once per process, since the metadata and the page of a route both need it. */
export function legalPage(id: LegalDocumentId, locale: AppLocale): LegalPageContent {
  const key = `${id}:${locale}`;
  let page = readPages.get(key);
  if (!page) {
    page = readLegalPage(LEGAL_TEXTS[id][locale], locale);
    readPages.set(key, page);
  }
  return page;
}
