import { convertData } from '../src/lib/conversions/data';

/**
 * Child process of tests/delimited-ragged-limits.test.ts, started with a small V8 heap limit. It converts a CSV file of
 * about 80 KB whose last record has 20,000 commas under a header of two fields and 20,000 records of two fields. Padding
 * every record to the widest one is 400 million cells; a reader that does so cannot finish inside that heap.
 */

const MIB = 1024 * 1024;
const SHORT_RECORDS = 20_000;
const WIDE_RECORD_COMMAS = 20_000;

const csv = Buffer.from(`a,b\n${'x,y\n'.repeat(SHORT_RECORDS)}${','.repeat(WIDE_RECORD_COMMAS)}\n`);
const widestRow = SHORT_RECORDS + 2;
const started = Date.now();

convertData(csv, 'csv', 'json', {}, 'ragged.csv').then(
  () => {
    process.stderr.write('the 400-million-cell table was converted\n');
    process.exit(1);
  },
  (error: unknown) => {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (!message.startsWith('DataParseError:') || !message.includes(`row ${widestRow}`)) {
      process.stderr.write(`unexpected failure: ${message}\n`);
      process.exit(1);
    }
    process.stdout.write(`refused in ${Date.now() - started} ms, rss ${Math.round(process.memoryUsage().rss / MIB)} MiB: ${message}\n`);
  }
);
