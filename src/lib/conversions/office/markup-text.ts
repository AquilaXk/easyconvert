import { ConversionFailedError } from '../../types';

/**
 * Clean, linear-time converters turning LaTeX/TeX, reStructuredText (RST), and troff/groff man pages
 * into structured Markdown or clean plain text without leaking preamble/macro directives.
 */

const MAX_MARKUP_CHARS = 32 * 1024 * 1024;
const MAX_BRACE_DEPTH = 32;

const PREAMBLE_OR_CONTROL_COMMANDS: ReadonlySet<string> = new Set([
  'documentclass', 'usepackage', 'usetikzlibrary', 'usetheme', 'geometry', 'hypersetup',
  'setlength', 'pagestyle', 'thispagestyle', 'bibliographystyle', 'bibliography',
  'newcommand', 'renewcommand', 'providecommand', 'newenvironment', 'theoremstyle',
  'maketitle', 'tableofcontents', 'listoffigures', 'listoftables', 'newpage', 'clearpage',
  'cleardoublepage', 'pagebreak', 'noindent', 'centering', 'raggedright', 'raggedleft',
  'hfill', 'vfill', 'hspace', 'vspace', 'label', 'index', 'footnote',
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
    .replace(/\\([%$&_#{}])/g, '$1')
    .replace(/\\textbackslash\b/g, '\\')
    .replace(/\\textasciitilde\b/g, '~')
    .replace(/\\\\/g, '\n')
    .replace(/~/g, ' ')
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/``/g, '"')
    .replace(/''/g, '"');
}

function transformTexRecursive(tex: string, depth: number): string {
  if (depth > MAX_BRACE_DEPTH) return tex;
  const out: string[] = [];
  let i = 0;

  while (i < tex.length) {
    if (tex[i] === '\\' && i + 1 < tex.length) {
      const rest = tex.slice(i + 1);
      const cmdMatch = /^([A-Za-z]+)\*?/.exec(rest);
      if (!cmdMatch) {
        out.push(tex.slice(i, i + 2));
        i += 2;
        continue;
      }
      const cmd = cmdMatch[1];
      let cursor = i + 1 + cmdMatch[0].length;
      cursor = skipOptionalBrackets(tex, cursor);

      if (cmd === 'begin' || cmd === 'end') {
        const envArg = readBracedArg(tex, cursor);
        if (envArg) {
          cursor = skipOptionalBrackets(tex, envArg.next);
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
      if (PREAMBLE_OR_CONTROL_COMMANDS.has(cmd)) {
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

    if (/^\.\.\s+code-block::/.test(trimmed)) {
      const lang = trimmed.replace(/^\.\.\s+code-block::\s*/, '').trim();
      out.push(`\`\`\`${lang}`);
      i += 1;
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
      continue;
    }

    let cleaned = line
      .replace(/``([^`]+)``/g, '`$1`')
      .replace(/`([^`<]+?)\s*<([^>]+)>`_/g, (_m, label: string, url: string) => `[${label.trim()}](${url.trim()})`)
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

  for (const rawLine of lines) {
    if (/^[.']\\?"/.test(rawLine) || rawLine.startsWith("'''")) continue;
    const line = normalizeTroffFontToggles(rawLine);

    if (!line.startsWith('.') && !line.startsWith("'")) {
      out.push(line);
      continue;
    }

    const macroMatch = /^[.']\s*([A-Za-z0-9]+)(?:\s+(.*))?$/.exec(line);
    if (!macroMatch) continue;
    const macro = macroMatch[1].toUpperCase();
    const argStr = (macroMatch[2] ?? '').trim();

    if (macro === 'TH') {
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
    } else if (macro === 'B') {
      if (argStr) out.push(`**${splitMacroArgs(argStr).join(' ')}**`);
    } else if (macro === 'I') {
      if (argStr) out.push(`*${splitMacroArgs(argStr).join(' ')}*`);
    } else if (macro === 'BI' || macro === 'IB' || macro === 'IR' || macro === 'RB' || macro === 'RI') {
      out.push(renderAlternatingManMacro(macro, argStr));
    } else if (macro === 'NF') {
      if (!inPre) { out.push('\n```'); inPre = true; }
    } else if (macro === 'FI') {
      if (inPre) { out.push('```\n'); inPre = false; }
    } else if (macro === 'BL' || macro === 'HP') {
      out.push('');
    } else if (argStr && macro !== 'SM' && macro !== 'SH') {
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
