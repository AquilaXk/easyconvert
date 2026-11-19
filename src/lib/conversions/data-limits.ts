import { PayloadLimitError } from '../types';

/**
 * What the structured-data converters (CSV, TSV, JSON, NDJSON, YAML, TOML, XML read into values) accept, checked before the text is
 * parsed. A parser holds every value of the text as a JavaScript value, so a small text of empty objects, `- 1` lines or one row of
 * commas asks for gigabytes, and the time of a parse grows with the count of values and not with the bytes: eight megabytes of `- 1`
 * lines take six seconds and two gigabytes of YAML nodes. Each source therefore has an input size (a text the converter reads whole)
 * and a count of the characters that start a value, and a text over either is refused as an input over the limit (413) in a pass
 * over the text that stops at the limit. Direct table routes (data-fast-paths.ts) keep their own byte-level bounds and have no part
 * in these.
 *
 * The numbers follow what a conversion on a CPU pool thread (a 1 GiB heap, cpu-pool.ts) holds, measured on the structures of a table
 * of records: 400 to 520 bytes of heap for each JSON object, about 500 for each YAML node, 80 to 150 for each CSV cell or record.
 * The only size cap of a starred YAML reader is SnakeYAML's `codePointLimit` of 3 MB (LoaderOptions); the YAML 1.2 reader of this
 * product allows 8 MiB, which is 100 times the size of an ordinary configuration file and still within the heap of a thread.
 */
const MIB = 1024 * 1024;

export interface DataSourceLimits {
  /** Input bytes the converter reads whole. */
  readonly maxBytes: number;
  /** Most characters of `itemChars` in one text. */
  readonly maxItems: number;
  /** ASCII characters that start a value: a separator or a bracket of the source, or a line end. */
  readonly itemChars: string;
  /** What the characters stand for, for a refusal that names what it counts. */
  readonly unit: string;
}

export const DATA_SOURCE_LIMITS = {
  /** Delimited text: a cell is a field separator, a record a line end. */
  delimited: { maxBytes: 32 * MIB, maxItems: 8 * MIB, itemChars: ',;\t|\n\r', unit: 'cells and records' },
  /** JSON: an object or array opens with a bracket, and the values of one are told apart by commas. */
  json: { maxBytes: 32 * MIB, maxItems: 4 * MIB, itemChars: '{[,', unit: 'objects, arrays and separators' },
  /** JSON Lines: the line ends count as the records of the text. */
  ndjson: { maxBytes: 32 * MIB, maxItems: 4 * MIB, itemChars: '{[,\n', unit: 'objects, arrays, separators and lines' },
  /** YAML: a block node is a line, a flow node follows a comma or a bracket. */
  yaml: { maxBytes: 8 * MIB, maxItems: MIB / 2, itemChars: '\n,{[', unit: 'lines and flow items' },
  /** XML: a tag opens each element, comment and declaration. */
  xml: { maxBytes: 32 * MIB, maxItems: 4 * MIB, itemChars: '<', unit: 'tags' },
  /** TOML: a configuration language, which a reader holds in memory as it is (no count of values beyond the size). */
  toml: { maxBytes: 8 * MIB, maxItems: Infinity, itemChars: '', unit: 'values' },
} as const satisfies Record<string, DataSourceLimits>;

export type DataSourceKind = keyof typeof DATA_SOURCE_LIMITS;

/** The input bytes of a source past its size cap are refused before the text is decoded. */
export function assertDataInputBytes(kind: DataSourceKind, byteLength: number, label: string): void {
  const { maxBytes } = DATA_SOURCE_LIMITS[kind];
  if (byteLength > maxBytes) {
    throw new PayloadLimitError(`${label} input of ${byteLength} bytes is over the ${maxBytes / MIB} MiB this conversion reads; split the file or convert it to a columnar format.`);
  }
}

const ASCII_TABLE_SIZE = 128;
const CARRIAGE_RETURN = 0x0d;
const LINE_FEED = 0x0a;

/** One byte per ASCII code unit: 1 where the unit starts a value. Every character of `itemChars` is ASCII. */
const ITEM_TABLES: Readonly<Record<DataSourceKind, Uint8Array>> = Object.fromEntries(
  Object.entries(DATA_SOURCE_LIMITS).map(([kind, { itemChars }]) => {
    const table = new Uint8Array(ASCII_TABLE_SIZE);
    for (const char of itemChars) table[char.charCodeAt(0)] = 1;
    return [kind, table];
  })
) as Record<DataSourceKind, Uint8Array>;

/**
 * Refuses a decoded text with more value-starting characters than its source holds. The pass stops at the limit, so a text of any size
 * costs at most `maxItems` hits. A character counts whether or not it sits in a string, which over-counts a text of long prose and
 * never under-counts a text that is all structure; `\r\n` counts once.
 */
export function assertDataItemCount(kind: DataSourceKind, text: string, label: string): void {
  const { maxItems, unit } = DATA_SOURCE_LIMITS[kind];
  if (!Number.isFinite(maxItems)) return;
  const table = ITEM_TABLES[kind];
  const lineEndsCount = table[LINE_FEED] === 1 && table[CARRIAGE_RETURN] === 1;
  let items = 0;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code >= ASCII_TABLE_SIZE || table[code] === 0) continue;
    if (lineEndsCount && code === CARRIAGE_RETURN && text.charCodeAt(at + 1) === LINE_FEED) continue;
    if (++items > maxItems) {
      throw new PayloadLimitError(`${label} input holds more than ${maxItems} ${unit}; this conversion reads at most that many.`);
    }
  }
}
