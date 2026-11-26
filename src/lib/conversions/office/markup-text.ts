import { ConversionFailedError } from '../../types';

/**
 * Clean, linear-time converters turning LaTeX/TeX, reStructuredText (RST), and troff/groff man pages
 * into structured Markdown or clean plain text without leaking preamble/macro directives.
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

function skipOptionalBrackets(text: string, from: number): number {
  let i = from;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1;
  if (text[i] !== '[') return i;
  let depth = 0;
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) { i += 2; continue; }
    if (text[i] === '[') depth += 1;
    else if (text[i] === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return from;
}

function readBracedArg(text: string, from: number): { content: string; next: number } | null {
  let i = from;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1;
  if (text[i] !== '{') return null;
  let depth = 0;
  const start = i + 1;
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) { i += 2; continue; }
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return { content: text.slice(start, i), next: i + 1 };
    }
    i += 1;
  }
  return null;
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

function skipMacroControlArgs(text: string, from: number, count: number): number {
  let cursor = from;
  // Handle unbraced control sequence name token like \newcommand\foo[1]{bar}
  while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) cursor += 1;
  if (text[cursor] === '\\') {
    const token = /^\\[A-Za-z@*]+/.exec(text.slice(cursor));
    if (token) cursor += token[0].length;
  }
  for (let pass = 0; pass < count + 2; pass += 1) {
    cursor = skipOptionalBrackets(text, cursor);
    const braced = readBracedArg(text, cursor);
    if (!braced) break;
    cursor = braced.next;
    cursor = skipOptionalBrackets(text, cursor);
  }
  return cursor;
}

const VERBATIM_TEX_ENVS: ReadonlySet<string> = new Set(['verbatim', 'lstlisting']);

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
  text: string,
  cursor: number
): { first: { content: string; next: number }; second: { content: string; next: number } } | null {
  const first = readBracedArg(text, cursor);
  if (!first) return null;
  const second = readBracedArg(text, first.next);
  if (!second) return null;
  return { first, second };
}

function consumeTexSimpleEscape(tex: string, i: number, out: string[]): number | null {
  const nextChar = tex[i + 1];
  if (nextChar === '\\') {
    out.push('\n');
    return skipOptionalBrackets(tex, i + 2);
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

function consumeTexEnvironment(tex: string, cmd: 'begin' | 'end', cursor: number, out: string[]): number | null {
  const envArg = readBracedArg(tex, cursor);
  if (!envArg) return null;
  let nextCursor = skipOptionalBrackets(tex, envArg.next);
  if (cmd === 'begin') {
    const specCount = ENV_MANDATORY_SPEC_COUNTS[envArg.content.trim()] ?? 0;
    for (let s = 0; s < specCount; s += 1) {
      const specArg = readBracedArg(tex, nextCursor);
      if (!specArg) break;
      nextCursor = skipOptionalBrackets(tex, specArg.next);
    }
  }
  out.push(VERBATIM_TEX_ENVS.has(envArg.content) ? '\n```\n' : '\n');
  return nextCursor;
}

function consumeTexSingleArgCommand(
  tex: string,
  cmd: string,
  cmdLower: string,
  cursor: number,
  depth: number,
  out: string[]
): number {
  const firstArg = readBracedArg(tex, cursor);
  if (!firstArg) return cursor;
  if (Object.hasOwn(HEADING_COMMANDS, cmd)) {
    const hashes = '#'.repeat(HEADING_COMMANDS[cmd]);
    out.push(`\n\n${hashes} ${transformTexRecursive(firstArg.content, depth + 1).trim()}\n\n`);
    return firstArg.next;
  }
  if (Object.hasOwn(TEX_INLINE_FORMATS, cmd)) {
    out.push(TEX_INLINE_FORMATS[cmd](transformTexRecursive(firstArg.content, depth + 1)));
    return firstArg.next;
  }
  if (cmd === 'url') {
    out.push(firstArg.content.trim());
    return firstArg.next;
  }
  if (PREAMBLE_OR_CONTROL_COMMANDS.has(cmdLower)) {
    return firstArg.next;
  }
  out.push(transformTexRecursive(firstArg.content, depth + 1));
  return firstArg.next;
}

function consumeTexCommand(tex: string, i: number, depth: number, out: string[]): number {
  const simpleNext = consumeTexSimpleEscape(tex, i, out);
  if (simpleNext !== null) return simpleNext;
  const cmdMatch = /^([A-Za-z]+)\*?/.exec(tex.slice(i + 1));
  if (!cmdMatch) {
    out.push(tex.slice(i, i + 2));
    return i + 2;
  }
  const cmd = cmdMatch[1];
  const cmdLower = cmd.toLowerCase();
  const cursor = skipOptionalBrackets(tex, i + 1 + cmdMatch[0].length);
  if (Object.hasOwn(TEX_SPECIAL_SYMBOLS, cmdLower)) {
    out.push(TEX_SPECIAL_SYMBOLS[cmdLower]);
    return skipEmptyTrailingGroup(tex, cursor);
  }
  if (cmd === 'begin' || cmd === 'end') {
    const envNext = consumeTexEnvironment(tex, cmd, cursor, out);
    if (envNext !== null) return envNext;
  }
  if (cmd === 'item') {
    out.push('\n- ');
    return cursor;
  }
  if (cmd === 'href') {
    const pair = readTexBracedPair(tex, cursor);
    if (pair) {
      out.push(`[${transformTexRecursive(pair.second.content, depth + 1)}](${pair.first.content.trim()})`);
      return pair.second.next;
    }
  }
  if (cmdLower === 'textcolor' || cmdLower === 'colorbox') {
    const pair = readTexBracedPair(tex, cursor);
    if (pair) {
      out.push(transformTexRecursive(pair.second.content, depth + 1));
      return pair.second.next;
    }
  }
  if (MULTI_ARG_SUPPRESSED_COMMANDS.has(cmdLower)) return skipMacroControlArgs(tex, cursor, 2);
  if (cmdLower === 'newenvironment' || cmdLower === 'renewenvironment') return skipMacroControlArgs(tex, cursor, 3);
  return consumeTexSingleArgCommand(tex, cmd, cmdLower, cursor, depth, out);
}

function transformTexRecursive(tex: string, depth: number): string {
  if (depth > MAX_BRACE_DEPTH) return tex;
  const out: string[] = [];
  let i = 0;

  while (i < tex.length) {
    if (tex[i] === '~') {
      out.push(' ');
      i += 1;
      continue;
    }
    if (tex[i] === '\\' && i + 1 < tex.length) {
      i = consumeTexCommand(tex, i, depth, out);
      continue;
    }
    if (tex[i] === '{' || tex[i] === '}') {
      i += 1;
      continue;
    }
    out.push(tex[i]);
    i += 1;
  }
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

function markdownToReadablePlain(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^```[^\n]*\n?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function texToMarkdown(tex: string): string {
  assertMarkupWithinLimit(tex, 'tex');
  const withoutComments = stripTexComments(tex);
  const converted = unescapeTexChars(transformTexRecursive(withoutComments, 0));
  return normalizeMarkdownSpacing(converted);
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
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === ' ' || ch === '\t')) {
      if (cur !== '') { args.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur !== '') args.push(cur);
  return args;
}

function renderAlternatingManMacro(macro: string, rawArgs: string): string {
  const args = splitMacroArgs(rawArgs);
  const firstStyle = macro[0];
  const secondStyle = macro[1];
  const styleToken = (style: string, val: string): string => {
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
    const title = args[0] ?? 'MANUAL';
    const section = args[1] ? `(${args[1]})` : '';
    return `# ${title}${section}\n`;
  },
  SH: (argStr) => `\n## ${splitMacroArgs(argStr).join(' ')}\n`,
  SS: (argStr) => `\n### ${splitMacroArgs(argStr).join(' ')}\n`,
  PP: () => '',
  LP: () => '',
  P: () => '',
  BL: () => '',
  HP: () => '',
  BR: (argStr) => (argStr ? renderAlternatingManMacro('BR', argStr) : ''),
  TP: (argStr) => (argStr ? `\n- **${splitMacroArgs(argStr)[0]}**` : ''),
  IP: (argStr) => (argStr ? `\n- **${splitMacroArgs(argStr)[0]}**` : ''),
  B: (argStr) => (argStr ? `**${splitMacroArgs(argStr).join(' ')}**` : null),
  SB: (argStr) => (argStr ? `**${splitMacroArgs(argStr).join(' ')}**` : null),
  SY: (argStr) => (argStr ? `**${splitMacroArgs(argStr).join(' ')}**` : null),
  I: (argStr) => (argStr ? `*${splitMacroArgs(argStr).join(' ')}*` : null),
  BI: (argStr, macro) => renderAlternatingManMacro(macro, argStr),
  IB: (argStr, macro) => renderAlternatingManMacro(macro, argStr),
  IR: (argStr, macro) => renderAlternatingManMacro(macro, argStr),
  RB: (argStr, macro) => renderAlternatingManMacro(macro, argStr),
  RI: (argStr, macro) => renderAlternatingManMacro(macro, argStr),
  OP: (argStr) => {
    const args = splitMacroArgs(argStr);
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
