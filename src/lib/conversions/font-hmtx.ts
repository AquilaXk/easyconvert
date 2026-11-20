/** hmtx: each long metric is an advance width (u16) and a left side bearing (i16); later glyphs have a bearing only. */
export const HMTX_LONG_METRIC_BYTES = 4;
export const HMTX_BEARING_ONLY_BYTES = 2;
const HMTX_LSB_OFFSET = 2;

/**
 * The number of long metrics hhea declares: the advance of the last glyph is repeated by every glyph after the long metrics, so
 * the run of glyphs at the end that share it is written as left side bearings only. This is the form every font tool writes, and
 * the only one fontTools reads back from a WOFF2 file (it compiles a reconstructed hmtx in this form and then finds its hhea
 * declaring more metrics than the table holds).
 */
export function shortestLongMetrics(advances: readonly number[]): number {
  const last = advances.length - 1;
  let count = advances.length;
  while (count > 1 && advances[count - 2] === advances[last]) count--;
  return count;
}

/** hmtx: a long metric (advance, left side bearing) for each of the first `shortestLongMetrics` glyphs and a left side bearing for each glyph after. */
export function compactHmtx(advances: readonly number[], bearings: readonly number[]): Buffer {
  const longMetrics = shortestLongMetrics(advances);
  const out = Buffer.alloc(longMetrics * HMTX_LONG_METRIC_BYTES + (advances.length - longMetrics) * HMTX_BEARING_ONLY_BYTES);
  let at = 0;
  for (let glyph = 0; glyph < advances.length; glyph++) {
    if (glyph < longMetrics) {
      out.writeUInt16BE(advances[glyph], at);
      at += HMTX_LSB_OFFSET;
    }
    out.writeInt16BE(bearings[glyph], at);
    at += HMTX_BEARING_ONLY_BYTES;
  }
  return out;
}
