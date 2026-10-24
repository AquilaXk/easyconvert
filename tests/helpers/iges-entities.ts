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
export function globalParameters(text: string): string[] {
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

/** The records of the Parameter Data section, joined without their section columns. */
function parameterData(text: string): string {
  return recordsOf(text, 'P')
    .map((record) => record.slice(0, 64))
    .join('');
}

/**
 * The control points of the first Rational B-Spline Surface (entity 128) of the Parameter Data section, in the numbers of the file
 * (before any unit is applied): parameters 2 to 10 are the degrees and flags, then the knots, the weights and the points (IGES 5.3, 4.23).
 */
export function igesFirstSurfaceControlPoints(text: string): Array<[number, number, number]> {
  const entity = parameterData(text)
    .split(';')
    .map((data) => data.trim())
    .find((data) => data.startsWith('128,'));
  if (entity === undefined) throw new Error('the IGES file has no Rational B-Spline Surface (entity 128)');
  const numbers = entity.split(',').map((token) => Number(token.trim().replace('D', 'E')));
  const [k1, k2, m1, m2] = numbers.slice(1, 5);
  const knots = k1 + m1 + 2 + (k2 + m2 + 2);
  const weights = (k1 + 1) * (k2 + 1);
  const first = 10 + knots + weights;
  const points: Array<[number, number, number]> = [];
  for (let i = 0; i < weights; i++) points.push([numbers[first + 3 * i], numbers[first + 3 * i + 1], numbers[first + 3 * i + 2]]);
  return points;
}

/** The unit name the Global section spells out as a Hollerith string right after the unit flag: `2HMM`, or null. */
export function igesDeclaredUnitName(text: string): string | null {
  const match = /,(\d+),(\d+)H([^,;]+),/.exec(recordsOf(text, 'G').join(''));
  return match === null ? null : match[3].slice(0, Number(match[2]));
}
