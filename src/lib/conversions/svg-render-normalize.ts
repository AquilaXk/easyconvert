import { ABSOLUTE_LENGTH_UNITS } from './svg-length';
import { CHAR_SLASH, XML_NAME_PATTERN, endOfTag, skipNonElementMarkup } from './svg-xml';

// ============================================================================
// SVG rendering normalization (96-dpi physical units & child clip-path union)
// ============================================================================

const PHYSICAL_UNIT_QUICK_CHECK = /\d\s*(?:mm|cm|in|pt|pc|q)\b/i;
const PHYSICAL_LENGTH_VALUE_PATTERN = /^\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*(mm|cm|in|pt|pc|q)\s*$/i;
const PHYSICAL_TOKEN_IN_LIST_PATTERN = /([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*(mm|cm|in|pt|pc|q)\b/gi;
const PHYSICAL_LENGTH_ATTRIBUTES: ReadonlySet<string> = new Set([
  'x',
  'y',
  'width',
  'height',
  'rx',
  'ry',
  'cx',
  'cy',
  'r',
  'x1',
  'y1',
  'x2',
  'y2',
  'dx',
  'dy',
  'stroke-width',
  'stroke-dashoffset',
  'font-size',
  'markerwidth',
  'markerheight',
  'refx',
  'refy',
]);

function formatUserUnits(px: number): string {
  return Number(px.toFixed(6)).toString();
}

function convertPhysicalLengthToken(raw: string): string {
  const match = PHYSICAL_LENGTH_VALUE_PATTERN.exec(raw);
  if (!match) return raw;
  const num = Number.parseFloat(match[1]);
  const factor = ABSOLUTE_LENGTH_UNITS[match[2].toLowerCase()];
  if (!Number.isFinite(num) || factor === undefined) return raw;
  return formatUserUnits(num * factor);
}

function normalizeTagPhysicalAttributes(tagText: string): string {
  return tagText.replace(
    /(\s)([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
    (whole, leadingSpace: string, rawName: string, dval?: string, sval?: string) => {
      const value = dval ?? sval ?? '';
      const quote = dval !== undefined ? '"' : "'";
      const local = rawName.slice(rawName.lastIndexOf(':') + 1).toLowerCase();
      if (PHYSICAL_LENGTH_ATTRIBUTES.has(local)) {
        const converted = convertPhysicalLengthToken(value);
        return converted === value ? whole : `${leadingSpace}${rawName}=${quote}${converted}${quote}`;
      }
      if (local === 'stroke-dasharray' && PHYSICAL_UNIT_QUICK_CHECK.test(value)) {
        const converted = value.replace(PHYSICAL_TOKEN_IN_LIST_PATTERN, (tok, n: string, u: string) => {
          const num = Number.parseFloat(n);
          const factor = ABSOLUTE_LENGTH_UNITS[u.toLowerCase()];
          return Number.isFinite(num) && factor !== undefined ? formatUserUnits(num * factor) : tok;
        });
        return `${leadingSpace}${rawName}=${quote}${converted}${quote}`;
      }
      if (local === 'style' && PHYSICAL_UNIT_QUICK_CHECK.test(value)) {
        const converted = value.replace(
          /\b(x|y|width|height|rx|ry|cx|cy|r|stroke-width|stroke-dashoffset|font-size)\s*:\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*(mm|cm|in|pt|pc|q)\b/gi,
          (decl, prop: string, n: string, u: string) => {
            const num = Number.parseFloat(n);
            const factor = ABSOLUTE_LENGTH_UNITS[u.toLowerCase()];
            return Number.isFinite(num) && factor !== undefined ? `${prop}:${formatUserUnits(num * factor)}` : decl;
          }
        );
        return converted === value ? whole : `${leadingSpace}${rawName}=${quote}${converted}${quote}`;
      }
      return whole;
    }
  );
}

/**
 * Converts physical CSS length units (`mm`, `cm`, `in`, `pt`, `pc`, `Q`) on SVG presentation and geometry attributes
 * to user units at the CSS/SVG standard 96 px/in ratio so that rasterizers invoked at arbitrary DPI (e.g. 72 or 300)
 * do not distort internal geometry relative to `viewBox` user units.
 */
function normalizeSvgPhysicalLengths(svg: string): string {
  if (!PHYSICAL_UNIT_QUICK_CHECK.test(svg)) return svg;
  const parts: string[] = [];
  let copied = 0;
  let pos = 0;
  while (pos < svg.length) {
    const lt = svg.indexOf('<', pos);
    if (lt < 0) break;
    try {
      const afterMarkup = skipNonElementMarkup(svg, lt);
      if (afterMarkup >= 0) {
        pos = afterMarkup;
        continue;
      }
      if (svg.charCodeAt(lt + 1) === CHAR_SLASH) {
        pos = endOfTag(svg, lt + 2) + 1;
        continue;
      }
      XML_NAME_PATTERN.lastIndex = lt + 1;
      const nameMatch = XML_NAME_PATTERN.exec(svg);
      if (!nameMatch) {
        pos = lt + 1;
        continue;
      }
      const tagEnd = endOfTag(svg, lt + 1 + nameMatch[0].length) + 1;
      const rawTag = svg.slice(lt, tagEnd);
      if (PHYSICAL_UNIT_QUICK_CHECK.test(rawTag)) {
        const rewritten = normalizeTagPhysicalAttributes(rawTag);
        if (rewritten !== rawTag) {
          parts.push(svg.slice(copied, lt), rewritten);
          copied = tagEnd;
        }
      }
      pos = tagEnd;
    } catch {
      return svg;
    }
  }
  if (copied === 0 && parts.length === 0) return svg;
  parts.push(svg.slice(copied));
  return parts.join('');
}

const CLIP_PATH_BLOCK_PATTERN = /<clipPath\b([^>]*)>([\s\S]*?)<\/clipPath\s*>/gi;
const CHILD_CLIP_PATH_URL_PATTERN = /\bclip-path\s*=\s*(?:"\s*url\(\s*#([^)\s"']+)\s*\)\s*"|'\s*url\(\s*#([^)\s"']+)\s*\)\s*')/gi;
const ATTR_ID_PATTERN = /\bid\s*=\s*(?:"([^"]+)"|'([^']+)')/i;
const ATTR_CLIP_UNITS_PATTERN = /\bclipPathUnits\s*=\s*(?:"([^"]+)"|'([^']+)')/i;
const ATTR_TRANSFORM_PATTERN = /\btransform\s*=\s*(?:"([^"]+)"|'([^']+)')/i;
const ATTR_CLIP_RULE_PATTERN = /\bclip-rule\s*=\s*(?:"([^"]+)"|'([^']+)')/i;
const SAFE_XML_ID_PATTERN = /^[A-Za-z_][\w.:-]*$/;
const MASK_OVERRIDE_STYLE_PROP_PATTERN = /^(?:fill|fill-opacity|opacity|stroke|fill-rule|clip-rule)\s*:/i;

function escapeMaskAttr(val: string): string {
  return val.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function rewriteClipChildTagToWhiteMaskShape(tagText: string): string {
  const clipRuleMatch = ATTR_CLIP_RULE_PATTERN.exec(tagText);
  let fillRule =
    clipRuleMatch && (clipRuleMatch[1] ?? clipRuleMatch[2])?.trim().toLowerCase() === 'evenodd' ? 'evenodd' : 'nonzero';
  const strippedStyle = tagText.replace(
    /(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi,
    (_whole, prefix: string, dval?: string, sval?: string) => {
      const raw = dval ?? sval ?? '';
      const quote = dval !== undefined ? '"' : "'";
      const kept: string[] = [];
      for (const decl of raw.split(';')) {
        const trimmed = decl.trim();
        if (trimmed === '') continue;
        if (/^clip-rule\s*:\s*evenodd\b/i.test(trimmed)) fillRule = 'evenodd';
        if (!MASK_OVERRIDE_STYLE_PROP_PATTERN.test(trimmed)) kept.push(trimmed);
      }
      return kept.length === 0 ? '' : `${prefix}${quote}${kept.join(';')}${quote}`;
    }
  );
  const stripped = strippedStyle.replace(
    /\s+(?:fill|fill-opacity|opacity|stroke|fill-rule|clip-rule)\s*=\s*(?:"[^"]*"|'[^']*')/gi,
    ''
  );
  const selfClosing = /\/>\s*$/.test(stripped);
  const closeIdx = selfClosing ? stripped.lastIndexOf('/>') : stripped.lastIndexOf('>');
  if (closeIdx < 0) return tagText;
  return (
    stripped.slice(0, closeIdx) +
    ` fill="#ffffff" fill-opacity="1" opacity="1" stroke="none" fill-rule="${fillRule}"` +
    stripped.slice(closeIdx)
  );
}

/**
 * Lowers `<clipPath id="X">` elements whose children carry their own `clip-path="url(#...)"` attributes (and where `X`
 * is not referenced inside another `<clipPath>`) into a white luminance `<mask id="X">`, rewriting `clip-path="url(#X)"`
 * references to `mask="url(#X)"`. This ensures librsvg composites the union of the clipped children instead of
 * intersecting their clip regions.
 */
function lowerChildClipPathsToMasks(svg: string): string {
  if (!/<clipPath\b/i.test(svg) || !/\bclip-path\b/i.test(svg)) return svg;

  interface ClipBlock {
    fullMatch: string;
    start: number;
    end: number;
    id: string;
    openAttrs: string;
    inner: string;
    hasClippedChild: boolean;
  }

  const blocks: ClipBlock[] = [];
  const referencedInsideClipPath = new Set<string>();

  for (const match of svg.matchAll(CLIP_PATH_BLOCK_PATTERN)) {
    const openAttrs = match[1] ?? '';
    const inner = match[2] ?? '';
    const idMatch = ATTR_ID_PATTERN.exec(openAttrs);
    const id = (idMatch?.[1] ?? idMatch?.[2] ?? '').trim();
    let hasClippedChild = false;
    for (const refMatch of inner.matchAll(CHILD_CLIP_PATH_URL_PATTERN)) {
      const targetId = (refMatch[1] ?? refMatch[2] ?? '').trim();
      if (targetId) {
        hasClippedChild = true;
        referencedInsideClipPath.add(targetId);
      }
    }
    if (id && SAFE_XML_ID_PATTERN.test(id)) {
      blocks.push({
        fullMatch: match[0],
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
        id,
        openAttrs,
        inner,
        hasClippedChild,
      });
    }
  }

  const eligible = blocks.filter((b) => b.hasClippedChild && !referencedInsideClipPath.has(b.id));
  if (eligible.length === 0) return svg;

  const loweredIds = new Set(eligible.map((b) => b.id));
  const parts: string[] = [];
  let copied = 0;
  for (const block of eligible) {
    parts.push(svg.slice(copied, block.start));
    const unitsMatch = ATTR_CLIP_UNITS_PATTERN.exec(block.openAttrs);
    const rawUnits = (unitsMatch?.[1] ?? unitsMatch?.[2] ?? 'userSpaceOnUse').trim();
    const clipUnits = rawUnits === 'objectBoundingBox' ? 'objectBoundingBox' : 'userSpaceOnUse';
    const transformMatch = ATTR_TRANSFORM_PATTERN.exec(block.openAttrs);
    const transformVal = transformMatch?.[1] ?? transformMatch?.[2];
    const transformAttr = transformVal ? ` transform="${escapeMaskAttr(transformVal)}"` : '';
    const rewrittenInner = block.inner.replace(
      /<(path|rect|circle|ellipse|polygon|polyline|line|text|use)\b[^>]*>/gi,
      (childTag) => rewriteClipChildTagToWhiteMaskShape(childTag)
    );
    parts.push(
      `<mask id="${block.id}" maskUnits="userSpaceOnUse" maskContentUnits="${clipUnits}" x="-100%" y="-100%" width="300%" height="300%"${transformAttr}>${rewrittenInner}</mask>`
    );
    copied = block.end;
  }
  parts.push(svg.slice(copied));
  let result = parts.join('');

  for (const id of loweredIds) {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(
      new RegExp(`(\\b)clip-path(\\s*=\\s*(?:"\\s*url\\(\\s*#${escapedId}\\s*\\)\\s*"|'\\s*url\\(\\s*#${escapedId}\\s*\\)\\s*'))`, 'g'),
      '$1mask$2'
    );
    result = result.replace(
      new RegExp(`(\\b)clip-path(\\s*:\\s*url\\(\\s*#${escapedId}\\s*\\))`, 'g'),
      '$1mask$2'
    );
  }
  return result;
}

/**
 * Normalizes an already-sanitized SVG document before passing it to a raster or PDF renderer (Sharp/libvips or librsvg).
 */
export function normalizeSvgForRendering(svgContent: string): string {
  return lowerChildClipPathsToMasks(normalizeSvgPhysicalLengths(svgContent));
}

/**
 * Buffer wrapper around {@link normalizeSvgForRendering}.
 */
export function normalizeSvgBufferForRendering(svgBuffer: Buffer): Buffer {
  const raw = svgBuffer.toString('utf-8');
  const normalized = normalizeSvgForRendering(raw);
  return normalized === raw ? svgBuffer : Buffer.from(normalized, 'utf-8');
}

