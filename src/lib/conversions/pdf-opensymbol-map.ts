/*
 * OpenSymbol / StarSymbol / StarMath private-use mapping table (0xE080..0xE0DD).
 *
 * Adapted from Apache OpenOffice (`https://github.com/apache/openoffice`, commit
 * 34a6fe28b48dbd7f8484b1e2586abb43f38053b9):
 *   - main/unotools/source/misc/fontcvt.cxx (`aStarMathTab` lines 122-194,
 *     `aSymbolExtraTab` lines 1115-1134, `aTNRExtraTab` lines 1136-1152)
 *   - main/starmath/inc/types.hxx (`FONTNAME_MATH` line 29, `enum MathSymbol` lines 58-186)
 *   - main/extras/source/truetype/symbol/opens___.ttf (OpenSymbol Version 2.4.3 `cmap` and `glyf`)
 *
 * Notice from apache/openoffice `main/NOTICE`:
 *   Apache OpenOffice (https://www.openoffice.org)
 *   Copyright 2011-2026 The Apache Software Foundation
 *   Portions of this software copyright (c) 2000-2011, Oracle and/or its affiliates
 *
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

export const OPEN_SYMBOL_PUA_START = 0xe080;
export const OPEN_SYMBOL_PUA_END = 0xe0dd;
const OPEN_SYMBOL_PUA_COUNT = OPEN_SYMBOL_PUA_END - OPEN_SYMBOL_PUA_START + 1;

const SUBSET_TAG = /^[A-Z]{6}\+/;
const FONT_NAME_SUFFIX = /(?:regular|mt)$/;
const OPEN_SYMBOL_FAMILIES = new Set(['opensymbol', 'starsymbol', 'starmath']);

/**
 * Mappings from StarMath / OpenSymbol PUA slots (0xE080..0xE0DD) to standard Unicode scalars.
 * Standalone positioned math accents (0xE090..0xE09B) are omitted because PDF writers emit them
 * in separate text runs ahead of or above their base symbols, where a combining mark would attach
 * to the wrong token.
 */
const OPEN_SYMBOL_PUA_ENTRIES: readonly (readonly [number, number])[] = [
  [0xe080, 0x2030], // PER MILLE SIGN
  [0xe081, 0x23df], // BOTTOM CURLY BRACKET (underbrace)
  [0xe082, 0x23de], // TOP CURLY BRACKET (overbrace)
  [0xe083, 0x002b], // PLUS SIGN
  [0xe084, 0x003c], // LESS-THAN SIGN
  [0xe085, 0x003e], // GREATER-THAN SIGN
  [0xe086, 0x2a7d], // LESS-THAN OR SLANTED EQUAL TO
  [0xe087, 0x2a7e], // GREATER-THAN OR SLANTED EQUAL TO
  [0xe089, 0x2208], // ELEMENT OF
  [0xe08a, 0x0192], // LATIN SMALL LETTER F WITH HOOK
  [0xe08b, 0x2026], // HORIZONTAL ELLIPSIS (MS_DOTSLOW / cdot ellipsis)
  [0xe08c, 0x2192], // RIGHTWARDS ARROW
  [0xe08d, 0x221a], // SQUARE ROOT (tall)
  [0xe08e, 0x221a], // SQUARE ROOT (taller)
  [0xe08f, 0x221a], // SQUARE ROOT (tallest)
  [0xe09e, 0x0028], // LEFT PARENTHESIS (scalable MS_LPARENT)
  [0xe09f, 0x0029], // RIGHT PARENTHESIS (scalable MS_RPARENT)
  [0xe0a0, 0x2221], // MEASURED ANGLE
  [0xe0a6, 0x2032], // PRIME
  [0xe0a7, 0x007c], // VERTICAL LINE
  [0xe0a8, 0x002f], // SOLIDUS (wide slash)
  [0xe0a9, 0x005c], // REVERSE SOLIDUS (wide backslash)
  [0xe0ab, 0x007c], // VERTICAL LINE (evaluate bar)
  [0xe0ac, 0x0393], // GREEK CAPITAL LETTER GAMMA
  [0xe0ad, 0x0394], // GREEK CAPITAL LETTER DELTA
  [0xe0ae, 0x0398], // GREEK CAPITAL LETTER THETA
  [0xe0af, 0x039b], // GREEK CAPITAL LETTER LAMDA
  [0xe0b0, 0x039e], // GREEK CAPITAL LETTER XI
  [0xe0b1, 0x03a0], // GREEK CAPITAL LETTER PI
  [0xe0b2, 0x03a3], // GREEK CAPITAL LETTER SIGMA
  [0xe0b3, 0x03a5], // GREEK CAPITAL LETTER UPSILON
  [0xe0b4, 0x03a6], // GREEK CAPITAL LETTER PHI
  [0xe0b5, 0x03a8], // GREEK CAPITAL LETTER PSI
  [0xe0b6, 0x03a9], // GREEK CAPITAL LETTER OMEGA
  [0xe0b7, 0x03b1], // GREEK SMALL LETTER ALPHA
  [0xe0b8, 0x03b2], // GREEK SMALL LETTER BETA
  [0xe0b9, 0x03b3], // GREEK SMALL LETTER GAMMA
  [0xe0ba, 0x03b4], // GREEK SMALL LETTER DELTA
  [0xe0bb, 0x03b5], // GREEK SMALL LETTER EPSILON
  [0xe0bc, 0x03b6], // GREEK SMALL LETTER ZETA
  [0xe0bd, 0x03b7], // GREEK SMALL LETTER ETA
  [0xe0be, 0x03b8], // GREEK SMALL LETTER THETA
  [0xe0bf, 0x03b9], // GREEK SMALL LETTER IOTA
  [0xe0c0, 0x03ba], // GREEK SMALL LETTER KAPPA
  [0xe0c1, 0x03bb], // GREEK SMALL LETTER LAMDA
  [0xe0c2, 0x03bc], // GREEK SMALL LETTER MU
  [0xe0c3, 0x03bd], // GREEK SMALL LETTER NU
  [0xe0c4, 0x03be], // GREEK SMALL LETTER XI
  [0xe0c5, 0x03bf], // GREEK SMALL LETTER OMICRON
  [0xe0c6, 0x03c0], // GREEK SMALL LETTER PI
  [0xe0c7, 0x03c1], // GREEK SMALL LETTER RHO
  [0xe0c8, 0x03c3], // GREEK SMALL LETTER SIGMA
  [0xe0c9, 0x03c4], // GREEK SMALL LETTER TAU
  [0xe0ca, 0x03c5], // GREEK SMALL LETTER UPSILON
  [0xe0cb, 0x03c6], // GREEK SMALL LETTER PHI
  [0xe0cc, 0x03c7], // GREEK SMALL LETTER CHI
  [0xe0cd, 0x03c8], // GREEK SMALL LETTER PSI
  [0xe0ce, 0x03c9], // GREEK SMALL LETTER OMEGA
  [0xe0cf, 0x03b5], // GREEK SMALL LETTER EPSILON (open variant)
  [0xe0d0, 0x03d1], // GREEK THETA SYMBOL
  [0xe0d1, 0x03d6], // GREEK PI SYMBOL
  [0xe0d3, 0x03c2], // GREEK SMALL LETTER FINAL SIGMA
  [0xe0d4, 0x03d5], // GREEK PHI SYMBOL
  [0xe0d5, 0x2202], // PARTIAL DIFFERENTIAL
  [0xe0d6, 0x0131], // LATIN SMALL LETTER DOTLESS I
  [0xe0d9, 0x22a4], // DOWN TACK
  [0xe0db, 0x2190], // LEFTWARDS ARROW
  [0xe0dc, 0x2191], // UPWARDS ARROW
  [0xe0dd, 0x2193], // DOWNWARDS ARROW
];

const OPEN_SYMBOL_PUA_LUT = (() => {
  const lut = new Uint16Array(OPEN_SYMBOL_PUA_COUNT);
  for (const [pua, unicode] of OPEN_SYMBOL_PUA_ENTRIES) {
    lut[pua - OPEN_SYMBOL_PUA_START] = unicode;
  }
  return lut;
})();

/** Whether `fontName` (with or without subset tag) is OpenSymbol, StarSymbol, or StarMath. */
export function isOpenSymbolFontName(fontName: string): boolean {
  const key = fontName
    .replace(SUBSET_TAG, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(FONT_NAME_SUFFIX, '');
  return OPEN_SYMBOL_FAMILIES.has(key);
}

/**
 * Standard Unicode character for an OpenSymbol/StarSymbol/StarMath private-use code point in `0xE080..0xE0DD`,
 * or `undefined` when the font is not OpenSymbol or the slot is an unmapped standalone accent.
 */
export function mapOpenSymbolCharacter(fontName: string, codePoint: number): string | undefined {
  if (!isOpenSymbolFontName(fontName)) return undefined;
  if (codePoint < OPEN_SYMBOL_PUA_START || codePoint > OPEN_SYMBOL_PUA_END) return undefined;
  const mapped = OPEN_SYMBOL_PUA_LUT[codePoint - OPEN_SYMBOL_PUA_START];
  return mapped === 0 ? undefined : String.fromCodePoint(mapped);
}
