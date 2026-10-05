import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { ConversionFailedError } from '../types';

/**
 * Markdown to HTML rendering.
 *
 * Parsing follows CommonMark 0.31.2 (markdown-it's `commonmark` preset) plus the GFM pipe-table and
 * strikethrough extensions. Untrusted Markdown must never be able to add active content to the
 * output, so the pipeline is allowlist based instead of filtering HTML afterwards:
 *
 *  1. Raw HTML in the source is disabled (`html: false`). Block and inline HTML are rendered as
 *     escaped text, so `<script>` shows up as visible text and never as an element.
 *  2. A token-level policy pass runs after parsing. It rejects any HTML token, restricts every
 *     element to the set the renderer can produce, restricts attributes per element, and applies a
 *     URL scheme allowlist to link and image destinations.
 *
 * markdown-it's own `validateLink` hook is replaced with the same allowlist so unsafe destinations
 * are not turned into links at all.
 */

/** Raised when the parsed document contains something the renderer must never emit. */
export class MarkdownSanitizationError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'MarkdownSanitizationError';
  }
}

const LINK_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto', 'tel']);
const IMAGE_SCHEMES: ReadonlySet<string> = new Set(['http', 'https']);
// Raster formats only. data:image/svg+xml can carry script and is deliberately excluded.
const DATA_IMAGE_PATTERN = /^data:image\/(?:png|gif|jpe?g|webp)[;,]/i;
const URL_SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;
// Browsers ignore ASCII control characters, whitespace and newlines when reading a URL scheme.
// eslint-disable-next-line no-control-regex
const URL_NOISE_PATTERN = /[\u0000- \u007f-\u009f]+/g;
const FENCE_CLASS_PATTERN = /^language-[A-Za-z0-9_+#.-]{1,64}$/;
const TABLE_ALIGN_STYLE_PATTERN = /^text-align:(?:left|right|center)$/;
const HTML_TOKEN_TYPES: ReadonlySet<string> = new Set(['html_block', 'html_inline']);

type UrlKind = 'link' | 'image';

function isAllowedUrl(url: string, kind: UrlKind): boolean {
  const compact = url.replace(URL_NOISE_PATTERN, '');
  const scheme = URL_SCHEME_PATTERN.exec(compact)?.[1]?.toLowerCase();
  // No scheme: a relative reference or fragment, which cannot execute script.
  if (scheme === undefined) return true;
  if (kind === 'image') return IMAGE_SCHEMES.has(scheme) || DATA_IMAGE_PATTERN.test(compact);
  return LINK_SCHEMES.has(scheme);
}

/** Attribute allowlist per element; elements not listed here must not appear in the token stream. */
const ALLOWED_ATTRIBUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['p', new Set<string>()],
  ['h1', new Set<string>()],
  ['h2', new Set<string>()],
  ['h3', new Set<string>()],
  ['h4', new Set<string>()],
  ['h5', new Set<string>()],
  ['h6', new Set<string>()],
  ['blockquote', new Set<string>()],
  ['ul', new Set<string>()],
  ['ol', new Set(['start'])],
  ['li', new Set<string>()],
  ['pre', new Set<string>()],
  ['code', new Set(['class'])],
  ['em', new Set<string>()],
  ['strong', new Set<string>()],
  ['s', new Set<string>()],
  ['a', new Set(['href', 'title'])],
  ['img', new Set(['src', 'alt', 'title'])],
  ['hr', new Set<string>()],
  ['br', new Set<string>()],
  ['table', new Set<string>()],
  ['thead', new Set<string>()],
  ['tbody', new Set<string>()],
  ['tr', new Set<string>()],
  ['th', new Set(['style'])],
  ['td', new Set(['style'])],
]);

const ORDERED_START_PATTERN = /^\d{1,9}$/;

/** Returns the attribute value to keep, or null to drop the attribute. */
function sanitizeAttribute(tag: string, name: string, value: string): string | null {
  if (name === 'href' && tag === 'a') return isAllowedUrl(value, 'link') ? value : null;
  if (name === 'src' && tag === 'img') return isAllowedUrl(value, 'image') ? value : null;
  if (name === 'class') return FENCE_CLASS_PATTERN.test(value) ? value : null;
  if (name === 'style') return TABLE_ALIGN_STYLE_PATTERN.test(value) ? value : null;
  if (name === 'start') return ORDERED_START_PATTERN.test(value) ? value : null;
  return value;
}

function applyTokenPolicy(tokens: Token[]): void {
  for (const token of tokens) {
    if (HTML_TOKEN_TYPES.has(token.type)) {
      throw new MarkdownSanitizationError(`Markdown rendering produced a raw HTML token (${token.type})`);
    }
    if (token.children) applyTokenPolicy(token.children);
    const tag = token.tag;
    if (tag === '') continue;
    const allowed = ALLOWED_ATTRIBUTES.get(tag);
    if (allowed === undefined) {
      throw new MarkdownSanitizationError(`Markdown rendering produced a non-allowlisted element <${tag}>`);
    }
    if (!token.attrs) continue;
    const kept: Array<[string, string]> = [];
    for (const [name, value] of token.attrs) {
      if (!allowed.has(name)) {
        throw new MarkdownSanitizationError(`Markdown rendering produced a non-allowlisted attribute ${tag}[${name}]`);
      }
      const clean = sanitizeAttribute(tag, name, value);
      if (clean !== null) kept.push([name, clean]);
    }
    token.attrs = kept;
  }
}

function createParser(): MarkdownIt {
  const parser = new MarkdownIt('commonmark', { html: false, linkify: false, typographer: false, breaks: false });
  parser.enable(['table', 'strikethrough']);
  // markdown-it calls this for links, images and autolinks. The union is checked here; the stricter
  // per-element rule (no data: links) is enforced by the token policy below.
  parser.validateLink = (url: string): boolean => isAllowedUrl(url, 'link') || isAllowedUrl(url, 'image');
  parser.core.ruler.push('easyconvert_token_policy', (state) => {
    applyTokenPolicy(state.tokens);
    return true;
  });
  return parser;
}

const parser = createParser();

/**
 * Renders Markdown to an HTML fragment containing only allowlisted elements, attributes and URLs.
 * Throws MarkdownSanitizationError if the parse tree contains anything outside the allowlist.
 */
export function renderMarkdownFragment(markdown: string): string {
  return parser.render(markdown);
}
