# Parquet golden files

`columnar-30-records.parquet`, `columnar-50-records.parquet` and `columnar-snappy-records.parquet` (60 rows) hold the
records that `synthesizeParquetColumnarCorpus` in `tests/helpers/corpus-synthesizer.ts` defines: ten columns
(`transaction_id`, `account_code`, `category`, `region`, `amount`, `tax_rate`, `is_cleared`, `timestamp`,
`execution_latency_ms`, `notes`), the last one nullable, Snappy-compressed.

They are written by the reference Parquet writer (pyarrow, through `tests/helpers/parquet_oracle.py`), not by any
encoder of this project. Regenerate them with `npx tsx scripts/generate-parquet-goldens.ts` (needs python3 with
pyarrow). pyarrow records its own version in the footer (`created_by`), so a new pyarrow changes the bytes; the
files are replaced on purpose only.

Earlier versions of these files were produced by a hand-written test encoder and could not be read by the reference
reader (pyarrow: "Unknown encoding type for levels"). Tests read them with pyarrow and with the decoder under test.
