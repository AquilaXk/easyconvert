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

## Files from the Apache parquet-testing corpus

Copied unchanged from `data/` of https://github.com/apache/parquet-testing at commit
`56653c43` (Apache License 2.0), for `tests/parquet-flat-gaps.test.ts`:

| Fixture | Source path | What it covers |
| --- | --- | --- |
| `hadoop_lz4_compressed.parquet` | `data/hadoop_lz4_compressed.parquet` | LZ4 codec, Hadoop framing |
| `hadoop_lz4_compressed_larger.parquet` | `data/hadoop_lz4_compressed_larger.parquet` | LZ4 codec, Hadoop framing, 10,000 rows |
| `non_hadoop_lz4_compressed.parquet` | `data/non_hadoop_lz4_compressed.parquet` | LZ4 codec, bare raw block |
| `page_v2_empty_compressed.parquet` | `data/page_v2_empty_compressed.parquet` | ZSTD frame of an empty section |
| `unknown-logical-type.parquet` | `data/unknown-logical-type.parquet` | unknown logical type read by physical type |
| `int32_with_uuid_logical_type.parquet` | `data/int32_with_uuid_logical_type.parquet` | UUID annotation on INT32 |
| `geospatial-with-nan.parquet` | `data/geospatial/geospatial-with-nan.parquet` | GEOMETRY column |
| `geospatial-crs-geography.parquet` | `data/geospatial/crs-geography.parquet` | GEOGRAPHY column |

`parquet-testing-expected.json` holds the values of pyarrow 26.0.1 reading these files (the first three
rows and the last row of each; binary as UTF-8 text when valid and base64 otherwise, geospatial columns
always base64). No expected value comes from this repository's reader.

## Nested files (`nested/`, `nested-expected.json`, `nested-struct.parquet`)

For `tests/parquet-nested.test.ts` and `tests/parquet-nested-hardening.test.ts`.

Copied unchanged from `data/` of https://github.com/apache/parquet-testing at commit `56653c43` (Apache License 2.0):
`datapage_v2.snappy`, `incorrect_map_schema`, `list_columns`, `map_no_value`, `nested_lists.snappy`,
`nested_maps.snappy`, `nested_structs.rust`, `nonnullable.impala`, `null_list`, `nullable.impala`, `nulls.snappy`,
`old_list_structure`, `repeated_no_annotation` and `repeated_primitive_no_list`. Together they cover the three-level
LIST and MAP layout, the legacy two-level lists (a repeated primitive, `array`, a repeated group of several fields),
a map without a value column, a map with optional keys, a repeated group without any annotation, and a struct of
36 structs. `large_string_map.brotli` is left out: it needs the Brotli codec, which this reader does not decode.

`nested-mixed-v1`, `nested-mixed-v2` and `nested-mixed-gzip` are written by pyarrow 26.0.1 from closed-form rows
(`python3 -I tests/helpers/parquet_nested_oracle.py make tests/fixtures/parquet/nested`): a list of structs with lists
inside, a map from string to list, a struct of structs, a list of lists, a map from integer to string, a list of maps and
a required list, with nulls at every level and empty lists, over several pages and row groups, in data page v1 with
Snappy and dictionaries, v2 with Zstandard and no dictionaries, and v1 with Gzip.

`nested-expected.json` holds the rows pyarrow 26.0.1 reads from each file (`python3 -I
tests/helpers/parquet_nested_oracle.py expect tests/fixtures/parquet nested-expected.json <names>`), in the shape the
converter writes: a list is an array, a struct an object, and a map an object when its keys are strings, otherwise an
array of `{key, value}`, plus per column how a table target cuts it into cells (`shapes`: a struct is one column per field, a map one cell, the rest one cell each). A timestamp whose year Python cannot hold is stored as its integer ticks. pyarrow refuses
`incorrect_map_schema` ("Map keys must be annotated as required"), so the test states its one row from DuckDB 2.0.
No expected value comes from this repository's reader.
