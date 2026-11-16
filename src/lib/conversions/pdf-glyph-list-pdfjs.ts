/**
 * Glyph name and character tables copied from pdf.js, which the Adobe Glyph List of pdf-glyph-list.ts lacks.
 *
 * Source: https://github.com/mozilla/pdf.js (Apache-2.0), tag v6.3.289 (the version of the `pdfjs-dist` package this
 * project reads PDFs with), commit 1c8020a7d4e43668ac287a3ecf9a8dbea17e4c56, files `src/core/glyphlist.js` (the entries
 * pdf.js adds to the Adobe Glyph List: lines 1102, 1103, 3071 and 3072, and the TeX block of lines 4232 to 4348) and
 * `src/core/unicode.js` (`getSpecialPUASymbols`, lines 21 to 49). The entries are copied as pdf.js writes them; only the
 * form differs (`t.name = 0x...;` is `name: 0x...,`). The entries pdf.js adds that this reader already covers are not
 * copied: `.notdef`, `controlNULL` (no text), and the ligatures `f_f`, `f_f_i`, `f_f_l`, `f_i` and `f_l`
 * (pdf-glyph-names.ts maps a ligature name by its components).
 *
 * Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/** Names the Adobe Glyph List does not hold: two it misses (`angbracketleft`), `planckover2pi` and the glyph names of the TeX fonts. */
export const PDFJS_GLYPH_LIST_ADDITIONS: Readonly<Record<string, number>> = {
  angbracketleft: 0x3008, // Glyph is missing from Adobe's original list.
  angbracketright: 0x3009, // Glyph is missing from Adobe's original list.
  circlecopyrt: 0x00a9, // Glyph is missing from Adobe's original list.
  planckover2pi: 0x210f,
  planckover2pi1: 0x210f,
  // TeX-specific glyph names.
  angbracketleftbig: 0x2329,
  angbracketleftBig: 0x2329,
  angbracketleftbigg: 0x2329,
  angbracketleftBigg: 0x2329,
  angbracketrightBig: 0x232a,
  angbracketrightbig: 0x232a,
  angbracketrightBigg: 0x232a,
  angbracketrightbigg: 0x232a,
  arrowhookleft: 0x21aa,
  arrowhookright: 0x21a9,
  arrowlefttophalf: 0x21bc,
  arrowleftbothalf: 0x21bd,
  arrownortheast: 0x2197,
  arrownorthwest: 0x2196,
  arrowrighttophalf: 0x21c0,
  arrowrightbothalf: 0x21c1,
  arrowsoutheast: 0x2198,
  arrowsouthwest: 0x2199,
  backslashbig: 0x2216,
  backslashBig: 0x2216,
  backslashBigg: 0x2216,
  backslashbigg: 0x2216,
  bardbl: 0x2016,
  bracehtipdownleft: 0xfe37,
  bracehtipdownright: 0xfe37,
  bracehtipupleft: 0xfe38,
  bracehtipupright: 0xfe38,
  braceleftBig: 0x007b,
  braceleftbig: 0x007b,
  braceleftbigg: 0x007b,
  braceleftBigg: 0x007b,
  bracerightBig: 0x007d,
  bracerightbig: 0x007d,
  bracerightbigg: 0x007d,
  bracerightBigg: 0x007d,
  bracketleftbig: 0x005b,
  bracketleftBig: 0x005b,
  bracketleftbigg: 0x005b,
  bracketleftBigg: 0x005b,
  bracketrightBig: 0x005d,
  bracketrightbig: 0x005d,
  bracketrightbigg: 0x005d,
  bracketrightBigg: 0x005d,
  ceilingleftbig: 0x2308,
  ceilingleftBig: 0x2308,
  ceilingleftBigg: 0x2308,
  ceilingleftbigg: 0x2308,
  ceilingrightbig: 0x2309,
  ceilingrightBig: 0x2309,
  ceilingrightbigg: 0x2309,
  ceilingrightBigg: 0x2309,
  circledotdisplay: 0x2299,
  circledottext: 0x2299,
  circlemultiplydisplay: 0x2297,
  circlemultiplytext: 0x2297,
  circleplusdisplay: 0x2295,
  circleplustext: 0x2295,
  contintegraldisplay: 0x222e,
  contintegraltext: 0x222e,
  coproductdisplay: 0x2210,
  coproducttext: 0x2210,
  floorleftBig: 0x230a,
  floorleftbig: 0x230a,
  floorleftbigg: 0x230a,
  floorleftBigg: 0x230a,
  floorrightbig: 0x230b,
  floorrightBig: 0x230b,
  floorrightBigg: 0x230b,
  floorrightbigg: 0x230b,
  hatwide: 0x0302,
  hatwider: 0x0302,
  hatwidest: 0x0302,
  intercal: 0x1d40,
  integraldisplay: 0x222b,
  integraltext: 0x222b,
  intersectiondisplay: 0x22c2,
  intersectiontext: 0x22c2,
  logicalanddisplay: 0x2227,
  logicalandtext: 0x2227,
  logicalordisplay: 0x2228,
  logicalortext: 0x2228,
  parenleftBig: 0x0028,
  parenleftbig: 0x0028,
  parenleftBigg: 0x0028,
  parenleftbigg: 0x0028,
  parenrightBig: 0x0029,
  parenrightbig: 0x0029,
  parenrightBigg: 0x0029,
  parenrightbigg: 0x0029,
  prime: 0x2032,
  productdisplay: 0x220f,
  producttext: 0x220f,
  radicalbig: 0x221a,
  radicalBig: 0x221a,
  radicalBigg: 0x221a,
  radicalbigg: 0x221a,
  radicalbt: 0x221a,
  radicaltp: 0x221a,
  radicalvertex: 0x221a,
  slashbig: 0x002f,
  slashBig: 0x002f,
  slashBigg: 0x002f,
  slashbigg: 0x002f,
  summationdisplay: 0x2211,
  summationtext: 0x2211,
  tildewide: 0x02dc,
  tildewider: 0x02dc,
  tildewidest: 0x02dc,
  uniondisplay: 0x22c3,
  unionmultidisplay: 0x228e,
  unionmultitext: 0x228e,
  unionsqdisplay: 0x2294,
  unionsqtext: 0x2294,
  uniontext: 0x22c3,
  vextenddouble: 0x2225,
  vextendsingle: 0x2223,
};

/**
 * Some characters, e.g. copyrightserif, are mapped to the private use area and might not be displayed using standard
 * fonts. Mapping/hacking well-known chars to the similar equivalents in the normal characters range.
 */
export const SPECIAL_PRIVATE_USE_SYMBOLS: Readonly<Record<number, number>> = {
  63721: 0x00a9, // copyrightsans (0xF8E9) => copyright
  63193: 0x00a9, // copyrightserif (0xF6D9) => copyright
  63720: 0x00ae, // registersans (0xF8E8) => registered
  63194: 0x00ae, // registerserif (0xF6DA) => registered
  63722: 0x2122, // trademarksans (0xF8EA) => trademark
  63195: 0x2122, // trademarkserif (0xF6DB) => trademark
  63718: 0x23d0, // arrowvertex (0xF8E6)
  63719: 0x23af, // arrowhorizex (0xF8E7)
  63733: 0x23ae, // integralex (0xF8F5)
  63729: 0x23a7, // bracelefttp (0xF8F1)
  63730: 0x23a8, // braceleftmid (0xF8F2)
  63731: 0x23a9, // braceleftbt (0xF8F3)
  63740: 0x23ab, // bracerighttp (0xF8FC)
  63741: 0x23ac, // bracerightmid (0xF8FD)
  63742: 0x23ad, // bracerightbt (0xF8FE)
  63726: 0x23a1, // bracketlefttp (0xF8EE)
  63727: 0x23a2, // bracketleftex (0xF8EF)
  63728: 0x23a3, // bracketleftbt (0xF8F0)
  63737: 0x23a4, // bracketrighttp (0xF8F9)
  63738: 0x23a5, // bracketrightex (0xF8FA)
  63739: 0x23a6, // bracketrightbt (0xF8FB)
  63723: 0x239b, // parenlefttp (0xF8EB)
  63724: 0x239c, // parenleftex (0xF8EC)
  63725: 0x239d, // parenleftbt (0xF8ED)
  63734: 0x239e, // parenrighttp (0xF8F6)
  63735: 0x239f, // parenrightex (0xF8F7)
  63736: 0x23a0, // parenrightbt (0xF8F8)
};
