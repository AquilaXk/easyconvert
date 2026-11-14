/** Linear-time tag rewriting for the HTML to Markdown text pass: no lazy `[\s\S]*?` pairs, whose cost grows with the square of the input. */

const CHAR_GT = 0x3e;
const CHAR_SLASH = 0x2f;

function isTagNameEnd(code: number): boolean {
  return Number.isNaN(code) || code === CHAR_GT || code === CHAR_SLASH || code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/** Whether the lower-case ASCII `name` stands at `at`, compared without case and followed by the end of a tag name (`<b>` is not `<br>`). */
function hasTagNameAt(html: string, at: number, name: string): boolean {
  if (at + name.length > html.length) return false;
  for (let i = 0; i < name.length; i++) {
    const code = html.charCodeAt(at + i);
    if ((code >= 0x41 && code <= 0x5a ? code | 0x20 : code) !== name.charCodeAt(i)) return false;
  }
  return isTagNameEnd(html.charCodeAt(at + name.length));
}

interface Opening {
  start: number;
  end: number;
}

/** Walks the openings of one tag name from left to right; the `>` that ends a header is searched once per run of openings, so the walk is linear. */
class OpeningScan {
  private gt = -1;

  constructor(
    private readonly html: string,
    private readonly name: string
  ) {}

  /** The next opening tag at or after `from` (header to its first `>`), or null when no tag of that name can be completed. */
  next(from: number): Opening | null {
    let lt = this.html.indexOf('<', from);
    while (lt !== -1) {
      if (hasTagNameAt(this.html, lt + 1, this.name)) {
        if (this.gt < lt) this.gt = this.html.indexOf('>', lt);
        // No `>` after this opening means none after any later one either.
        if (this.gt === -1) return null;
        return { start: lt, end: this.gt + 1 };
      }
      lt = this.html.indexOf('<', lt + 1);
    }
    return null;
  }
}

/**
 * Replaces every `<name ...>content</name>` with `render(content)`. A closing tag is `</name>` as written, in any case.
 * Once an opening has no closing tag after it, no later one has either, so the rest of the text is kept as it is.
 */
export function replaceHtmlElements(html: string, name: string, render: (content: string) => string): string {
  const openings = new OpeningScan(html, name);
  const closing = new RegExp(`</${name}>`, 'gi');
  const out: string[] = [];
  let pos = 0;
  for (let opening = openings.next(pos); opening !== null; opening = openings.next(pos)) {
    closing.lastIndex = opening.end;
    const close = closing.exec(html);
    if (close === null) break;
    out.push(html.slice(pos, opening.start), render(html.slice(opening.end, close.index)));
    pos = close.index + close[0].length;
  }
  if (pos === 0) return html;
  out.push(html.slice(pos));
  return out.join('');
}

/** Drops every opening tag `<name ...>`, keeping the text between and after them. */
export function removeHtmlOpenings(html: string, name: string): string {
  const openings = new OpeningScan(html, name);
  const out: string[] = [];
  let pos = 0;
  for (let opening = openings.next(pos); opening !== null; opening = openings.next(pos)) {
    out.push(html.slice(pos, opening.start));
    pos = opening.end;
  }
  if (pos === 0) return html;
  out.push(html.slice(pos));
  return out.join('');
}
