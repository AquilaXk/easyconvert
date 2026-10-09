import { DocumentFormatError, MAX_HEADING_LEVEL, type DocAlign } from './document-model';
import { childElements, firstChild, type XmlElement } from './xml-tree';

/**
 * WordprocessingML styles (ECMA-376 Part 1, 17.7): document defaults, paragraph and character styles with
 * `w:basedOn` inheritance, and the property sets a paragraph or run resolves to. Toggle properties (bold, italic)
 * take the value of the closest definition instead of Word's exclusive-or across the style chain.
 */

/** Most styles one document may define. */
export const MAX_STYLE_DEFINITIONS = 50_000;
/** Longest `w:basedOn` chain followed. */
const MAX_STYLE_CHAIN = 64;
const HALF_POINTS_PER_POINT = 2;
const OUTLINE_BODY_TEXT = 9;

export interface RunProps {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  vanish?: boolean;
  sizeHalfPoints?: number;
  color?: string;
  vertAlign?: 'superscript' | 'subscript' | 'baseline';
  monospace?: boolean;
}

export interface ParagraphProps {
  numId?: number;
  ilvl?: number;
  /** Zero-based outline level (0 is the highest), absent for body text. */
  outlineLevel?: number;
  align?: DocAlign;
  pageBreakBefore?: boolean;
}

export interface ResolvedParagraphStyle {
  readonly paragraph: ParagraphProps;
  readonly run: RunProps;
  readonly name: string;
}

const MONOSPACE_FONTS: ReadonlySet<string> = new Set([
  'courier new', 'courier', 'consolas', 'lucida console', 'monaco', 'menlo', 'liberation mono', 'dejavu sans mono',
  'source code pro', 'cascadia code', 'cascadia mono', 'monospace',
]);
const OFF_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'off']);

/** A WordprocessingML on/off element: present without a value or with a true value is on. */
export function onOff(element: XmlElement | undefined): boolean | undefined {
  if (!element) return undefined;
  const value = element.attrs.get('val');
  return value === undefined ? true : !OFF_VALUES.has(value.toLowerCase());
}

function alignOf(value: string | undefined): DocAlign | undefined {
  switch (value) {
    case 'left':
    case 'start':
      return 'left';
    case 'center':
      return 'center';
    case 'right':
    case 'end':
      return 'right';
    case 'both':
    case 'distribute':
    case 'justify':
      return 'justify';
    default:
      return undefined;
  }
}

export function readRunProps(rPr: XmlElement | undefined): RunProps {
  if (!rPr) return {};
  const props: RunProps = {};
  const bold = onOff(firstChild(rPr, 'b'));
  if (bold !== undefined) props.bold = bold;
  const italic = onOff(firstChild(rPr, 'i'));
  if (italic !== undefined) props.italic = italic;
  const underline = firstChild(rPr, 'u');
  if (underline) props.underline = (underline.attrs.get('val') ?? 'single') !== 'none';
  const strike = onOff(firstChild(rPr, 'strike')) ?? onOff(firstChild(rPr, 'dstrike'));
  if (strike !== undefined) props.strike = strike;
  const vanish = onOff(firstChild(rPr, 'vanish'));
  if (vanish !== undefined) props.vanish = vanish;
  const size = firstChild(rPr, 'sz')?.attrs.get('val');
  if (size !== undefined && /^\d+$/.test(size)) props.sizeHalfPoints = Number(size);
  const color = firstChild(rPr, 'color')?.attrs.get('val');
  if (color !== undefined && /^[0-9a-fA-F]{6}$/.test(color)) props.color = color.toUpperCase();
  const vertAlign = firstChild(rPr, 'vertAlign')?.attrs.get('val');
  if (vertAlign === 'superscript' || vertAlign === 'subscript' || vertAlign === 'baseline') props.vertAlign = vertAlign;
  const fonts = firstChild(rPr, 'rFonts');
  const ascii = fonts?.attrs.get('ascii') ?? fonts?.attrs.get('hAnsi');
  if (ascii !== undefined) props.monospace = MONOSPACE_FONTS.has(ascii.toLowerCase());
  return props;
}

export function readParagraphProps(pPr: XmlElement | undefined): ParagraphProps {
  if (!pPr) return {};
  const props: ParagraphProps = {};
  const numPr = firstChild(pPr, 'numPr');
  if (numPr) {
    const numId = firstChild(numPr, 'numId')?.attrs.get('val');
    const ilvl = firstChild(numPr, 'ilvl')?.attrs.get('val');
    if (numId !== undefined && /^\d+$/.test(numId)) props.numId = Number(numId);
    if (ilvl !== undefined && /^\d+$/.test(ilvl)) props.ilvl = Number(ilvl);
  }
  const outline = firstChild(pPr, 'outlineLvl')?.attrs.get('val');
  if (outline !== undefined && /^\d+$/.test(outline)) {
    const level = Number(outline);
    if (level < OUTLINE_BODY_TEXT) props.outlineLevel = level;
  }
  const align = alignOf(firstChild(pPr, 'jc')?.attrs.get('val'));
  if (align) props.align = align;
  const pageBreakBefore = onOff(firstChild(pPr, 'pageBreakBefore'));
  if (pageBreakBefore !== undefined) props.pageBreakBefore = pageBreakBefore;
  return props;
}

function defined<T extends object>(base: T, over: T): T {
  const merged: T = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

export const mergeRunProps = (base: RunProps, over: RunProps): RunProps => defined(base, over);
export const mergeParagraphProps = (base: ParagraphProps, over: ParagraphProps): ParagraphProps => defined(base, over);

interface StyleDefinition {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly basedOn?: string;
  readonly paragraph: ParagraphProps;
  readonly run: RunProps;
}

const HEADING_NAME = /^heading\s*([1-9])$/i;

export class StyleSheet {
  private readonly styles = new Map<string, StyleDefinition>();
  private readonly resolved = new Map<string, ResolvedParagraphStyle>();
  readonly defaultRun: RunProps;
  readonly defaultParagraphStyle: string | undefined;
  readonly language: string | undefined;

  constructor(root: XmlElement | undefined) {
    let defaultRun: RunProps = {};
    let defaultParagraph: string | undefined;
    let language: string | undefined;
    if (root) {
      const defaults = firstChild(root, 'docDefaults');
      const runDefault = defaults ? firstChild(defaults, 'rPrDefault') : undefined;
      const defaultRPr = runDefault ? firstChild(runDefault, 'rPr') : undefined;
      defaultRun = readRunProps(defaultRPr);
      language = defaultRPr ? firstChild(defaultRPr, 'lang')?.attrs.get('val') : undefined;
      let declared = 0;
      for (const style of childElements(root, 'style')) {
        declared += 1;
        if (declared > MAX_STYLE_DEFINITIONS) {
          throw new DocumentFormatError(`word/styles.xml defines more than ${MAX_STYLE_DEFINITIONS} styles.`);
        }
        const id = style.attrs.get('styleId');
        if (id === undefined) continue;
        const type = style.attrs.get('type') ?? 'paragraph';
        this.styles.set(id, {
          id,
          type,
          name: firstChild(style, 'name')?.attrs.get('val') ?? id,
          basedOn: firstChild(style, 'basedOn')?.attrs.get('val'),
          paragraph: readParagraphProps(firstChild(style, 'pPr')),
          run: readRunProps(firstChild(style, 'rPr')),
        });
        if (type === 'paragraph' && style.attrs.get('default') === '1') defaultParagraph = id;
      }
    }
    this.defaultRun = defaultRun;
    this.defaultParagraphStyle = defaultParagraph;
    this.language = language;
  }

  /** The numbering instance each numbering style names in its paragraph properties (17.9.21 style links). */
  numberingStyles(): Map<string, number> {
    const map = new Map<string, number>();
    for (const style of this.styles.values()) {
      if (style.type === 'numbering' && style.paragraph.numId !== undefined) map.set(style.id, style.paragraph.numId);
    }
    return map;
  }

  /** Walks the `w:basedOn` chain of `styleId` from the root to the style, merging properties. */
  private cascade(styleId: string): { paragraph: ParagraphProps; run: RunProps; name: string } {
    const chain: StyleDefinition[] = [];
    const seen = new Set<string>();
    for (let id: string | undefined = styleId; id !== undefined; ) {
      const style = this.styles.get(id);
      if (!style) break;
      if (seen.has(id)) throw new DocumentFormatError(`word/styles.xml has a cycle in the w:basedOn chain of style "${styleId}".`);
      if (chain.length >= MAX_STYLE_CHAIN) {
        throw new DocumentFormatError(`word/styles.xml nests w:basedOn more than ${MAX_STYLE_CHAIN} levels deep at style "${styleId}".`);
      }
      seen.add(id);
      chain.push(style);
      id = style.basedOn;
    }
    let paragraph: ParagraphProps = {};
    let run: RunProps = {};
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      paragraph = mergeParagraphProps(paragraph, chain[index].paragraph);
      run = mergeRunProps(run, chain[index].run);
    }
    return { paragraph, run, name: chain.length > 0 ? chain[0].name : styleId };
  }

  /** Properties a paragraph style (and its ancestors) give; the default paragraph style when `styleId` is absent. */
  paragraphStyle(styleId: string | undefined): ResolvedParagraphStyle {
    const id = styleId ?? this.defaultParagraphStyle ?? '';
    const cached = this.resolved.get(id);
    if (cached) return cached;
    const value = id === '' ? { paragraph: {}, run: {}, name: '' } : this.cascade(id);
    this.resolved.set(id, value);
    return value;
  }

  /** Run properties a character style (and its ancestors) give. */
  characterStyle(styleId: string | undefined): RunProps {
    return styleId === undefined ? {} : this.cascade(styleId).run;
  }

  /** Heading level (1-6) of a paragraph style or direct outline level; Title counts as level 1. */
  headingLevel(styleName: string, outlineLevel: number | undefined): number | undefined {
    const named = HEADING_NAME.exec(styleName.trim());
    if (named) return Math.min(Number(named[1]), MAX_HEADING_LEVEL);
    if (styleName.trim().toLowerCase() === 'title') return 1;
    if (outlineLevel !== undefined) return Math.min(outlineLevel + 1, MAX_HEADING_LEVEL);
    return undefined;
  }
}

export function sizePoints(halfPoints: number | undefined): number | undefined {
  return halfPoints === undefined ? undefined : halfPoints / HALF_POINTS_PER_POINT;
}
