/**
 * Writes small IGES files (80-column records, the section letter in column 73) for tests of the checks made before the kernel reads
 * one: the Global section as the parameter text given, line entities, and a Terminate line with the counts of the records written.
 */

const TEXT_COLUMNS = 72;
const SEQUENCE_WIDTH = 7;

function record(content: string, section: string, sequence: number): string {
  return `${content.padEnd(TEXT_COLUMNS, ' ')}${section}${String(sequence).padStart(SEQUENCE_WIDTH, ' ')}`;
}

function sectionRecords(text: string, section: string): string[] {
  const records: string[] = [];
  for (let at = 0; at < text.length || records.length === 0; at += TEXT_COLUMNS) records.push(record(text.slice(at, at + TEXT_COLUMNS), section, records.length + 1));
  return records;
}

export interface IgesParts {
  /** The Global section as one parameter list; it is cut into records of 72 columns. */
  global: string;
  start: string;
  /** Line entities (type 110) to write: two directory records and one parameter record each. */
  entities: number;
}

export const DEFAULT_GLOBAL =
  '1H,,1H;,4Hname,8Hfile.igs,3Hsys,3Hpre,32,38,6,308,15,3Hnum,1.0,2,2HMM,1,0.254,13H231116.083049,0.001,100.0,6Hauthor,3Horg,11,0,13H231116.083049;';

/** The records of a file, with the Terminate line counting what was written. */
export function igesRecords({ global = DEFAULT_GLOBAL, start = 'a test file', entities = 1 }: Partial<IgesParts> = {}): string[] {
  const starts = sectionRecords(start, 'S');
  const globals = sectionRecords(global, 'G');
  const directory: string[] = [];
  const parameters: string[] = [];
  for (let entity = 0; entity < entities; entity++) {
    const sequence = directory.length + 1;
    directory.push(record(`${'110'.padStart(8)}${String(parameters.length + 1).padStart(8)}`, 'D', sequence));
    directory.push(record(`${'110'.padStart(8)}${'0'.padStart(8)}`, 'D', sequence + 1));
    const text = `110,0.0,0.0,0.0,${entity}.0,1.0,0.0;`.padEnd(64, ' ');
    parameters.push(`${text}${String(sequence).padStart(8, ' ')}P${String(parameters.length + 1).padStart(SEQUENCE_WIDTH, ' ')}`);
  }
  const counts = [starts, globals, directory, parameters].map((records, index) => `${'SGDP'[index]}${String(records.length).padStart(SEQUENCE_WIDTH, '0')}`).join('');
  return [...starts, ...globals, ...directory, ...parameters, record(counts, 'T', 1)];
}

/** A file of those records joined by `lineEnd`. */
export function igesFile(parts: Partial<IgesParts> = {}, lineEnd = '\r\n'): Buffer {
  return Buffer.from(igesRecords(parts).join(lineEnd) + lineEnd, 'latin1');
}
