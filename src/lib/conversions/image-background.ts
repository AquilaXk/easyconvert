import type sharp from 'sharp';
import { ConversionOptions, UnsupportedOptionError } from '../types';

/**
 * Background colour handling for image output.
 *
 * Targets that cannot store alpha ("opaque targets") get transparent pixels flattened onto the background,
 * and `fit: 'contain'` letterboxes them with it. The background is the `background` option (`#rgb` or
 * `#rrggbb`) and defaults to white. Targets that can store alpha keep transparency and only paint
 * letterbox bars when `background` is given explicitly.
 */

/** Image options on top of the shared conversion options. */
export interface ImageConversionOptions extends ConversionOptions {
  /** `#rgb` or `#rrggbb`; fills flattened transparency and `fit: 'contain'` bars. Defaults to white. */
  background?: string;
}

/** Targets that store no alpha channel: transparency would otherwise decode as black. */
export const OPAQUE_IMAGE_TARGETS: ReadonlySet<string> = new Set(['jpg', 'jpeg', 'bmp', 'eps', 'ps', 'exr', 'ultrahdr']);

export interface RgbColour {
  r: number;
  g: number;
  b: number;
}

const WHITE: RgbColour = { r: 255, g: 255, b: 255 };
const HEX_COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const SHORT_HEX_LENGTH = 3;
const HEX_RADIX = 16;
const HEX_DIGITS_PER_CHANNEL = 2;
const OPAQUE_ALPHA = 1;
const TRANSPARENT_ALPHA = 0;

/** Parses the `background` option; undefined when it is absent, an UnsupportedOptionError when malformed. */
export function parseBackground(value: unknown): RgbColour | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !HEX_COLOUR.test(value)) {
    throw new UnsupportedOptionError(
      `Unsupported background ${JSON.stringify(value)}: use a #rgb or #rrggbb colour`
    );
  }
  const digits = value.slice(1);
  const full =
    digits.length === SHORT_HEX_LENGTH
      ? [...digits].map((digit) => digit + digit).join('')
      : digits;
  const channel = (index: number) =>
    Number.parseInt(full.slice(index * HEX_DIGITS_PER_CHANNEL, (index + 1) * HEX_DIGITS_PER_CHANNEL), HEX_RADIX);
  return { r: channel(0), g: channel(1), b: channel(2) };
}

/** Colour that transparent pixels are flattened onto for an opaque target. */
export function flattenColour(background: RgbColour | undefined): RgbColour {
  return background ?? WHITE;
}

/** Fill colour for `fit: 'contain'` bars: opaque for the requested or opaque-target case, else transparent. */
export function letterboxColour(background: RgbColour | undefined, isOpaqueTarget: boolean): sharp.RGBA {
  if (background) return { ...background, alpha: OPAQUE_ALPHA };
  if (isOpaqueTarget) return { ...WHITE, alpha: OPAQUE_ALPHA };
  return { ...WHITE, alpha: TRANSPARENT_ALPHA };
}
