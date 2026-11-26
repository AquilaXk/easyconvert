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
      if (tex[i + 1] === '\\') {
        out.push('\n');
        i = skipOptionalBrackets(tex, i + 2);
        continue;
      }
      if (tex[i + 1] === ' ') {
        out.push(' ');
        i += 2;
        continue;
      }
      if ('%$&_#{}'.includes(tex[i + 1])) {
        out.push(tex[i + 1]);
        i += 2;
        continue;
      }
      const rest = tex.slice(i + 1);
      const cmdMatch = /^([A-Za-z]+)\*?/.exec(rest);
      if (!cmdMatch) {
        out.push(tex.slice(i, i + 2));
        i += 2;
        continue;
      }
      const cmd = cmdMatch[1];
      const cmdLower = cmd.toLowerCase();
      let cursor = i + 1 + cmdMatch[0].length;
      cursor = skipOptionalBrackets(tex, cursor);

      if (Object.hasOwn(TEX_SPECIAL_SYMBOLS, cmdLower)) {
        out.push(TEX_SPECIAL_SYMBOLS[cmdLower]);
        i = skipEmptyTrailingGroup(tex, cursor);
        continue;
      }

      if (cmd === 'begin' || cmd === 'end') {
        const envArg = readBracedArg(tex, cursor);
        if (envArg) {
          cursor = skipOptionalBrackets(tex, envArg.next);
          if (cmd === 'begin') {
            const specCount = ENV_MANDATORY_SPEC_COUNTS[envArg.content.trim()] ?? 0;
            for (let s = 0; s < specCount; s += 1) {
              const specArg = readBracedArg(tex, cursor);
              if (!specArg) break;
              cursor = skipOptionalBrackets(tex, specArg.next);
            }
          }
          if (cmd === 'begin' && (envArg.content === 'verbatim' || envArg.content === 'lstlisting')) {
            out.push('\n```\n');
          } else if (cmd === 'end' && (envArg.content === 'verbatim' || envArg.content === 'lstlisting')) {
            out.push('\n```\n');
          } else {
            out.push('\n');
          }
          i = cursor;
          continue;
        }
      }

      if (cmd === 'item') {
        out.push('\n- ');
        i = cursor;
        continue;
      }

      if (cmd === 'href') {
        const urlArg = readBracedArg(tex, cursor);
        if (urlArg) {
          const labelArg = readBracedArg(tex, urlArg.next);
          if (labelArg) {
            out.push(`[${transformTexRecursive(labelArg.content, depth + 1)}](${urlArg.content.trim()})`);
            i = labelArg.next;
            continue;
          }
        }
      }

      if (cmdLower === 'textcolor' || cmdLower === 'colorbox') {
        const colorArg = readBracedArg(tex, cursor);
        if (colorArg) {
          const contentArg = readBracedArg(tex, colorArg.next);
          if (contentArg) {
            out.push(transformTexRecursive(contentArg.content, depth + 1));
            i = contentArg.next;
            continue;
          }
        }
      }

      if (MULTI_ARG_SUPPRESSED_COMMANDS.has(cmdLower)) {
        i = skipMacroControlArgs(tex, cursor, 2);
        continue;
      }

      if (cmdLower === 'newenvironment' || cmdLower === 'renewenvironment') {
        i = skipMacroControlArgs(tex, cursor, 3);
        continue;
      }

      const firstArg = readBracedArg(tex, cursor);
      if (cmd in HEADING_COMMANDS && firstArg) {
        const hashes = '#'.repeat(HEADING_COMMANDS[cmd]);
        out.push(`\n\n${hashes} ${transformTexRecursive(firstArg.content, depth + 1).trim()}\n\n`);
        i = firstArg.next;
        continue;
      }
      if ((cmd === 'textbf' || cmd === 'bf') && firstArg) {
        out.push(`**${transformTexRecursive(firstArg.content, depth + 1)}**`);
        i = firstArg.next;
        continue;
      }
      if ((cmd === 'emph' || cmd === 'textit' || cmd === 'it') && firstArg) {
        out.push(`*${transformTexRecursive(firstArg.content, depth + 1)}*`);
        i = firstArg.next;
        continue;
      }
      if ((cmd === 'texttt' || cmd === 'code') && firstArg) {
        out.push(`\`${transformTexRecursive(firstArg.content, depth + 1)}\``);
        i = firstArg.next;
        continue;
      }
      if (cmd === 'url' && firstArg) {
        out.push(firstArg.content.trim());
        i = firstArg.next;
        continue;
      }
      if (cmd === 'author' || cmd === 'date') {
        if (firstArg) {
          out.push(`\n*${transformTexRecursive(firstArg.content, depth + 1).trim()}*\n`);
          i = firstArg.next;
          continue;
        }
      }
      if (PREAMBLE_OR_CONTROL_COMMANDS.has(cmdLower)) {
        i = firstArg ? firstArg.next : cursor;
        continue;
      }
      if (firstArg) {
        out.push(transformTexRecursive(firstArg.content, depth + 1));
        i = firstArg.next;
        continue;
      }
      i = cursor;
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

export function rstToMarkdown(rst: string): string {
  assertMarkupWithinLimit(rst, 'rst');
  const lines = rst.replace(/\r\n?/g, '\n').split('\n');
  const levelByAdorn = new Map<string, number>();
  const levelFor = (key: string): number => {
    const existing = levelByAdorn.get(key);
    if (existing !== undefined) return existing;
    const assigned = Math.min(6, levelByAdorn.size + 1);
    levelByAdorn.set(key, assigned);
    return assigned;
  };

  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    const adorn = isRstAdornment(line);

    // Overline + title + underline heading
    if (adorn && i + 2 < lines.length && lines[i + 1].trim() !== '' && isRstAdornment(lines[i + 2]) === adorn) {
      const level = levelFor(`overline:${adorn}`);
      out.push(`${'#'.repeat(level)} ${lines[i + 1].trim()}`);
      i += 2;
      continue;
    }

    // Underline heading
    if (i + 1 < lines.length && trimmed !== '' && !adorn) {
      const nextAdorn = isRstAdornment(lines[i + 1]);
      if (nextAdorn && lines[i + 1].trim().length >= trimmed.length) {
        const level = levelFor(`underline:${nextAdorn}`);
        out.push(`${'#'.repeat(level)} ${trimmed}`);
        i += 1;
        continue;
      }
    }

    const codeDirective = /^\.\.\s+(?:code-block|sourcecode|code|parsed-literal)::\s*(.*)$/.exec(trimmed);
    if (codeDirective) {
      const lang = codeDirective[1].trim();
      out.push(`\`\`\`${lang}`);
      i += 1;
      // Skip leading directive option lines (e.g. :linenos:, :caption:) before code body
      while (i < lines.length && /^[ \t]+:[A-Za-z0-9_-]+:/.test(lines[i])) {
        i += 1;
      }
      while (i < lines.length && (lines[i].trim() === '' || /^\s+/.test(lines[i]))) {
        if (lines[i].trim() !== '') out.push(lines[i].replace(/^\s{2,4}/, ''));
        i += 1;
      }
      out.push('```');
      i -= 1;
      continue;
    }

    const refMatch = /^\.\.\s+_([^:]+):\s*(.+)$/.exec(trimmed);
    if (refMatch) {
      out.push(`${refMatch[1].trim()}: ${refMatch[2].trim()}`);
      continue;
    }

    const anonRefMatch = /^\.\.\s+__:\s*(.+)$/.exec(trimmed);
    if (anonRefMatch) {
      out.push(anonRefMatch[1].trim());
      continue;
    }

    const admon = /^\.\.\s+(note|warning|tip|important|caution)::\s*(.*)$/i.exec(trimmed);
    if (admon) {
      const label = admon[1].charAt(0).toUpperCase() + admon[1].slice(1).toLowerCase();
      out.push(`**${label}:** ${admon[2]}`.trim());
      i += 1;
      while (i < lines.length && (lines[i].trim() === '' || /^\s+/.test(lines[i]))) {
        out.push(lines[i].replace(/^\s{1,4}/, ''));
        i += 1;
      }
      i -= 1;
      continue;
    }
    if (/^\.\.\s/.test(trimmed) || trimmed === '..') {
      // Skip explicit RST directive / comment blocks and all indented option/body lines beneath them.
      let j = i + 1;
      while (j < lines.length) {
        if (/^[ \t]+\S/.test(lines[j])) {
          i = j;
          j += 1;
          continue;
        }
        if (lines[j].trim() === '') {
          let k = j + 1;
          while (k < lines.length && lines[k].trim() === '') k += 1;
          if (k < lines.length && /^[ \t]+\S/.test(lines[k])) {
            i = k;
            j = k + 1;
            continue;
          }
        }
        break;
      }
      continue;
    }

    let cleaned = line
      .replace(/``([^`]+)``/g, '`$1`')
      .replace(/`([^`<\n]+)<([^>`<\n]+)>`_/g, (_m, label: string, url: string) => `[${label.trim()}](${url.trim()})`)
      .replace(/`([^`]+)`_/g, '$1')
      .replace(/^([ \t]*)[*+](\s+)/, '$1-$2');
    if (cleaned.endsWith('::')) cleaned = cleaned.slice(0, -1);
    out.push(cleaned);
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

export function manToMarkdown(man: string): string {
  assertMarkupWithinLimit(man, 'man');
  const lines = man.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let inPre = false;
  let ignoredEndMarker: string | null = null;

  for (const rawLine of lines) {
    if (ignoredEndMarker !== null) {
      if (rawLine.trim() === ignoredEndMarker) ignoredEndMarker = null;
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
    const rawMacro = macroMatch[1];
    const macro = rawMacro.toUpperCase();
    const argStr = (macroMatch[2] ?? '').trim();

    if (macro === 'DE' || macro === 'DE1' || macro === 'DEI' || macro === 'IG') {
      const args = splitMacroArgs(argStr);
      const customEnd = macro === 'IG' ? args[0] : args[1];
      ignoredEndMarker = customEnd ? (customEnd.startsWith('.') ? customEnd : `.${customEnd}`) : '..';
      continue;
    }

    if (rawMacro === 'br') {
      out.push('');
    } else if (macro === 'TH') {
      const args = splitMacroArgs(argStr);
      const title = args[0] ?? 'MANUAL';
      const section = args[1] ? `(${args[1]})` : '';
      out.push(`# ${title}${section}\n`);
    } else if (macro === 'SH') {
      out.push(`\n## ${splitMacroArgs(argStr).join(' ')}\n`);
    } else if (macro === 'SS') {
      out.push(`\n### ${splitMacroArgs(argStr).join(' ')}\n`);
    } else if (macro === 'PP' || macro === 'LP' || macro === 'P') {
      out.push('');
    } else if (macro === 'BR') {
      out.push(argStr ? renderAlternatingManMacro('BR', argStr) : '');
    } else if (macro === 'TP' || macro === 'IP') {
      if (argStr) out.push(`\n- **${splitMacroArgs(argStr)[0]}**`);
      else out.push('');
    } else if (macro === 'B' || macro === 'SB') {
      if (argStr) out.push(`**${splitMacroArgs(argStr).join(' ')}**`);
    } else if (macro === 'I') {
      if (argStr) out.push(`*${splitMacroArgs(argStr).join(' ')}*`);
    } else if (macro === 'BI' || macro === 'IB' || macro === 'IR' || macro === 'RB' || macro === 'RI') {
      out.push(renderAlternatingManMacro(macro, argStr));
    } else if (macro === 'NF' || macro === 'EX') {
      if (!inPre) { out.push('\n```'); inPre = true; }
    } else if (macro === 'FI' || macro === 'EE') {
      if (inPre) { out.push('```\n'); inPre = false; }
    } else if (macro === 'SY') {
      if (argStr) out.push(`**${splitMacroArgs(argStr).join(' ')}**`);
    } else if (macro === 'OP') {
      const args = splitMacroArgs(argStr);
      if (args.length > 0) out.push(`[${args.join(' ')}]`);
    } else if (macro === 'UR' || macro === 'MT' || macro === 'UE' || macro === 'ME') {
      if (argStr) out.push(argStr);
    } else if (macro === 'BL' || macro === 'HP') {
      out.push('');
    } else if (
      SILENT_TROFF_DIRECTIVES.has(rawMacro.toLowerCase()) ||
      (rawMacro[0] >= 'a' && rawMacro[0] <= 'z')
    ) {
      continue;
    } else if (argStr && macro !== 'SM') {
      out.push(argStr);
    }
  }
  if (inPre) out.push('```');
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
