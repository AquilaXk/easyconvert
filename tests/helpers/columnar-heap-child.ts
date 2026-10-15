import { convertData } from '../../src/lib/conversions/data';

/**
 * Child process of tests/data-columnar-memory.test.ts. It is started with a small V8 heap limit, builds one large input
 * as a Buffer (which lives outside the heap), runs a direct table conversion on it, and checks the output. A conversion
 * that holds one JavaScript string per cell, or per row, of the table cannot finish inside that heap.
 */

const SCENARIOS = ['jsonl-to-csv', 'csv-to-parquet', 'parquet-to-csv', 'parquet-to-json'] as const;
type Scenario = (typeof SCENARIOS)[number];

const MIB = 1024 * 1024;
const ROWS_PER_BATCH = 4096;
const CITIES = ['São Paulo', 'Nairobi', 'Osaka', 'Oslo', 'Kraków', 'Lima'];
const NOTES = ['', 'café order', 'needs review', '100% done'];

function csvRow(id: number): string {
  const amount = (id * 2654435761) % 10_000_000;
  const city = CITIES[id % CITIES.length];
  return `${id},${String(id).padStart(8, '0')},${city},${amount},${(id % 9000) / 8},${id % 3 === 0},${NOTES[id % NOTES.length]},k${id % 977}`;
}

function jsonRow(id: number): string {
  const amount = (id * 2654435761) % 10_000_000;
  return `{"id":${id},"code":"${String(id).padStart(8, '0')}","city":"${CITIES[id % CITIES.length]}","amount":${amount},"score":${(id % 9000) / 8},"active":${id % 3 === 0},"note":"${NOTES[id % NOTES.length]}","tag":"k${id % 977}"}`;
}

/** Writes `rows` lines, batch by batch, into one Buffer of the given byte size; returns the Buffer and the bytes used. */
function build(prefix: string, rows: number, render: (id: number) => string, capacity: number): Buffer {
  const out = Buffer.allocUnsafe(capacity);
  let pos = out.write(prefix, 0, 'utf8');
  for (let first = 0; first < rows; first += ROWS_PER_BATCH) {
    const last = Math.min(rows, first + ROWS_PER_BATCH);
    const lines: string[] = [];
    for (let id = first; id < last; id++) lines.push(render(id));
    pos += out.write(`${lines.join('\n')}\n`, pos, 'utf8');
  }
  return out.subarray(0, pos);
}

function count(buffer: Buffer, needle: string): number {
  let total = 0;
  for (let at = buffer.indexOf(needle); at !== -1; at = buffer.indexOf(needle, at + needle.length)) total++;
  return total;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function expectEqual(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) fail(`${what}: expected ${String(expected)}, got ${String(actual)}`);
}

async function parquetOf(rows: number): Promise<Buffer> {
  const csv = build('id,code,city,amount,score,active,note,tag\n', rows, csvRow, rows * 90 + 64);
  const converted = await convertData(csv, 'csv', 'parquet', {}, 'table.csv');
  return converted.buffer;
}

async function run(scenario: Scenario, rows: number): Promise<void> {
  if (scenario === 'jsonl-to-csv') {
    const input = build('', rows, jsonRow, rows * 130 + 64);
    const output = (await convertData(input, 'jsonl', 'csv', { bom: false }, 'table.jsonl')).buffer;
    expectEqual(count(output, '\r\n'), rows, 'record separators of the CSV');
    expectEqual(output.subarray(0, 100).toString('utf8').startsWith('id,code,city,amount,score,active,note,tag\r\n0,00000000,'), true, 'CSV head');
    expectEqual(output.subarray(output.length - 60).toString('utf8').endsWith(csvRow(rows - 1)), true, 'CSV tail');
    return;
  }
  const parquet = await parquetOf(rows);
  if (scenario === 'csv-to-parquet') {
    expectEqual(parquet.subarray(0, 4).toString('latin1'), 'PAR1', 'Parquet magic');
    return;
  }
  if (scenario === 'parquet-to-csv') {
    const output = (await convertData(parquet, 'parquet', 'csv', { bom: false }, 'table.parquet')).buffer;
    expectEqual(count(output, '\r\n'), rows, 'record separators of the CSV');
    expectEqual(output.subarray(output.length - 60).toString('utf8').endsWith(csvRow(rows - 1)), true, 'CSV tail');
    return;
  }
  const output = (await convertData(parquet, 'parquet', 'json', {}, 'table.parquet')).buffer;
  expectEqual(count(output, '\n  {\n'), rows, 'objects of the JSON array');
  expectEqual(output.subarray(output.length - 3).toString('utf8'), '}\n]', 'JSON tail');
}

const scenario = process.argv[2] as Scenario;
const rows = Number(process.argv[3]);
if (!SCENARIOS.includes(scenario) || !Number.isInteger(rows) || rows <= 0) fail(`usage: <${SCENARIOS.join('|')}> <rows>`);
run(scenario, rows).then(
  () => process.stdout.write(`ok ${scenario} ${rows} rows, peak heap limit respected, rss ${Math.round(process.memoryUsage().rss / MIB)} MiB\n`),
  (error: unknown) => fail(`${scenario}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
);
