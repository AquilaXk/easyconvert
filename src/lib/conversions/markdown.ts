import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { ConversionFailedError } from '../types';

/**
 * Markdown to HTML rendering.
 *
 * Parsing follows CommonMark 0.31.2 (markdown-it's `commonmark` preset) plus the GFM pipe-table and
 * strikethrough extensions. Untrusted Markdown must never be able to add active content to the
 * output, and must not be able to exhaust memory or CPU, so the pipeline is allowlist and budget
 * based instead of filtering HTML afterwards:
 *
 *  1. Raw HTML in the source is disabled (`html: false`). Block and inline HTML are rendered as
 *     escaped text, so `<script>` shows up as visible text and never as an element.
 *  2. A token-level policy pass runs after parsing. It rejects any HTML token, restricts every
 *     element to the set the renderer can produce, restricts attributes per element, validates the
 *     fence language, and applies a URL scheme allowlist to link and image destinations.
 *  3. Budgets bound the work: source size, block-token count, total token count, total attribute
 *     size and output size. Reference definitions let one long destination or title be reused by
 *     thousands of links, so attribute size is accumulated per use, and the check runs before the
 *     output is built. Exceeding any budget throws MarkdownSanitizationError.
 *
 * Destination policy by kind: markdown-it's `validateLink` hook is replaced with the union of the
 * link and image allowlists so unsafe destinations never become links. A destination that is valid
 * for one kind but not the other (a `data:image` link, or a `mailto:` image) is kept as an inert
 * element with the attribute removed, instead of failing the whole document.
 */

/** Raised when the parsed document contains something the renderer must never emit, or exceeds a budget. */
export class MarkdownSanitizationError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'MarkdownSanitizationError';
  }
}

const KIB = 1024;
const MIB = KIB * KIB;

/** Largest accepted Markdown source, in UTF-16 code units. */
export const MAX_MARKDOWN_SOURCE_CHARS = MIB;
/** Largest number of block-level tokens, enforced while block parsing is still running. */
export const MAX_MARKDOWN_BLOCK_TOKENS = 100_000;
/** Largest number of tokens including inline children. */
export const MAX_MARKDOWN_TOTAL_TOKENS = 400_000;
/** Largest summed length of all attribute values, counted once per use of a shared reference. */
export const MAX_MARKDOWN_ATTRIBUTE_CHARS = 4 * MIB;
/** Largest rendered fragment, in UTF-16 code units. */
export const MAX_MARKDOWN_OUTPUT_CHARS = 16 * MIB;

const LINK_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto', 'tel']);
const IMAGE_SCHEMES: ReadonlySet<string> = new Set(['http', 'https']);
// Raster formats only. data:image/svg+xml can carry script and is deliberately excluded.
const DATA_IMAGE_PATTERN = /^data:image\/(?:png|gif|jpe?g|webp)[;,]/i;
const URL_SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;
// Browsers ignore ASCII control characters, whitespace and newlines when reading a URL scheme.
// eslint-disable-next-line no-control-regex
const URL_NOISE_PATTERN = /[\u0000-\u0020\u007f-\u009f]+/g;
// A fence language becomes a CSS class; reject whitespace, quotes, markup characters and over-long values.
const FENCE_LANGUAGE_PATTERN = /^[^\s"'`<>&=\\]{1,64}$/u;
const FENCE_INFO_SEPARATOR = /\s+/;
const TABLE_ALIGN_STYLE_PATTERN = /^text-align:(?:left|right|center)$/;
const ORDERED_START_PATTERN = /^\d{1,9}$/;
const HTML_TOKEN_TYPES: ReadonlySet<string> = new Set(['html_block', 'html_inline']);

type UrlKind = 'link' | 'image';

function classifyUrl(url: string, kind: UrlKind): boolean {
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
  // The fence language class is added by the renderer from token.info, which the policy pass validates.
  ['code', new Set<string>()],
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

interface PolicyState {
  tokenCount: number;
  attributeChars: number;
  // Reference definitions share one destination string across every use; judge each distinct string once.
  urlVerdicts: Map<string, boolean>;
}

function urlVerdict(state: PolicyState, url: string, kind: UrlKind): boolean {
  const key = `${kind}:${url}`;
  const cached = state.urlVerdicts.get(key);
  if (cached !== undefined) return cached;
  const verdict = classifyUrl(url, kind);
  state.urlVerdicts.set(key, verdict);
  return verdict;
}

/** Returns the attribute value to keep, or null to drop the attribute. */
function sanitizeAttribute(state: PolicyState, tag: string, name: string, value: string): string | null {
  if (name === 'href' && tag === 'a') return urlVerdict(state, value, 'link') ? value : null;
  if (name === 'src' && tag === 'img') return urlVerdict(state, value, 'image') ? value : null;
  if (name === 'style') return TABLE_ALIGN_STYLE_PATTERN.test(value) ? value : null;
  if (name === 'start') return ORDERED_START_PATTERN.test(value) ? value : null;
  return value;
}

// The renderer unescapes backslashes and entities in the info string before using it, so validate that form.
const { unescapeAll } = new MarkdownIt().utils;

function sanitizeFenceInfo(token: Token): void {
  const language = unescapeAll(token.info).trim().split(FENCE_INFO_SEPARATOR)[0] ?? '';
  // An unusable language is dropped (the block stays a plain code block) rather than failing the document.
  if (language !== '' && !FENCE_LANGUAGE_PATTERN.test(language)) token.info = '';
}

function walkPolicy(tokens: Token[], state: PolicyState): void {
  for (const token of tokens) {
    state.tokenCount += 1;
    if (state.tokenCount > MAX_MARKDOWN_TOTAL_TOKENS) {
      throw new MarkdownSanitizationError(`Markdown document exceeds the ${MAX_MARKDOWN_TOTAL_TOKENS} token limit`);
    }
    if (HTML_TOKEN_TYPES.has(token.type)) {
      throw new MarkdownSanitizationError(`Markdown rendering produced a raw HTML token (${token.type})`);
    }
    if (token.type === 'fence') sanitizeFenceInfo(token);
    if (token.children) walkPolicy(token.children, state);
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
      state.attributeChars += value.length;
      if (state.attributeChars > MAX_MARKDOWN_ATTRIBUTE_CHARS) {
        throw new MarkdownSanitizationError(
          `Markdown attribute values exceed the ${MAX_MARKDOWN_ATTRIBUTE_CHARS} character limit`
        );
      }
      const clean = sanitizeAttribute(state, tag, name, value);
      if (clean !== null) kept.push([name, clean]);
    }
    token.attrs = kept;
  }
}

/**
 * Enforces the element, attribute, URL and size policy on a parsed token stream. Exported so the
 * rejection branches can be exercised with token streams that the configured parser never emits.
 */
export function applyTokenPolicy(tokens: Token[]): void {
  walkPolicy(tokens, { tokenCount: 0, attributeChars: 0, urlVerdicts: new Map() });
}

function createParser(): MarkdownIt {
  const parser = new MarkdownIt('commonmark', { html: false, linkify: false, typographer: false, breaks: false });
  parser.enable(['table', 'strikethrough']);
  // markdown-it calls this for links, images and autolinks, without saying which; accept the union here
  // and let the token policy apply the per-element rule.
  parser.validateLink = (url: string): boolean => classifyUrl(url, 'link') || classifyUrl(url, 'image');
  // Runs before every block rule on each block start, so an oversized document is rejected while block
  // parsing is still in progress instead of after all of its tokens were allocated.
  parser.block.ruler.before('table', 'easyconvert_block_budget', (state) => {
    if (state.tokens.length > MAX_MARKDOWN_BLOCK_TOKENS) {
      throw new MarkdownSanitizationError(
        `Markdown document exceeds the ${MAX_MARKDOWN_BLOCK_TOKENS} block token limit`
      );
    }
    return false;
  });
  parser.core.ruler.push('easyconvert_token_policy', (state) => {
    applyTokenPolicy(state.tokens);
    return true;
  });
  return parser;
}

const parser = createParser();

/**
 * Renders Markdown to an HTML fragment containing only allowlisted elements, attributes and URLs.
 * Throws MarkdownSanitizationError for out-of-policy parse trees and for inputs that exceed a budget.
 */
export function renderMarkdownFragment(markdown: string): string {
  if (typeof markdown !== 'string') {
    throw new MarkdownSanitizationError('Markdown source must be a string');
  }
  if (markdown.length > MAX_MARKDOWN_SOURCE_CHARS) {
    throw new MarkdownSanitizationError(`Markdown source exceeds the ${MAX_MARKDOWN_SOURCE_CHARS} character limit`);
  }
  let html: string;
  try {
    html = parser.render(markdown);
  } catch (error) {
    // V8 reports string or stack exhaustion as RangeError; surface it as the typed failure (HTTP 400).
    if (error instanceof RangeError) {
      throw new MarkdownSanitizationError(`Markdown rendering exhausted resources: ${error.message}`);
    }
    throw error;
  }
  if (html.length > MAX_MARKDOWN_OUTPUT_CHARS) {
    throw new MarkdownSanitizationError(`Rendered Markdown exceeds the ${MAX_MARKDOWN_OUTPUT_CHARS} character limit`);
  }
  return html;
}
