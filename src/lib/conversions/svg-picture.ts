import { SVG_NUMBER_PATTERN } from './svg-pen';

/**
 * The pictures (`<image>`) a page draws that a reader leaves out, because the format it writes holds no bitmaps. A reader given no
 * collector refuses the page at its first picture; given one, it counts there each picture the page really draws.
 */
export class LeftOutPictures {
  count = 0;
}

function isTransparent(value: string): boolean {
  const v = value.trim();
  const isPercent = v.endsWith('%');
  const body = isPercent ? v.slice(0, -1) : v;
  return SVG_NUMBER_PATTERN.test(body) && Number(body) <= 0;
}

/**
 * Whether a picture with these declared properties is painted: not `display: none`, not `visibility` other than visible (hidden, collapse,
 * or inherited from a group that hides it), and not fully transparent. `inheritedVisibility` is the value of its parent.
 */
export function isDrawnPicture(declared: ReadonlyMap<string, string>, inheritedVisibility: string): boolean {
  const own = declared.get('visibility');
  const visibility = own === undefined || own === 'inherit' ? inheritedVisibility : own;
  const opacity = declared.get('opacity');
  return declared.get('display') !== 'none' && visibility === 'visible' && (opacity === undefined || !isTransparent(opacity));
}
