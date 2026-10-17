/**
 * Reads the parts of an IGES file (ANSI Y14.26M, fixed 80-column records) that a test needs without any converter: the
 * entity type numbers of the Directory Entry section (two records per entity, the type in the first eight columns) and the
 * length unit flag of the Global section (parameter 14: 1 inch, 2 millimetre, ...).
 */

const SECTION_COLUMN = 72;
const IGES_UNIT_FLAG_PARAMETER = 14;

function recordsOf(text: string, section: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > SECTION_COLUMN && line[SECTION_COLUMN] === section)
    .map((line) => line.slice(0, SECTION_COLUMN));
}

/** How many entities of each type number the Directory Entry section lists. */
export function igesEntityCounts(text: string): Map<number, number> {
  const counts = new Map<number, number>();
  const records = recordsOf(text, 'D');
  for (let i = 0; i < records.length; i += 2) {
    const type = Number(records[i].slice(0, 8));
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return counts;
}

/** The parameters of the Global section: Hollerith strings (`nnHtext`) are read by their count. */
function globalParameters(text: string): string[] {
  const global = recordsOf(text, 'G').join('');
  const delimiters = /^1H(.),1H(.),/.exec(global);
  const [parameterDelimiter, recordDelimiter] = delimiters === null ? [',', ';'] : [delimiters[1], delimiters[2]];
  let position = delimiters === null ? 0 : delimiters[0].length;
  const parameters: string[] = delimiters === null ? [] : [parameterDelimiter, recordDelimiter];
  while (position < global.length) {
    const hollerith = /^\s*(\d+)H/.exec(global.slice(position));
    if (hollerith !== null) {
      const start = position + hollerith[0].length;
      parameters.push(global.slice(start, start + Number(hollerith[1])));
      position = start + Number(hollerith[1]) + 1;
      continue;
    }
    let end = position;
    while (end < global.length && global[end] !== parameterDelimiter && global[end] !== recordDelimiter) end++;
    parameters.push(global.slice(position, end).trim());
    if (global[end] === recordDelimiter) break;
    position = end + 1;
  }
  return parameters;
}

/** The length unit flag the Global section declares (2 is millimetre), or NaN when it holds none. */
export function igesLengthUnitFlag(text: string): number {
  return Number(globalParameters(text)[IGES_UNIT_FLAG_PARAMETER - 1]);
}
