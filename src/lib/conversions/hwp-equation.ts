import { CorruptStreamError } from '../types';

/**
 * Transpiler for the equation scripts of the Hangul word processor (HWPTAG_EQEDIT) to MathML and LaTeX.
 *
 * A script is parsed into a tree and both outputs are written from that tree, so they always agree. The language
 * covered: numbers, letters (a word that is not a keyword is read letter by letter, as the editor does), Greek
 * letters and symbols, braces for grouping, `_` and `^` (also `sub` and `sup`) for scripts, `over` and `atop` for
 * fractions, `sqrt`, `root .. of ..`, `sum` `prod` `int` `oint` `lim` with limits, `left .. right` fences,
 * `matrix` / `pmatrix` / `bmatrix` / `dmatrix` / `cases` / `pile` with `&` and `#` separators, the style words
 * `rm` `it` `bold`, accents, quoted text and the spacing marks `~` and a backquote. A script that does not
 * parse (an unclosed brace, an operator without its operand) throws a CorruptStreamError.
 */

export const HWP_EQ_GREEK: Record<string, { mathml: string; latex: string }> = {
  alpha: { mathml: 'α', latex: '\\alpha' },
  beta: { mathml: 'β', latex: '\\beta' },
  gamma: { mathml: 'γ', latex: '\\gamma' },
  delta: { mathml: 'δ', latex: '\\delta' },
  epsilon: { mathml: 'ε', latex: '\\epsilon' },
  zeta: { mathml: 'ζ', latex: '\\zeta' },
  eta: { mathml: 'η', latex: '\\eta' },
  theta: { mathml: 'θ', latex: '\\theta' },
  iota: { mathml: 'ι', latex: '\\iota' },
  kappa: { mathml: 'κ', latex: '\\kappa' },
  lambda: { mathml: 'λ', latex: '\\lambda' },
  mu: { mathml: 'μ', latex: '\\mu' },
  nu: { mathml: 'ν', latex: '\\nu' },
  xi: { mathml: 'ξ', latex: '\\xi' },
  pi: { mathml: 'π', latex: '\\pi' },
  rho: { mathml: 'ρ', latex: '\\rho' },
  sigma: { mathml: 'σ', latex: '\\sigma' },
  tau: { mathml: 'τ', latex: '\\tau' },
  upsilon: { mathml: 'υ', latex: '\\upsilon' },
  phi: { mathml: 'φ', latex: '\\phi' },
  chi: { mathml: 'χ', latex: '\\chi' },
  psi: { mathml: 'ψ', latex: '\\psi' },
  omega: { mathml: 'ω', latex: '\\omega' },
  Gamma: { mathml: 'Γ', latex: '\\Gamma' },
  Delta: { mathml: 'Δ', latex: '\\Delta' },
  Theta: { mathml: 'Θ', latex: '\\Theta' },
  Lambda: { mathml: 'Λ', latex: '\\Lambda' },
  Xi: { mathml: 'Ξ', latex: '\\Xi' },
  Pi: { mathml: 'Π', latex: '\\Pi' },
  Sigma: { mathml: 'Σ', latex: '\\Sigma' },
  Phi: { mathml: 'Φ', latex: '\\Phi' },
  Psi: { mathml: 'Ψ', latex: '\\Psi' },
  Omega: { mathml: 'Ω', latex: '\\Omega' },
};

export const HWP_EQ_SYMBOLS: Record<string, { mathml: string; latex: string }> = {
  pm: { mathml: '±', latex: '\\pm' },
  mp: { mathml: '∓', latex: '\\mp' },
  times: { mathml: '×', latex: '\\times' },
  div: { mathml: '÷', latex: '\\div' },
  cdot: { mathml: '·', latex: '\\cdot' },
  circ: { mathml: '∘', latex: '\\circ' },
  le: { mathml: '≤', latex: '\\le' },
  ge: { mathml: '≥', latex: '\\ge' },
  ne: { mathml: '≠', latex: '\\ne' },
  approx: { mathml: '≈', latex: '\\approx' },
  equiv: { mathml: '≡', latex: '\\equiv' },
  sim: { mathml: '∼', latex: '\\sim' },
  propto: { mathml: '∝', latex: '\\propto' },
  to: { mathml: '→', latex: '\\to' },
  rightarrow: { mathml: '→', latex: '\\to' },
  leftarrow: { mathml: '←', latex: '\\leftarrow' },
  infty: { mathml: '∞', latex: '\\infty' },
  inf: { mathml: '∞', latex: '\\infty' },
  partial: { mathml: '∂', latex: '\\partial' },
  nabla: { mathml: '∇', latex: '\\nabla' },
  forall: { mathml: '∀', latex: '\\forall' },
  exists: { mathml: '∃', latex: '\\exists' },
  in: { mathml: '∈', latex: '\\in' },
  notin: { mathml: '∉', latex: '\\notin' },
  subset: { mathml: '⊂', latex: '\\subset' },
  supset: { mathml: '⊃', latex: '\\supset' },
  cup: { mathml: '∪', latex: '\\cup' },
  cap: { mathml: '∩', latex: '\\cap' },
  emptyset: { mathml: '∅', latex: '\\emptyset' },
  therefore: { mathml: '∴', latex: '\\therefore' },
  angle: { mathml: '∠', latex: '\\angle' },
  perp: { mathml: '⊥', latex: '\\perp' },
  prime: { mathml: '′', latex: '\\prime' },
  cdots: { mathml: '⋯', latex: '\\cdots' },
  ldots: { mathml: '…', latex: '\\ldots' },
  hbar: { mathml: 'ℏ', latex: '\\hbar' },
};

/** Function names written upright: `<mi>sin</mi>` and `\sin`. */
const FUNCTION_NAMES: ReadonlySet<string> = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh', 'coth', 'arcsin', 'arccos', 'arctan',
  'log', 'ln', 'exp', 'det', 'min', 'max', 'gcd', 'mod',
]);

const BIG_OPERATORS: Readonly<Record<string, { glyph: string; latex: string; stacked: boolean }>> = {
  sum: { glyph: '∑', latex: '\\sum', stacked: true },
  prod: { glyph: '∏', latex: '\\prod', stacked: true },
  int: { glyph: '∫', latex: '\\int', stacked: false },
  oint: { glyph: '∮', latex: '\\oint', stacked: false },
  lim: { glyph: 'lim', latex: '\\lim', stacked: true },
};

const ACCENTS: Readonly<Record<string, { glyph: string; latex: string; under: boolean }>> = {
  hat: { glyph: '^', latex: '\\hat', under: false },
  bar: { glyph: '¯', latex: '\\bar', under: false },
  vec: { glyph: '→', latex: '\\vec', under: false },
  dot: { glyph: '˙', latex: '\\dot', under: false },
  ddot: { glyph: '¨', latex: '\\ddot', under: false },
  tilde: { glyph: '~', latex: '\\tilde', under: false },
  acute: { glyph: '´', latex: '\\acute', under: false },
  grave: { glyph: '`', latex: '\\grave', under: false },
  check: { glyph: 'ˇ', latex: '\\check', under: false },
  under: { glyph: '_', latex: '\\underline', under: true },
};

const STYLES: Readonly<Record<string, { variant: string; latex: string }>> = {
  rm: { variant: 'normal', latex: '\\mathrm' },
  it: { variant: 'italic', latex: '\\mathit' },
  bold: { variant: 'bold', latex: '\\mathbf' },
};

const MATRICES: Readonly<Record<string, { open: string; close: string; env: string }>> = {
  matrix: { open: '', close: '', env: 'matrix' },
  pmatrix: { open: '(', close: ')', env: 'pmatrix' },
  bmatrix: { open: '[', close: ']', env: 'bmatrix' },
  dmatrix: { open: '|', close: '|', env: 'vmatrix' },
};

const MULTI_CHARACTER_OPERATORS: Readonly<Record<string, string>> = {
  '<=': '≤', '>=': '≥', '!=': '≠', '->': '→', '<-': '←', '+-': '±', '-+': '∓',
};
const MULTI_CHARACTER_LATEX: Readonly<Record<string, string>> = {
  '<=': '\\le ', '>=': '\\ge ', '!=': '\\ne ', '->': '\\to ', '<-': '\\leftarrow ', '+-': '\\pm ', '-+': '\\mp ',
};

const has = (table: object, key: string): boolean => Object.prototype.hasOwnProperty.call(table, key);

const EM_SPACE = '1em';
const THIN_SPACE = '0.17em';
const MAX_SCRIPT_LENGTH = 100_000;
const MAX_NESTING_DEPTH = 64;

type EqToken =
  | { kind: 'number' | 'letter' | 'op' | 'word' | 'text'; text: string; spaced: boolean }
  | { kind: 'open' | 'close' | 'sup' | 'sub' | 'tilde' | 'tick' | 'amp' | 'hash'; text: string; spaced: boolean };

interface EqBase {
  spaced: boolean;
}
type EqNode =
  | (EqBase & { type: 'mi'; text: string; upright: boolean; latex?: string })
  | (EqBase & { type: 'mn'; text: string })
  | (EqBase & { type: 'mo'; text: string; latex: string })
  | (EqBase & { type: 'text'; text: string })
  | (EqBase & { type: 'space'; width: string; latex: string })
  | (EqBase & { type: 'row'; children: EqNode[]; braces: boolean })
  | (EqBase & { type: 'frac'; num: EqNode; den: EqNode; atop: boolean })
  | (EqBase & { type: 'sqrt'; body: EqNode })
  | (EqBase & { type: 'root'; index: EqNode; body: EqNode })
  | (EqBase & { type: 'script'; base: EqNode; sub?: EqNode; sup?: EqNode; stacked: boolean })
  | (EqBase & { type: 'fence'; open: string; close: string; body: EqNode })
  | (EqBase & { type: 'table'; rows: EqNode[][]; open: string; close: string; env: string })
  | (EqBase & { type: 'accent'; base: EqNode; glyph: string; latex: string; under: boolean })
  | (EqBase & { type: 'style'; body: EqNode; variant: string; latex: string });

function invalid(script: string, detail: string): CorruptStreamError {
  const shown = script.length > 60 ? `${script.slice(0, 57)}...` : script;
  return new CorruptStreamError(`Invalid HWP equation "${shown}": ${detail}`);
}

const SINGLE_CHARACTER_TOKENS: Readonly<Record<string, EqToken['kind']>> = {
  '{': 'open', '}': 'close', '^': 'sup', _: 'sub', '~': 'tilde', '`': 'tick', '&': 'amp', '#': 'hash',
};

function isKeyword(word: string): boolean {
  return (
    has(HWP_EQ_GREEK, word) || has(HWP_EQ_SYMBOLS, word) || FUNCTION_NAMES.has(word) || has(BIG_OPERATORS, word) || has(ACCENTS, word) || has(STYLES, word) ||
    has(MATRICES, word) || ['over', 'atop', 'sqrt', 'root', 'of', 'left', 'right', 'cases', 'pile', 'sub', 'sup'].includes(word)
  );
}

/** The keyword a word spells (keywords are case-insensitive, Greek capitals are exact), or null when it is a run of variables. */
function keywordOf(word: string): string | null {
  if (isKeyword(word)) return word;
  const lower = word.toLowerCase();
  if (!has(HWP_EQ_GREEK, word) && isKeyword(lower)) return lower;
  return null;
}

function tokenize(script: string): EqToken[] {
  const tokens: EqToken[] = [];
  let spaced = false;
  let at = 0;
  while (at < script.length) {
    const char = script[at];
    if (/\s/.test(char)) {
      spaced = true;
      at += 1;
      continue;
    }
    const push = (token: EqToken, length: number): void => {
      tokens.push(token);
      at += length;
      spaced = false;
    };
    const kind = SINGLE_CHARACTER_TOKENS[char];
    if (kind) {
      push({ kind, text: char, spaced }, 1);
    } else if (char === '"') {
      const end = script.indexOf('"', at + 1);
      if (end < 0) throw invalid(script, 'a quoted text is not closed');
      push({ kind: 'text', text: script.slice(at + 1, end), spaced }, end + 1 - at);
    } else if (/[0-9]/.test(char)) {
      const match = /^\d+(?:\.\d+)?/.exec(script.slice(at)) as RegExpExecArray;
      push({ kind: 'number', text: match[0], spaced }, match[0].length);
    } else if (/[A-Za-z]/.test(char)) {
      const word = (/^[A-Za-z]+/.exec(script.slice(at)) as RegExpExecArray)[0];
      const keyword = keywordOf(word);
      if (keyword) {
        push({ kind: 'word', text: keyword, spaced }, word.length);
      } else {
        // Not a keyword: each letter is a variable.
        [...word].forEach((letter, index) => tokens.push({ kind: 'letter', text: letter, spaced: index === 0 ? spaced : false }));
        at += word.length;
        spaced = false;
      }
    } else {
      const pair = script.slice(at, at + 2);
      if (has(MULTI_CHARACTER_OPERATORS, pair)) push({ kind: 'op', text: pair, spaced }, 2);
      else if (/\p{L}/u.test(char)) push({ kind: 'letter', text: char, spaced }, char.length);
      else push({ kind: 'op', text: char, spaced }, char.length);
    }
  }
  return tokens;
}

class EquationParser {
  private position = 0;
  private depth = 0;

  constructor(
    private readonly script: string,
    private readonly tokens: EqToken[]
  ) {}

  parse(): EqNode[] {
    const nodes = this.parseSequence(() => false);
    if (this.position < this.tokens.length) throw invalid(this.script, `unexpected '${this.tokens[this.position].text}'`);
    return nodes;
  }

  private peek(): EqToken | undefined {
    return this.tokens[this.position];
  }

  private enter(): void {
    this.depth += 1;
    if (this.depth > MAX_NESTING_DEPTH) throw invalid(this.script, `nesting deeper than ${MAX_NESTING_DEPTH} levels`);
  }

  private leave(): void {
    this.depth -= 1;
  }

  /** Terms until `stop` matches the next token (not consumed) or the tokens end. */
  private parseSequence(stop: (token: EqToken) => boolean): EqNode[] {
    const nodes: EqNode[] = [];
    for (let token = this.peek(); token && !stop(token); token = this.peek()) {
      if (token.kind === 'close') throw invalid(this.script, "unexpected '}'");
      if (token.kind === 'amp' || token.kind === 'hash') throw invalid(this.script, `'${token.text}' is only valid inside a matrix`);
      if (token.kind === 'word' && (token.text === 'over' || token.text === 'atop')) {
        this.position += 1;
        const numerator = nodes.pop();
        if (!numerator) throw invalid(this.script, `'${token.text}' has no numerator`);
        const denominator = this.parseTerm(`'${token.text}' has no denominator`);
        nodes.push({ type: 'frac', num: numerator, den: denominator, atop: token.text === 'atop', spaced: numerator.spaced });
        continue;
      }
      nodes.push(this.parseTerm('missing operand'));
    }
    return nodes;
  }

  /** An atom followed by its scripts. */
  private parseTerm(missing: string): EqNode {
    let node = this.parseAtom(missing);
    for (;;) {
      const token = this.peek();
      const isSub = token && (token.kind === 'sub' || (token.kind === 'word' && token.text === 'sub'));
      const isSup = token && (token.kind === 'sup' || (token.kind === 'word' && token.text === 'sup'));
      if (!isSub && !isSup) return node;
      this.position += 1;
      const operand = this.parseAtom(`'${token.text}' has no script`);
      if (node.type === 'script' && ((isSub && !node.sub) || (isSup && !node.sup))) {
        if (isSub) node.sub = operand;
        else node.sup = operand;
      } else {
        node = { type: 'script', base: node, sub: isSub ? operand : undefined, sup: isSup ? operand : undefined, stacked: false, spaced: node.spaced };
      }
    }
  }

  private parseAtom(missing: string): EqNode {
    const token = this.peek();
    if (!token) throw invalid(this.script, missing);
    this.position += 1;
    const spaced = token.spaced;
    switch (token.kind) {
      case 'number':
        return { type: 'mn', text: token.text, spaced };
      case 'letter':
        return { type: 'mi', text: token.text, upright: false, spaced };
      case 'text':
        return { type: 'text', text: token.text, spaced };
      case 'tilde':
        return { type: 'space', width: EM_SPACE, latex: '\\quad ', spaced };
      case 'tick':
        return { type: 'space', width: THIN_SPACE, latex: '\\, ', spaced };
      case 'op': {
        const mapped = MULTI_CHARACTER_OPERATORS[token.text];
        return { type: 'mo', text: mapped ?? token.text, latex: MULTI_CHARACTER_LATEX[token.text] ?? latexOperator(token.text), spaced };
      }
      case 'open':
        return this.parseGroup(spaced);
      case 'close':
        throw invalid(this.script, "unexpected '}'");
      case 'word':
        return this.parseKeyword(token.text, spaced, missing);
      default:
        throw invalid(this.script, `unexpected '${token.text}'`);
    }
  }

  private parseGroup(spaced: boolean): EqNode {
    this.enter();
    const children = this.parseSequence((token) => token.kind === 'close');
    if (!this.peek()) throw invalid(this.script, "a '{' is not closed");
    this.position += 1;
    this.leave();
    return { type: 'row', children, braces: true, spaced };
  }

  private parseKeyword(word: string, spaced: boolean, missing: string): EqNode {
    if (has(HWP_EQ_GREEK, word)) return { type: 'mi', text: HWP_EQ_GREEK[word].mathml, upright: false, latex: HWP_EQ_GREEK[word].latex, spaced };
    if (has(HWP_EQ_SYMBOLS, word)) return { type: 'mo', text: HWP_EQ_SYMBOLS[word].mathml, latex: HWP_EQ_SYMBOLS[word].latex, spaced };
    if (FUNCTION_NAMES.has(word)) return { type: 'mi', text: word, upright: true, latex: `\\${word}`, spaced };
    if (has(BIG_OPERATORS, word)) return this.parseBigOperator(word, spaced);
    if (has(ACCENTS, word)) {
      const accent = ACCENTS[word];
      return { type: 'accent', base: this.parseAtom(`'${word}' has no operand`), glyph: accent.glyph, latex: accent.latex, under: accent.under, spaced };
    }
    if (has(STYLES, word)) {
      return { type: 'style', body: this.parseAtom(`'${word}' has no operand`), variant: STYLES[word].variant, latex: STYLES[word].latex, spaced };
    }
    if (word === 'sqrt') return { type: 'sqrt', body: this.parseTerm("'sqrt' has no operand"), spaced };
    if (word === 'root') {
      const index = this.parseAtom("'root' has no index");
      const of = this.peek();
      if (!of || of.kind !== 'word' || of.text !== 'of') throw invalid(this.script, "'root' needs 'of' after its index");
      this.position += 1;
      return { type: 'root', index, body: this.parseTerm("'of' has no operand"), spaced };
    }
    if (word === 'left') return this.parseFence(spaced);
    if (has(MATRICES, word)) return this.parseTable(word, spaced);
    if (word === 'cases' || word === 'pile') return this.parseTable(word, spaced);
    throw invalid(this.script, `'${word}' cannot start a term (${missing})`);
  }

  private parseBigOperator(word: string, spaced: boolean): EqNode {
    const operator = BIG_OPERATORS[word];
    const base: EqNode = { type: 'mo', text: operator.glyph, latex: operator.latex, spaced };
    let sub: EqNode | undefined;
    let sup: EqNode | undefined;
    for (let token = this.peek(); token; token = this.peek()) {
      const isSub = token.kind === 'sub' || (token.kind === 'word' && token.text === 'sub');
      const isSup = token.kind === 'sup' || (token.kind === 'word' && token.text === 'sup');
      if (!(isSub && !sub) && !(isSup && !sup)) break;
      this.position += 1;
      const operand = this.parseAtom(`'${word}' has no limit`);
      if (isSub) sub = operand;
      else sup = operand;
    }
    if (!sub && !sup) return base;
    return { type: 'script', base, sub, sup, stacked: operator.stacked, spaced };
  }

  private delimiter(after: string): string {
    const token = this.peek();
    if (!token) throw invalid(this.script, `'${after}' has no delimiter`);
    this.position += 1;
    if (token.kind === 'op' || token.kind === 'letter' || token.kind === 'open' || token.kind === 'close') {
      return token.text === '.' ? '' : token.text;
    }
    throw invalid(this.script, `'${token.text}' is not a delimiter`);
  }

  private parseFence(spaced: boolean): EqNode {
    this.enter();
    const open = this.delimiter('left');
    const body = this.parseSequence((token) => token.kind === 'word' && token.text === 'right');
    if (!this.peek()) throw invalid(this.script, "'left' has no matching 'right'");
    this.position += 1;
    const close = this.delimiter('right');
    this.leave();
    return { type: 'fence', open, close, body: { type: 'row', children: body, braces: false, spaced: false }, spaced };
  }

  private parseTable(word: string, spaced: boolean): EqNode {
    const opening = this.peek();
    if (!opening || opening.kind !== 'open') throw invalid(this.script, `'${word}' needs a { } body`);
    this.position += 1;
    this.enter();
    const rows: EqNode[][] = [[]];
    for (;;) {
      const cell = this.parseSequence((token) => token.kind === 'close' || token.kind === 'amp' || token.kind === 'hash');
      rows[rows.length - 1].push({ type: 'row', children: cell, braces: false, spaced: false });
      const separator = this.peek();
      if (!separator) throw invalid(this.script, `the { } body of '${word}' is not closed`);
      this.position += 1;
      if (separator.kind === 'close') break;
      if (separator.kind === 'hash') rows.push([]);
    }
    this.leave();
    const style = MATRICES[word] ?? (word === 'cases' ? { open: '{', close: '', env: 'cases' } : { open: '', close: '', env: 'matrix' });
    return { type: 'table', rows, open: style.open, close: style.close, env: style.env, spaced };
  }
}

function latexOperator(text: string): string {
  switch (text) {
    case '%': return '\\%';
    case '$': return '\\$';
    case '\\': return '\\backslash ';
    case '<': return '<';
    default: return text;
  }
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mathmlOf(node: EqNode): string {
  switch (node.type) {
    case 'mi': return node.upright ? `<mi mathvariant="normal">${escapeXml(node.text)}</mi>` : `<mi>${escapeXml(node.text)}</mi>`;
    case 'mn': return `<mn>${node.text}</mn>`;
    case 'mo': return `<mo>${escapeXml(node.text)}</mo>`;
    case 'text': return `<mtext>${escapeXml(node.text)}</mtext>`;
    case 'space': return `<mspace width="${node.width}"/>`;
    case 'row': return node.children.length === 1 ? mathmlOf(node.children[0]) : `<mrow>${node.children.map(mathmlOf).join('')}</mrow>`;
    case 'frac': return `<mfrac${node.atop ? ' linethickness="0"' : ''}>${mathmlOf(node.num)}${mathmlOf(node.den)}</mfrac>`;
    case 'sqrt': return `<msqrt>${mathmlOf(node.body)}</msqrt>`;
    case 'root': return `<mroot>${mathmlOf(node.body)}${mathmlOf(node.index)}</mroot>`;
    case 'script': return scriptMathml(node);
    case 'fence': return `<mrow><mo fence="true">${escapeXml(node.open)}</mo>${mathmlOf(node.body)}<mo fence="true">${escapeXml(node.close)}</mo></mrow>`;
    case 'table': return tableMathml(node);
    case 'accent':
      return node.under
        ? `<munder>${mathmlOf(node.base)}<mo>${escapeXml(node.glyph)}</mo></munder>`
        : `<mover accent="true">${mathmlOf(node.base)}<mo>${escapeXml(node.glyph)}</mo></mover>`;
    case 'style': return `<mstyle mathvariant="${node.variant}">${mathmlOf(node.body)}</mstyle>`;
  }
}

function scriptMathml(node: Extract<EqNode, { type: 'script' }>): string {
  const base = mathmlOf(node.base);
  const [under, over, plain] = node.stacked ? ['munder', 'mover', 'munderover'] : ['msub', 'msup', 'msubsup'];
  if (node.sub && node.sup) return `<${plain}>${base}${mathmlOf(node.sub)}${mathmlOf(node.sup)}</${plain}>`;
  if (node.sub) return `<${under}>${base}${mathmlOf(node.sub)}</${under}>`;
  return `<${over}>${base}${mathmlOf(node.sup as EqNode)}</${over}>`;
}

function tableMathml(node: Extract<EqNode, { type: 'table' }>): string {
  const align = node.env === 'cases' ? ' columnalign="left"' : '';
  const rows = node.rows.map((row) => `<mtr>${row.map((cell) => `<mtd>${mathmlOf(cell)}</mtd>`).join('')}</mtr>`).join('');
  const table = `<mtable${align}>${rows}</mtable>`;
  if (!node.open && !node.close) return table;
  return `<mrow><mo fence="true">${escapeXml(node.open)}</mo>${table}<mo fence="true">${escapeXml(node.close)}</mo></mrow>`;
}

/** LaTeX for a sequence: source spacing between terms is kept, and a command is never glued to a following letter. */
function latexSequence(nodes: EqNode[]): string {
  let out = '';
  nodes.forEach((node, index) => {
    const piece = latexOf(node);
    const needsSeparator = index > 0 && (node.spaced || (/[A-Za-z]$/.test(out) && /^\\?[A-Za-z]/.test(piece) && /\\[A-Za-z]+$/.test(out)));
    out += (needsSeparator && !out.endsWith(' ') ? ' ' : '') + piece;
  });
  return out;
}

/** An operand without its braces where it is a group, else the operand itself. */
function latexContent(node: EqNode): string {
  return node.type === 'row' ? latexSequence(node.children) : latexOf(node);
}

/** A script operand: bare when it is one character, braced otherwise. */
function latexScriptOperand(node: EqNode): string {
  const content = latexContent(node);
  return node.type !== 'row' && [...content.replace(/^\\/, '')].length === 1 ? content : `{${content}}`;
}

function latexOf(node: EqNode): string {
  switch (node.type) {
    case 'mi': return node.latex ?? node.text;
    case 'mn': return node.text;
    case 'mo': return node.latex;
    case 'text': return `\\text{${node.text.replace(/[\\{}$&#%_^~]/g, (c) => `\\${c}`)}}`;
    case 'space': return node.latex;
    case 'row': return node.braces ? `{${latexSequence(node.children)}}` : latexSequence(node.children);
    case 'frac': return fractionLatex(node);
    case 'sqrt': return `\\sqrt{${latexContent(node.body)}}`;
    case 'root': return `\\sqrt[${latexContent(node.index)}]{${latexContent(node.body)}}`;
    case 'script': return `${latexOf(node.base)}${node.sub ? `_${latexScriptOperand(node.sub)}` : ''}${node.sup ? `^${latexScriptOperand(node.sup)}` : ''}`;
    case 'fence': return `\\left${latexDelimiter(node.open)} ${latexContent(node.body)} \\right${latexDelimiter(node.close)}`;
    case 'table': {
      const body = node.rows.map((row) => row.map(latexContent).join(' & ')).join(' \\\\ ');
      return `\\begin{${node.env}} ${body} \\end{${node.env}}`;
    }
    case 'accent': return `${node.latex}{${latexContent(node.base)}}`;
    case 'style': return `${node.latex}{${latexContent(node.body)}}`;
  }
}

function fractionLatex(node: Extract<EqNode, { type: 'frac' }>): string {
  if (node.atop) return `{${latexContent(node.num)} \\atop ${latexContent(node.den)}}`;
  return `\\frac{${latexContent(node.num)}}{${latexContent(node.den)}}`;
}

function latexDelimiter(delimiter: string): string {
  if (delimiter === '') return '.';
  if (delimiter === '{' || delimiter === '}') return `\\${delimiter}`;
  if (delimiter === '|') return '|';
  return delimiter;
}

function parseEquation(script: string): EqNode[] {
  if (script.length > MAX_SCRIPT_LENGTH) throw invalid(script, `longer than ${MAX_SCRIPT_LENGTH} characters`);
  return new EquationParser(script, tokenize(script)).parse();
}

/** Transpiles an equation script to MathML. An empty script is an empty `<math>`; a script that does not parse throws. */
export function hwpEquationToMathML(script: string): string {
  const nodes = parseEquation(script.trim());
  return `<math>${nodes.map(mathmlOf).join('')}</math>`;
}

/** Transpiles an equation script to LaTeX. An empty script is empty; a script that does not parse throws. */
export function hwpEquationToLaTeX(script: string): string {
  return latexSequence(parseEquation(script.trim()));
}
