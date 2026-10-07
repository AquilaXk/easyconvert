/**
 * Regenerates the Parquet golden files under tests/fixtures/golden/data with the reference writer (pyarrow).
 *
 * Usage: npx tsx scripts/generate-parquet-goldens.ts
 *
 * Needs python3 with pyarrow. The records are the ones `synthesizeParquetColumnarCorpus` defines; the bytes are
 * written by pyarrow, so a golden file is always readable by the reference reader. pyarrow stamps its own
 * version into the footer (`created_by`), so the files change when pyarrow does: regenerate on purpose only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PARQUET_GOLDEN_FILES, synthesizeParquetColumnarCorpus, writeCorpusParquet } from '../tests/helpers/corpus-synthesizer';

const GOLDEN_DIR = path.resolve(__dirname, '../tests/fixtures/golden/data');

for (const [rowCount, fileName] of PARQUET_GOLDEN_FILES) {
  // A row count whose golden file is absent is written fresh by synthesizeParquetColumnarCorpus; to rewrite an
  // existing file the records are taken from the same synthesizer and written directly.
  const { records } = synthesizeParquetColumnarCorpus(rowCount);
  fs.writeFileSync(path.join(GOLDEN_DIR, fileName), writeCorpusParquet(records));
  console.log(`wrote ${fileName} (${rowCount} rows)`);
}
