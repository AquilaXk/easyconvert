"""Independent Parquet oracle: reads and writes Parquet with the reference Arrow implementation.

Run as `python3 -I parquet_oracle.py <command> ...`. Exit code 3 with `MODULE_MISSING <name>` on stderr
means a required module is not installed (the TypeScript wrapper turns that into an explicit skip).

Commands (JSON on stdout):
  read <file>                              pyarrow read: schema, row-group metadata, statistics, every value
  duckdb <file>                            DuckDB read: column names, types, every value
  write <rows.json> <schema.json> <out> <codec>   reference writer used for size comparison
  codec-compress <codec> <in> <out>        pyarrow block compression (snappy raw block, zstd frame)
  snappy-decompress <in> <out> <size>      raw snappy block
  make-fixtures <dir>                      regenerate tests/fixtures/parquet (see FIXTURE_ROWS below)

Values are tagged so JSON keeps them exact: doubles as {"$f": <big-endian IEEE-754 hex>},
integers beyond 2^53 as {"$i": "<decimal>"}.
"""

import json
import struct
import sys

EXIT_MODULE_MISSING = 3
MAX_SAFE_INTEGER = 2**53 - 1


def require(name):
    try:
        return __import__(name)
    except ImportError:
        sys.stderr.write("MODULE_MISSING %s\n" % name)
        sys.exit(EXIT_MODULE_MISSING)


def tag(value):
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, float):
        return {"$f": struct.pack(">d", value).hex()}
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            return {"$i": str(value)}
        return value
    raise TypeError("unsupported oracle value type %s" % type(value))


def untag(value):
    if isinstance(value, dict) and "$f" in value:
        return struct.unpack(">d", bytes.fromhex(value["$f"]))[0]
    if isinstance(value, dict) and "$i" in value:
        return int(value["$i"])
    return value


def command_read(path):
    require("pyarrow")
    import pyarrow.parquet as pq

    pf = pq.ParquetFile(path)
    meta = pf.metadata
    table = pf.read()
    row_groups = []
    for rg_index in range(meta.num_row_groups):
        rg = meta.row_group(rg_index)
        columns = []
        for col_index in range(rg.num_columns):
            col = rg.column(col_index)
            stats = col.statistics
            entry = {
                "path": col.path_in_schema,
                "physicalType": col.physical_type,
                "codec": col.compression,
                "encodings": sorted(col.encodings),
                "numValues": col.num_values,
                "hasDictionaryPage": col.has_dictionary_page,
                "totalCompressedSize": col.total_compressed_size,
                "totalUncompressedSize": col.total_uncompressed_size,
                "hasStatistics": stats is not None,
            }
            if stats is not None:
                entry["nullCount"] = stats.null_count
                entry["hasMinMax"] = stats.has_min_max
                if stats.has_min_max:
                    entry["min"] = tag(stats.min)
                    entry["max"] = tag(stats.max)
            columns.append(entry)
        row_groups.append({"numRows": rg.num_rows, "columns": columns})
    schema = []
    for field in pf.schema_arrow:
        schema.append({"name": field.name, "type": str(field.type), "nullable": field.nullable})
    data = {}
    for name in table.column_names:
        data[name] = [tag(v) for v in table.column(name).to_pylist()]
    json.dump(
        {
            "numRows": meta.num_rows,
            "numRowGroups": meta.num_row_groups,
            "schema": schema,
            "rowGroups": row_groups,
            "columns": data,
        },
        sys.stdout,
    )


def command_duckdb(path):
    duckdb = require("duckdb")
    con = duckdb.connect()
    cursor = con.execute("SELECT * FROM read_parquet(?)", [path])
    names = [d[0] for d in cursor.description]
    types = [str(d[1]) for d in cursor.description]
    rows = cursor.fetchall()
    data = {}
    for index, name in enumerate(names):
        data[name] = [tag(row[index]) for row in rows]
    json.dump({"names": names, "types": types, "numRows": len(rows), "columns": data}, sys.stdout)


def command_write(rows_path, schema_path, out_path, codec):
    pa = require("pyarrow")
    import pyarrow.parquet as pq

    with open(rows_path, "r", encoding="utf-8") as fh:
        columns = json.load(fh)
    with open(schema_path, "r", encoding="utf-8") as fh:
        schema = json.load(fh)
    arrow_types = {
        "int64": pa.int64(),
        "double": pa.float64(),
        "string": pa.string(),
        "bool": pa.bool_(),
    }
    arrays = []
    fields = []
    for name, kind in schema:
        arrays.append(pa.array(columns[name], type=arrow_types[kind]))
        fields.append(pa.field(name, arrow_types[kind]))
    table = pa.Table.from_arrays(arrays, schema=pa.schema(fields))
    pq.write_table(table, out_path, compression=codec)
    json.dump({"ok": True}, sys.stdout)


def command_codec_compress(codec, in_path, out_path):
    pa = require("pyarrow")
    with open(in_path, "rb") as fh:
        raw = fh.read()
    packed = pa.compress(raw, codec=codec, asbytes=True)
    with open(out_path, "wb") as fh:
        fh.write(packed)
    json.dump({"size": len(packed)}, sys.stdout)


def command_snappy_decompress(in_path, out_path, size):
    pa = require("pyarrow")
    with open(in_path, "rb") as fh:
        packed = fh.read()
    raw = pa.decompress(packed, decompressed_size=int(size), codec="snappy", asbytes=True)
    with open(out_path, "wb") as fh:
        fh.write(raw)
    json.dump({"size": len(raw)}, sys.stdout)


FIXTURE_ROWS = 2500
FIXTURE_NOTE_MODULUS = 7


def fixture_columns():
    """Hand-authored rows: every value is a closed-form function of the row index."""
    ids = [None if i % 11 == 5 else i * 7 - 3000 for i in range(FIXTURE_ROWS)]
    names = [None if i % 9 == 4 else "name-%d" % (i % 13) for i in range(FIXTURE_ROWS)]
    notes = ["" if i % FIXTURE_NOTE_MODULUS == 0 else "n\u00e9\U0001f600-%d" % (i % 3) for i in range(FIXTURE_ROWS)]
    scores = [None if i % 5 == 1 else (i % 17) * 0.25 - 1.0 for i in range(FIXTURE_ROWS)]
    flags = [None if i % 6 == 2 else i % 3 == 0 for i in range(FIXTURE_ROWS)]
    return {"id": ids, "name": names, "note": notes, "score": scores, "flag": flags}


def command_make_fixtures(out_dir):
    pa = require("pyarrow")
    import os
    import pyarrow.parquet as pq

    columns = fixture_columns()
    table = pa.table(
        {
            "id": pa.array(columns["id"], type=pa.int64()),
            "name": pa.array(columns["name"], type=pa.string()),
            "note": pa.array(columns["note"], type=pa.string()),
            "score": pa.array(columns["score"], type=pa.float64()),
            "flag": pa.array(columns["flag"], type=pa.bool_()),
        }
    )
    os.makedirs(out_dir, exist_ok=True)
    variants = {
        "dictionary-snappy.parquet": dict(compression="snappy", use_dictionary=True, row_group_size=1000, data_page_size=2048),
        "plain-gzip.parquet": dict(compression="gzip", use_dictionary=False, row_group_size=2500),
        "dictionary-zstd.parquet": dict(compression="zstd", use_dictionary=True, row_group_size=2500),
        "plain-uncompressed.parquet": dict(compression="none", use_dictionary=False, row_group_size=2500),
        "data-page-v2.parquet": dict(compression="snappy", data_page_version="2.0", row_group_size=2500),
    }
    for name, options in variants.items():
        pq.write_table(table, os.path.join(out_dir, name), **options)
    nested = pa.table({"point": pa.array([{"x": 1, "y": 2}, {"x": 3, "y": 4}])})
    pq.write_table(nested, os.path.join(out_dir, "nested-struct.parquet"))
    expected = {name: [tag(v) for v in values] for name, values in columns.items()}
    with open(os.path.join(out_dir, "expected.json"), "w", encoding="utf-8") as fh:
        json.dump({"numRows": FIXTURE_ROWS, "columns": expected}, fh)
    json.dump({"ok": True}, sys.stdout)


COMMANDS = {
    "make-fixtures": command_make_fixtures,
    "read": command_read,
    "duckdb": command_duckdb,
    "write": command_write,
    "codec-compress": command_codec_compress,
    "snappy-decompress": command_snappy_decompress,
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        sys.stderr.write("usage: parquet_oracle.py <%s> ...\n" % "|".join(COMMANDS))
        sys.exit(2)
    COMMANDS[sys.argv[1]](*sys.argv[2:])
