import { ConversionFailedError } from '../../types';

/**
 * Clean, linear-time converters turning LaTeX/TeX, reStructuredText (RST), and troff/groff man pages
 * into structured Markdown or clean plain text without leaking preamble/macro directives.
 *
 * Linear-time claim: the closing `{` / `[` of every TeX argument comes from one stack pass per text (`PairIndex`) and a missing
 * `\end{verbatim}` is searched for once, so unclosed brackets cost the same per character as closed ones. A text is rescanned only
 * for the argument it contains (nesting is capped at MAX_BRACE_DEPTH), so the work is at most MAX_BRACE_DEPTH times the input.
 */

const MAX_MARKUP_CHARS = 32 * 1024 * 1024;
const MAX_BRACE_DEPTH = 32;

const PREAMBLE_OR_CONTROL_COMMANDS: ReadonlySet<string> = new Set([
  'documentclass', 'usepackage', 'usetikzlibrary', 'usetheme', 'usecolortheme', 'geometry', 'hypersetup',
  'setlength', 'addtolength', 'setcounter', 'addtocounter', 'linespread', 'fontsize', 'selectfont',
  'pagestyle', 'thispagestyle', 'markboth', 'markright', 'bibliographystyle', 'bibliography',
  'newcommand', 'renewcommand', 'providecommand', 'declarerobustcommand', 'declaremathoperator',
  'newenvironment', 'renewenvironment', 'theoremstyle', 'newtheorem',
  'maketitle', 'tableofcontents', 'listoffigures', 'listoftables', 'newpage', 'clearpage',
  'cleardoublepage', 'pagebreak', 'noindent', 'centering', 'raggedright', 'raggedleft',
  'hfill', 'vfill', 'hspace', 'vspace', 'label', 'index', 'footnote',
  'includegraphics', 'input', 'include', 'cite', 'citep', 'citet', 'ref', 'eqref', 'pageref', 'autoref', 'cref',
  'color', 'pagecolor',
]);

/** Commands followed by 2 mandatory braced arguments (e.g. \setlength{\parindent}{0pt}, \newcommand{\f}{body}) whose arguments are all suppressed. */
const MULTI_ARG_SUPPRESSED_COMMANDS: ReadonlySet<string> = new Set([
  'newcommand', 'renewcommand', 'providecommand', 'declarerobustcommand', 'declaremathoperator',
  'setlength', 'addtolength', 'setcounter', 'addtocounter', 'newtheorem',
]);

/** Environments that take extra mandatory braced specs right after \begin{env} (e.g. \begin{tabular}{|l|r|}). */
const ENV_MANDATORY_SPEC_COUNTS: Readonly<Record<string, number>> = {
  tabular: 1,
  'tabular*': 2,
  tabularx: 2,
  longtable: 1,
  array: 1,
  minipage: 1,
  multicols: 1,
  wrapfigure: 2,
};

const TEX_SPECIAL_SYMBOLS: Readonly<Record<string, string>> = {
  textbackslash: '\\',
  textasciitilde: '~',
  textasciicircum: '^',
  textemdash: '—',
  textendash: '–',
  ldots: '…',
  dots: '…',
  quad: ' ',
  qquad: '  ',
  latex: 'LaTeX',
  tex: 'TeX',
};

/** Man / troff layout, register, string, and conditional directives whose arguments must never leak as prose. */
const SILENT_TROFF_DIRECTIVES: ReadonlySet<string> = new Set([
  'nr', 'ds', 'as', 'rm', 'rn', 'rr', 'sp', 'vs', 'ps', 'ft', 'cs', 'ss_req', 'ls', 'll', 'in', 'ti',
  'po', 'pl', 'bp', 'ne', 'ad', 'na', 'hy', 'nh', 'ce', 'rj', 'ta', 'tc', 'lc', 'fc', 'tr', 'cc', 'c2',
  'ec', 'eo', 'so', 'nx', 'if', 'ie', 'el', 'do', 'mso', 'fam', 'ev', 'di', 'da', 'rs', 're', 'pd', 'dt',
  'pt', 'at', 'uc', 'ix', 'sm', 'br', 'ts', 'te', 'eq', 'en', 'pe', 'tm', 'ps_req', 'hy_req', 'nh_req',
  'tq', 'ys',
]);

const HEADING_COMMANDS: Readonly<Record<string, number>> = {
  part: 1,
  title: 1,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
};

function assertMarkupWithinLimit(text: string, format: string): void {
  if (text.length > MAX_MARKUP_CHARS) {
    throw new ConversionFailedError(`Input .${format} source exceeds ${MAX_MARKUP_CHARS} characters.`);
  }
}

function stripTexComments(tex: string): string {
  return tex
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] === '%') {
          let slashes = 0;
          for (let j = i - 1; j >= 0 && line[j] === '\\'; j -= 1) slashes += 1;
          if (slashes % 2 === 0) return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');
}

/**
 * Where each `open` character of a text closes, found by one stack pass. A backslash escapes the next character, as in
 * the scans this replaces. `opens` is ascending, `closes[k]` is the position that closes `opens[k]`, or -1 when it never closes.
 * Searching to the end of the text for every opener took time proportional to the square of the input for a text of
 * unclosed `{` or `[`; TeX itself reads a group the same way, each token once, and reports the group still open at the end of file.
 */
interface PairIndex {
  opens: Int32Array;
  closes: Int32Array;
}

function buildPairIndex(text: string, open: string, close: string): PairIndex {
  let capacity = 0;
  for (let at = text.indexOf(open); at !== -1; at = text.indexOf(open, at + 1)) capacity += 1;
  const opens = new Int32Array(capacity);
  const closes = new Int32Array(capacity).fill(-1);
  const stack = new Int32Array(capacity);
  let count = 0;
  let top = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1;
    } else if (ch === open) {
      opens[count] = i;
      stack[top] = count;
      count += 1;
      top += 1;
    } else if (ch === close && top > 0) {
      top -= 1;
      closes[stack[top]] = i;
    }
  }
  return { opens, closes };
}

/** One TeX text with the bracket pairs found once for all the arguments that are read from it. */
class TexSource {
  private braces: PairIndex | undefined;
  private brackets: PairIndex | undefined;
  /** Per environment: the position from which no `\end{env}` exists, so a second search from there is skipped. */
  private readonly missingEndFrom = new Map<string, number>();

  constructor(readonly text: string) {}

  /** The position of the `}` that closes the `{` at `at`, or -1. */
  closingBrace(at: number): number {
    this.braces ??= buildPairIndex(this.text, '{', '}');
    return closingOf(this.braces, at);
  }

  /** The position of the `]` that closes the `[` at `at`, or -1. */
  closingBracket(at: number): number {
    this.brackets ??= buildPairIndex(this.text, '[', ']');
    return closingOf(this.brackets, at);
  }

  /** The position of `\end{env}` after `from`, or -1; a miss is remembered so an unclosed environment is searched for once. */
  indexOfEnd(envName: string, endTag: string, from: number): number {
    const missing = this.missingEndFrom.get(envName);
    if (missing !== undefined && from >= missing) return -1;
    const found = this.text.indexOf(endTag, from);
    if (found === -1) this.missingEndFrom.set(envName, from);
    return found;
  }
}

function closingOf(index: PairIndex, at: number): number {
  let lo = 0;
  let hi = index.opens.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const value = index.opens[mid];
    if (value === at) return index.closes[mid];
    if (value < at) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function skipOptionalBrackets(src: TexSource, from: number): number {
  const { text } = src;
  let i = from;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1;
  if (text[i] !== '[') return i;
  const close = src.closingBracket(i);
  return close === -1 ? from : close + 1;
}

function readBracedArg(src: TexSource, from: number): { content: string; next: number } | null {
  const { text } = src;
  let i = from;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1;
  if (text[i] !== '{') return null;
  const close = src.closingBrace(i);
  if (close === -1) return null;
  return { content: text.slice(i + 1, close), next: close + 1 };
}

function unescapeTexChars(text: string): string {
  return text
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/``/g, '"')
    .replace(/''/g, '"');
}

function skipEmptyTrailingGroup(text: string, from: number): number {
  let i = from;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1;
  if (text[i] === '{' && text[i + 1] === '}') return i + 2;
  return from;
}

const TEX_CONTROL_TOKEN_AT = /\\[A-Za-z@*]+/y;
const TEX_COMMAND_AT = /([A-Za-z]+)\*?/y;

function skipMacroControlArgs(src: TexSource, from: number, count: number): number {
  const { text } = src;
  let cursor = from;
  // Handle unbraced control sequence name token like \newcommand\foo[1]{bar}
  while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) cursor += 1;
  if (text[cursor] === '\\') {
    TEX_CONTROL_TOKEN_AT.lastIndex = cursor;
    const token = TEX_CONTROL_TOKEN_AT.exec(text);
    if (token) cursor += token[0].length;
  }
  for (let pass = 0; pass < count + 2; pass += 1) {
    cursor = skipOptionalBrackets(src, cursor);
    const braced = readBracedArg(src, cursor);
    if (!braced) break;
    cursor = braced.next;
    cursor = skipOptionalBrackets(src, cursor);
  }
  return cursor;
}

const VERBATIM_TEX_ENVS: ReadonlySet<string> = new Set(['verbatim', 'lstlisting']);
const TEX_CODE_COMMANDS: ReadonlySet<string> = new Set(['texttt', 'code']);

const TEX_INLINE_FORMATS: Readonly<Record<string, (rendered: string) => string>> = {
  textbf: (s) => `**${s}**`,
  bf: (s) => `**${s}**`,
  emph: (s) => `*${s}*`,
  textit: (s) => `*${s}*`,
  it: (s) => `*${s}*`,
  texttt: (s) => `\`${s}\``,
  code: (s) => `\`${s}\``,
  author: (s) => `\n*${s.trim()}*\n`,
  date: (s) => `\n*${s.trim()}*\n`,
};

function readTexBracedPair(
  src: TexSource,
  cursor: number
): { first: { content: string; next: number }; second: { content: string; next: number } } | null {
  const first = readBracedArg(src, cursor);
  if (!first) return null;
  const second = readBracedArg(src, first.next);
  if (!second) return null;
  return { first, second };
}

function consumeTexSimpleEscape(src: TexSource, i: number, out: string[]): number | null {
  const nextChar = src.text[i + 1];
  if (nextChar === '\\') {
    out.push('\n');
    return skipOptionalBrackets(src, i + 2);
  }
  if (nextChar === ' ') {
    out.push(' ');
    return i + 2;
  }
  if ('%$&_#{}'.includes(nextChar)) {
    out.push(nextChar);
    return i + 2;
  }
  return null;
}

function skipTexEnvMandatorySpecs(src: TexSource, envName: string, cursor: number): number {
  let nextCursor = cursor;
  const specCount = ENV_MANDATORY_SPEC_COUNTS[envName] ?? 0;
  for (let s = 0; s < specCount; s += 1) {
    const specArg = readBracedArg(src, nextCursor);
    if (!specArg) break;
    nextCursor = skipOptionalBrackets(src, specArg.next);
  }
  return nextCursor;
}

function consumeTexEnvironment(src: TexSource, cmd: 'begin' | 'end', cursor: number, out: string[]): number | null {
  const envArg = readBracedArg(src, cursor);
  if (!envArg) return null;
  const envName = envArg.content.trim();
  let nextCursor = skipOptionalBrackets(src, envArg.next);
  if (cmd === 'begin') {
    nextCursor = skipTexEnvMandatorySpecs(src, envName, nextCursor);
    if (VERBATIM_TEX_ENVS.has(envName)) {
      const endTag = `\\end{${envName}}`;
      const endIdx = src.indexOfEnd(envName, endTag, nextCursor);
      if (endIdx !== -1) {
        const body = src.text.slice(nextCursor, endIdx).replace(/^\n+|\n+$/g, '');
        out.push(`\n\`\`\`\n${body}\n\`\`\`\n`);
        return endIdx + endTag.length;
      }
    }
  }
  out.push(VERBATIM_TEX_ENVS.has(envName) ? '\n```\n' : '\n');
  return nextCursor;
}

function consumeTexSingleArgCommand(
  src: TexSource,
  cmd: string,
  cursor: number,
  depth: number,
  unescapeProse: boolean,
  out: string[]
): number {
  const firstArg = readBracedArg(src, cursor);
  if (!firstArg) return cursor;
  if (Object.hasOwn(HEADING_COMMANDS, cmd)) {
    const hashes = '#'.repeat(HEADING_COMMANDS[cmd]);
    out.push(`\n\n${hashes} ${transformTexRecursive(firstArg.content, depth + 1, unescapeProse).trim()}\n\n`);
    return firstArg.next;
  }
  if (Object.hasOwn(TEX_INLINE_FORMATS, cmd)) {
    const argUnescape = unescapeProse && !TEX_CODE_COMMANDS.has(cmd);
    out.push(TEX_INLINE_FORMATS[cmd](transformTexRecursive(firstArg.content, depth + 1, argUnescape)));
    return firstArg.next;
  }
  if (cmd === 'url') {
    out.push(firstArg.content.trim());
    return firstArg.next;
  }
  if (PREAMBLE_OR_CONTROL_COMMANDS.has(cmd.toLowerCase())) {
    return firstArg.next;
  }
  out.push(transformTexRecursive(firstArg.content, depth + 1, unescapeProse));
  return firstArg.next;
}

function consumeTexCommand(src: TexSource, i: number, depth: number, unescapeProse: boolean, out: string[]): number {
  const simpleNext = consumeTexSimpleEscape(src, i, out);
  if (simpleNext !== null) return simpleNext;
  TEX_COMMAND_AT.lastIndex = i + 1;
  const cmdMatch = TEX_COMMAND_AT.exec(src.text);
  if (!cmdMatch) {
    out.push(src.text.slice(i, i + 2));
    return i + 2;
  }
  const cmd = cmdMatch[1];
  const cmdLower = cmd.toLowerCase();
  const cursor = skipOptionalBrackets(src, i + 1 + cmdMatch[0].length);
  if (Object.hasOwn(TEX_SPECIAL_SYMBOLS, cmdLower)) {
    out.push(TEX_SPECIAL_SYMBOLS[cmdLower]);
    return skipEmptyTrailingGroup(src.text, cursor);
  }
  if (cmd === 'begin' || cmd === 'end') {
    const envNext = consumeTexEnvironment(src, cmd, cursor, out);
    if (envNext !== null) return envNext;
  }
  if (cmd === 'item') {
    out.push('\n- ');
    return cursor;
  }
  if (cmd === 'href') {
    const pair = readTexBracedPair(src, cursor);
    if (pair) {
      out.push(`[${transformTexRecursive(pair.second.content, depth + 1, unescapeProse)}](${pair.first.content.trim()})`);
      return pair.second.next;
    }
  }
  if (cmdLower === 'textcolor' || cmdLower === 'colorbox') {
    const pair = readTexBracedPair(src, cursor);
    if (pair) {
      out.push(transformTexRecursive(pair.second.content, depth + 1, unescapeProse));
      return pair.second.next;
    }
  }
  if (MULTI_ARG_SUPPRESSED_COMMANDS.has(cmdLower)) return skipMacroControlArgs(src, cursor, 2);
  if (cmdLower === 'newenvironment' || cmdLower === 'renewenvironment') return skipMacroControlArgs(src, cursor, 3);
  return consumeTexSingleArgCommand(src, cmd, cursor, depth, unescapeProse, out);
}

function pushTexProseSlice(tex: string, from: number, to: number, unescapeProse: boolean, out: string[]): void {
  if (to <= from) return;
  const slice = tex.slice(from, to);
  out.push(unescapeProse ? unescapeTexChars(slice) : slice);
}

function transformTexRecursive(tex: string, depth: number, unescapeProse = true): string {
  if (depth > MAX_BRACE_DEPTH) return unescapeProse ? unescapeTexChars(tex) : tex;
  const src = new TexSource(tex);
  const out: string[] = [];
  let i = 0;
  let proseStart = 0;

  while (i < tex.length) {
    const ch = tex[i];
    if (ch === '~') {
      pushTexProseSlice(tex, proseStart, i, unescapeProse, out);
      out.push(' ');
      i += 1;
      proseStart = i;
      continue;
    }
    if (ch === '\\' && i + 1 < tex.length) {
      pushTexProseSlice(tex, proseStart, i, unescapeProse, out);
      i = consumeTexCommand(src, i, depth, unescapeProse, out);
      proseStart = i;
      continue;
    }
    if (ch === '{' || ch === '}') {
      pushTexProseSlice(tex, proseStart, i, unescapeProse, out);
      i += 1;
      proseStart = i;
      continue;
    }
    i += 1;
  }
  pushTexProseSlice(tex, proseStart, tex.length, unescapeProse, out);
  return out.join('');
}

function normalizeMarkdownSpacing(md: string): string {
  return md
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, '').replace(/^[ \t]+(?=- )/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function replaceMarkdownLinksLinear(md: string, format: (label: string, url: string) => string): string {
  if (!md.includes('](')) return md;
  const out: string[] = [];
  let pos = 0;
  while (pos < md.length) {
    const open = md.indexOf('[', pos);
    if (open === -1) break;
    const close = md.indexOf(']', open + 1);
    if (close === -1) break;
    if (md[close + 1] !== '(') {
      out.push(md.slice(pos, close + 1));
      pos = close + 1;
      continue;
    }
    const endParen = md.indexOf(')', close + 2);
    if (endParen === -1) break;
    if (close === open + 1 || endParen === close + 2) {
      out.push(md.slice(pos, close + 1));
      pos = close + 1;
      continue;
    }
    const nestedOpen = md.lastIndexOf('[', close - 1);
    const labelStart = nestedOpen > open ? nestedOpen : open;
    out.push(md.slice(pos, labelStart));
    out.push(format(md.slice(labelStart + 1, close), md.slice(close + 2, endParen)));
    pos = endParen + 1;
  }
  if (pos === 0) return md;
  out.push(md.slice(pos));
  return out.join('');
}

function markdownToReadablePlain(md: string): string {
  return replaceMarkdownLinksLinear(md.replace(/^#{1,6}\s+/gm, ''), (label, url) => `${label} (${url})`)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^```[^\n]*\n?/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function texToMarkdown(tex: string): string {
  assertMarkupWithinLimit(tex, 'tex');
  const withoutComments = stripTexComments(tex);
  return normalizeMarkdownSpacing(transformTexRecursive(withoutComments, 0, true));
}

export function texToPlainText(tex: string): string {
  return markdownToReadablePlain(texToMarkdown(tex));
}

function isRstAdornment(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length < 2) return null;
  const ch = trimmed[0];
  if (!'=~-^"*#+'.includes(ch)) return null;
  for (let i = 1; i < trimmed.length; i += 1) {
    if (trimmed[i] !== ch) return null;
  }
  return ch;
}

function resolveRstHeadingLevel(levelByAdorn: Map<string, number>, key: string): number {
  const existing = levelByAdorn.get(key);
  if (existing !== undefined) return existing;
  const assigned = Math.min(6, levelByAdorn.size + 1);
  levelByAdorn.set(key, assigned);
  return assigned;
}

function tryReadRstHeading(
  lines: readonly string[],
  i: number,
  levelByAdorn: Map<string, number>,
  out: string[]
): number | null {
  const trimmed = lines[i].trim();
  const adorn = isRstAdornment(lines[i]);
  if (adorn && i + 2 < lines.length && lines[i + 1].trim() !== '' && isRstAdornment(lines[i + 2]) === adorn) {
    const level = resolveRstHeadingLevel(levelByAdorn, `overline:${adorn}`);
    out.push(`${'#'.repeat(level)} ${lines[i + 1].trim()}`);
    return i + 2;
  }
  if (i + 1 < lines.length && trimmed !== '' && !adorn) {
    const nextAdorn = isRstAdornment(lines[i + 1]);
    if (nextAdorn && lines[i + 1].trim().length >= trimmed.length) {
      const level = resolveRstHeadingLevel(levelByAdorn, `underline:${nextAdorn}`);
      out.push(`${'#'.repeat(level)} ${trimmed}`);
      return i + 1;
    }
  }
  return null;
}

function consumeRstCodeBlock(lines: readonly string[], i: number, trimmed: string, out: string[]): number | null {
  const codeDirective = /^\.\.\s+(?:code-block|sourcecode|code|parsed-literal)::\s*(.*)$/.exec(trimmed);
  if (!codeDirective) return null;
  const lang = codeDirective[1].trim();
  out.push(`\`\`\`${lang}`);
  let cursor = i + 1;
  // Skip leading directive option lines (e.g. :linenos:, :caption:) before code body
  while (cursor < lines.length && /^[ \t]+:[A-Za-z0-9_-]+:/.test(lines[cursor])) {
    cursor += 1;
  }
  while (cursor < lines.length && (lines[cursor].trim() === '' || /^\s+/.test(lines[cursor]))) {
    if (lines[cursor].trim() !== '') out.push(lines[cursor].replace(/^\s{2,4}/, ''));
    cursor += 1;
  }
  out.push('```');
  return cursor - 1;
}

function consumeRstReference(trimmed: string, out: string[]): boolean {
  const refMatch = /^\.\.\s+_([^:]+):\s*(.+)$/.exec(trimmed);
  if (refMatch) {
    out.push(`${refMatch[1].trim()}: ${refMatch[2].trim()}`);
    return true;
  }
  const anonRefMatch = /^\.\.\s+__:\s*(.+)$/.exec(trimmed);
  if (anonRefMatch) {
    out.push(anonRefMatch[1].trim());
    return true;
  }
  return false;
}

function consumeRstAdmonition(lines: readonly string[], i: number, trimmed: string, out: string[]): number | null {
  const admon = /^\.\.\s+(note|warning|tip|important|caution)::\s*(.*)$/i.exec(trimmed);
  if (!admon) return null;
  const label = admon[1].charAt(0).toUpperCase() + admon[1].slice(1).toLowerCase();
  out.push(`**${label}:** ${admon[2]}`.trim());
  let cursor = i + 1;
  while (cursor < lines.length && (lines[cursor].trim() === '' || /^\s+/.test(lines[cursor]))) {
    out.push(lines[cursor].replace(/^\s{1,4}/, ''));
    cursor += 1;
  }
  return cursor - 1;
}

function skipRstDirective(lines: readonly string[], i: number): number {
  let lastSkipped = i;
  let j = i + 1;
  while (j < lines.length) {
    if (/^[ \t]+\S/.test(lines[j])) {
      lastSkipped = j;
      j += 1;
      continue;
    }
    if (lines[j].trim() === '') {
      let k = j + 1;
      while (k < lines.length && lines[k].trim() === '') k += 1;
      if (k < lines.length && /^[ \t]+\S/.test(lines[k])) {
        lastSkipped = k;
        j = k + 1;
        continue;
      }
    }
    break;
  }
  return lastSkipped;
}

function formatRstInline(line: string): string {
  let cleaned = line
    .replace(/``([^`]+)``/g, '`$1`')
    .replace(/`([^`<\n]+)<([^>`<\n]+)>`_/g, (_m, label: string, url: string) => `[${label.trim()}](${url.trim()})`)
    .replace(/`([^`]+)`_/g, '$1')
    .replace(/^([ \t]*)[*+](\s+)/, '$1-$2');
  if (cleaned.endsWith('::')) cleaned = cleaned.slice(0, -1);
  return cleaned;
}

export function rstToMarkdown(rst: string): string {
  assertMarkupWithinLimit(rst, 'rst');
  const lines = rst.replace(/\r\n?/g, '\n').split('\n');
  const levelByAdorn = new Map<string, number>();
  const out: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const headingEnd = tryReadRstHeading(lines, i, levelByAdorn, out);
    if (headingEnd !== null) { i = headingEnd; continue; }

    const trimmed = lines[i].trim();
    const codeEnd = consumeRstCodeBlock(lines, i, trimmed, out);
    if (codeEnd !== null) { i = codeEnd; continue; }

    if (consumeRstReference(trimmed, out)) continue;

    const admonEnd = consumeRstAdmonition(lines, i, trimmed, out);
    if (admonEnd !== null) { i = admonEnd; continue; }

    if (/^\.\.\s/.test(trimmed) || trimmed === '..') {
      i = skipRstDirective(lines, i);
      continue;
    }

    out.push(formatRstInline(lines[i]));
  }
  return normalizeMarkdownSpacing(out.join('\n'));
}

export function rstToPlainText(rst: string): string {
  return markdownToReadablePlain(rstToMarkdown(rst));
}

function normalizeTroffFontToggles(text: string): string {
  // Replace explicit \fB...\fR / \fB...\fP / \fI...\fR spans linearly
  let out = '';
  let active = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\' && text[i + 1] === 'f') {
      const code = text[i + 2];
      let nextStep = 3;
      if (code === '(' && i + 4 < text.length) {
        nextStep = 5;
      }
      if (code === 'B') {
        if (active) out += active;
        active = '**';
        out += '**';
      } else if (code === 'I') {
        if (active) out += active;
        active = '*';
        out += '*';
      } else if (code === 'C') {
        if (active) out += active;
        active = '`';
        out += '`';
      } else {
        if (active) {
          out += active;
          active = '';
        }
      }
      i += nextStep;
      continue;
    }
    out += text[i];
    i += 1;
  }
  if (active) out += active;
  return out
    .replace(/\\\(em/g, '—')
    .replace(/\\\(en/g, '–')
    .replace(/\\\(bu/g, '•')
    .replace(/\\-/g, '-')
    .replace(/\\&/g, '')
    .replace(/\\e/g, '\\')
    .replace(/\\~/g, ' ')
    .replace(/\\s[+-]?\d+/g, '');
}

function splitMacroArgs(raw: string): string[] {
  const args: string[] = [];
  let cur = '';
  let inQuotes = false;
  let hasToken = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      hasToken = true;
      continue;
    }
    if (!inQuotes && (ch === ' ' || ch === '\t')) {
      if (hasToken) {
        args.push(cur);
        cur = '';
        hasToken = false;
      }
      continue;
    }
    cur += ch;
    hasToken = true;
  }
  if (hasToken) args.push(cur);
  return args;
}

function joinNonEmptyMacroArgs(argStr: string): string {
  return splitMacroArgs(argStr).filter(Boolean).join(' ');
}

function renderAlternatingManMacro(macro: string, rawArgs: string): string {
  const args = splitMacroArgs(rawArgs);
  const firstStyle = macro[0];
  const secondStyle = macro[1];
  const styleToken = (style: string, val: string): string => {
    if (val === '') return '';
    if (style === 'B') return `**${val}**`;
    if (style === 'I') return `*${val}*`;
    return val;
  };
  return args.map((arg, idx) => styleToken(idx % 2 === 0 ? firstStyle : secondStyle, arg)).join('');
}

const MAN_IGNORE_MACROS: ReadonlySet<string> = new Set(['DE', 'DE1', 'DEI', 'IG']);

const MAN_INLINE_FORMATTERS: Readonly<Record<string, (argStr: string, macro: string) => string | null>> = {
  TH: (argStr) => {
    const args = splitMacroArgs(argStr);
    const title = args[0] || 'MANUAL';
    const section = args[1] ? `(${args[1]})` : '';
    return `# ${title}${section}\n`;
  },
  SH: (argStr) => `\n## ${joinNonEmptyMacroArgs(argStr)}\n`,
  SS: (argStr) => `\n### ${joinNonEmptyMacroArgs(argStr)}\n`,
  PP: () => '',
  LP: () => '',
  P: () => '',
  BL: () => '',
  HP: () => '',
  BR: (argStr) => (argStr ? renderAlternatingManMacro('BR', argStr) : ''),
  TP: (argStr) => {
    const tag = splitMacroArgs(argStr)[0];
    return tag ? `\n- **${tag}**` : '';
  },
  IP: (argStr) => {
    const tag = splitMacroArgs(argStr)[0];
    return tag ? `\n- **${tag}**` : '';
  },
  B: (argStr) => {
    const text = joinNonEmptyMacroArgs(argStr);
    return text ? `**${text}**` : null;
  },
  SB: (argStr) => {
    const text = joinNonEmptyMacroArgs(argStr);
    return text ? `**${text}**` : null;
  },
  SY: (argStr) => {
    const text = joinNonEmptyMacroArgs(argStr);
    return text ? `**${text}**` : null;
  },
  I: (argStr) => {
    const text = joinNonEmptyMacroArgs(argStr);
    return text ? `*${text}*` : null;
  },
  BI: (argStr, macro) => renderAlternatingManMacro(macro, argStr),
  IB: (argStr, macro) => renderAlternatingManMacro(macro, argStr),
  IR: (argStr, macro) => renderAlternatingManMacro(macro, argStr),
  RB: (argStr, macro) => renderAlternatingManMacro(macro, argStr),
  RI: (argStr, macro) => renderAlternatingManMacro(macro, argStr),
  OP: (argStr) => {
    const args = splitMacroArgs(argStr).filter(Boolean);
    return args.length > 0 ? `[${args.join(' ')}]` : null;
  },
  UR: (argStr) => argStr || null,
  MT: (argStr) => argStr || null,
  UE: (argStr) => argStr || null,
  ME: (argStr) => argStr || null,
};

interface ManParseState {
  inPre: boolean;
  ignoredEndMarker: string | null;
}

function resolveIgnoredEndMarker(macro: string, argStr: string): string {
  const args = splitMacroArgs(argStr);
  const customEnd = macro === 'IG' ? args[0] : args[1];
  if (!customEnd) return '..';
  return customEnd.startsWith('.') ? customEnd : `.${customEnd}`;
}

function processManMacroLine(rawMacro: string, argStr: string, state: ManParseState, out: string[]): void {
  const macro = rawMacro.toUpperCase();
  if (MAN_IGNORE_MACROS.has(macro)) {
    state.ignoredEndMarker = resolveIgnoredEndMarker(macro, argStr);
    return;
  }
  if (rawMacro === 'br') {
    out.push('');
    return;
  }
  if (macro === 'NF' || macro === 'EX') {
    if (!state.inPre) { out.push('\n```'); state.inPre = true; }
    return;
  }
  if (macro === 'FI' || macro === 'EE') {
    if (state.inPre) { out.push('```\n'); state.inPre = false; }
    return;
  }
  if (Object.hasOwn(MAN_INLINE_FORMATTERS, macro)) {
    const formatted = MAN_INLINE_FORMATTERS[macro](argStr, macro);
    if (formatted !== null) out.push(formatted);
    return;
  }
  if (SILENT_TROFF_DIRECTIVES.has(rawMacro.toLowerCase()) || (rawMacro[0] >= 'a' && rawMacro[0] <= 'z')) {
    return;
  }
  if (argStr && macro !== 'SM') {
    out.push(argStr);
  }
}

export function manToMarkdown(man: string): string {
  assertMarkupWithinLimit(man, 'man');
  const lines = man.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  const state: ManParseState = { inPre: false, ignoredEndMarker: null };

  for (const rawLine of lines) {
    if (state.ignoredEndMarker !== null) {
      if (rawLine.trim() === state.ignoredEndMarker) state.ignoredEndMarker = null;
      continue;
    }
    if (/^[.']\\?["#]/.test(rawLine) || rawLine.startsWith("'''")) continue;
    const line = normalizeTroffFontToggles(rawLine);

    if (!line.startsWith('.') && !line.startsWith("'")) {
      out.push(line);
      continue;
    }

    const macroMatch = /^[.']\s*([A-Za-z0-9]+)(?:\s+(.*))?$/.exec(line);
    if (!macroMatch) continue;
    processManMacroLine(macroMatch[1], (macroMatch[2] ?? '').trim(), state, out);
  }
  if (state.inPre) out.push('```');
  return normalizeMarkdownSpacing(out.join('\n'));
}

export function manToPlainText(man: string): string {
  return markdownToReadablePlain(manToMarkdown(man));
}

export const MARKUP_SOURCE_FORMATS: ReadonlySet<string> = new Set(['tex', 'latex', 'rst', 'man']);

export function isMarkupTextSource(format: string): boolean {
  return MARKUP_SOURCE_FORMATS.has(format);
}

export function markupToMarkdown(text: string, format: string): string {
  if (format === 'tex' || format === 'latex') return texToMarkdown(text);
  if (format === 'rst') return rstToMarkdown(text);
  if (format === 'man') return manToMarkdown(text);
  return text;
}

export function markupToPlainText(text: string, format: string): string {
  if (format === 'tex' || format === 'latex') return texToPlainText(text);
  if (format === 'rst') return rstToPlainText(text);
  if (format === 'man') return manToPlainText(text);
  return text;
}
