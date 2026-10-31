import { SVG_NUMBER_PATTERN } from './svg-pen';

/**
 * The pictures (`<image>`) a page draws that a reader leaves out, because the format it writes holds no bitmaps. A reader given no
 * collector refuses the page at its first picture; given one, it counts there each picture the page really draws.
 */
export class LeftOutPictures {
  count = 0;
}

/** Whether an `opacity` value paints nothing: zero, or a percentage of zero. Opacity is not inherited, but a group at zero hides all it holds. */
export function isFullyTransparent(opacity: string | undefined): boolean {
  if (opacity === undefined) return false;
  const v = opacity.trim();
  const isPercent = v.endsWith('%');
  const body = isPercent ? v.slice(0, -1) : v;
  return SVG_NUMBER_PATTERN.test(body) && Number(body) <= 0;
}

const LENGTH_UNIT = /(?:[a-z]+|%)$/i;

/** Whether a `width` or `height` attribute leaves nothing to paint: SVG disables rendering at zero, and a negative value is an error that is not rendered. */
function hasNoExtent(length: string | undefined): boolean {
  if (length === undefined) return false;
  const body = length.trim().replace(LENGTH_UNIT, '');
  return SVG_NUMBER_PATTERN.test(body) && Number(body) <= 0;
}

/** What a picture takes from the groups around it: the visibility it inherits, and whether one of them is fully transparent. */
export interface PictureSurroundings {
  readonly visibility: string;
  readonly transparent: boolean;
}

/**
 * Whether an `<image>` is painted: not `display: none`, not `visibility` other than visible (hidden, collapse, or inherited from a group
 * that hides it), not fully transparent itself or inside a group that is, and not of zero width or height.
 */
export function isDrawnPicture(attrs: ReadonlyMap<string, string>, declared: ReadonlyMap<string, string>, surroundings: PictureSurroundings): boolean {
  const own = declared.get('visibility');
  const visibility = own === undefined || own === 'inherit' ? surroundings.visibility : own;
  return (
    declared.get('display') !== 'none' &&
    visibility === 'visible' &&
    !surroundings.transparent &&
    !isFullyTransparent(declared.get('opacity')) &&
    !hasNoExtent(attrs.get('width')) &&
    !hasNoExtent(attrs.get('height'))
  );
}
