# Parquet fixtures

All `*.parquet` files here except `legacy-writer.parquet` are written by the reference Arrow
implementation. Regenerate them with `python3 -I tests/helpers/parquet_oracle.py make-fixtures
tests/fixtures/parquet`. The rows are hand-authored closed-form functions of the row index (see
`fixture_columns` and `logical_fixture` in that script) and the exact expected values live in
`expected.json` and `logical-expected.json`; no expected value is produced by this repository's reader
or writer.

## legacy-writer.parquet

Written once by this repository's writer as it was at commit `d183a2d` (before issue 526), with:

    encodeParquet([
      { id: 1, name: 'alpha', score: 1.5, ok: true },
      { id: 2, name: 'beta', score: 2.25, ok: false },
      { id: 3, name: 'gamma', score: -0.5, ok: true },
      { id: 4, name: 'café 😀', score: 1000000.125, ok: false },
    ])

SHA-256 `a7aa1c73a8bf92d4efd116adbdc7a3a6138e6600ce0cee97abb0ed30ee0486e5`. The file is deliberately
invalid Parquet: its columns are OPTIONAL but declare PLAIN definition levels and carry no level bytes
(the reference reader rejects it with "Unknown encoding type for levels"). It exists only to lock the
reader's compatibility path for files that older easyconvert versions already produced. Do not
regenerate it.
