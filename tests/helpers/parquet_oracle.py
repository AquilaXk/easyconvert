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


def logical_fixture():
    """Columns and the exact text a reader must produce for them. Every expected string is a literal
    written by hand from the value's definition; none is computed by the reader or the writer."""
    import base64
    import datetime
    from decimal import Decimal

    utc = datetime.timezone.utc
    arrays = {
        "i64": ([9223372036854775807, -9223372036854775808, 9007199254740993, 9007199254740991, -9007199254740991, 0, None], "int64"),
        "u64": ([18446744073709551615, 9007199254740993, 9007199254740991, 5, 0, None, 1], "uint64"),
        "u32": ([4294967295, 0, 7, None, 1, 2, 3], "uint32"),
        "u8": ([255, 0, 7, None, 1, 2, 3], "uint8"),
        "i16": ([-32768, 32767, 0, None, 1, 2, 3], "int16"),
        "date": (
            [datetime.date(2024, 2, 29), datetime.date(1970, 1, 1), datetime.date(1969, 12, 31), datetime.date(1, 1, 1), datetime.date(9999, 12, 31), None, datetime.date(2000, 3, 1)],
            "date32",
        ),
        "ts_us_utc": (
            [datetime.datetime(2024, 5, 6, 7, 8, 9, 123456, tzinfo=utc), datetime.datetime(1969, 12, 31, 23, 59, 59, 999999, tzinfo=utc), datetime.datetime(1970, 1, 1, tzinfo=utc), None, datetime.datetime(2000, 2, 29, 12, 0, 0, 500000, tzinfo=utc), datetime.datetime(1, 1, 1, tzinfo=utc), datetime.datetime(9999, 12, 31, 23, 59, 59, tzinfo=utc)],
            "timestamp_us_utc",
        ),
        "ts_ms": (
            [datetime.datetime(2024, 5, 6, 7, 8, 9, 123000), None, datetime.datetime(1970, 1, 1), datetime.datetime(1969, 12, 31, 23, 59, 59, 999000), datetime.datetime(2000, 1, 1, 0, 0, 0, 7000), datetime.datetime(2038, 1, 19, 3, 14, 8), datetime.datetime(1999, 12, 31, 23, 59, 59)],
            "timestamp_ms",
        ),
        "ts_ns": ([1714979289123456789, -1, 0, None, 1000000001, -1000000000, 951782400000000000], "timestamp_ns"),
        "dec20_4": (
            [Decimal("-123456789012345.6789"), Decimal("0.0001"), Decimal("12"), None, Decimal("-0.0001"), Decimal("0"), Decimal("9999999999999999.9999")],
            "decimal128(20, 4)",
        ),
        "dec9_2": ([Decimal("-1234567.89"), Decimal("0.05"), Decimal("7"), None, Decimal("-0.01"), Decimal("0"), Decimal("9999999.99")], "decimal128(9, 2)"),
        "dec18_3": ([Decimal("-123456789012345.678"), Decimal("0.005"), Decimal("7"), None, Decimal("-0.001"), Decimal("0"), Decimal("999999999999999.999")], "decimal128(18, 3)"),
        "time_us": ([datetime.time(13, 14, 15, 123456), datetime.time(0, 0, 0), datetime.time(23, 59, 59, 999999), None, datetime.time(1, 2, 3), datetime.time(12, 0, 0, 500000), datetime.time(0, 0, 1)], "time64_us"),
        "time_ms": ([datetime.time(1, 2, 3, 4000), datetime.time(0, 0, 0), datetime.time(23, 59, 59, 999000), None, datetime.time(1, 2, 3), datetime.time(12, 0, 0, 500000), datetime.time(0, 0, 1)], "time32_ms"),
        "bin": ([b"\xff\xfe\x00", b"plain", b"", None, b"\xc3\x28", "caf\u00e9".encode("utf-8"), b"\x00"], "binary"),
        "fixed4": ([b"\x00\x01\x02\xff", b"abcd", None, b"\x80\x00\x00\x00", b"\xff\xff\xff\xff", b"\x00\x00\x00\x00", b"\x7f\x7f\x7f\x7f"], "fixed4"),
    }
    expected = {
        "i64": ["9223372036854775807", "-9223372036854775808", "9007199254740993", 9007199254740991, -9007199254740991, 0, None],
        "u64": ["18446744073709551615", "9007199254740993", 9007199254740991, 5, 0, None, 1],
        "u32": [4294967295, 0, 7, None, 1, 2, 3],
        "u8": [255, 0, 7, None, 1, 2, 3],
        "i16": [-32768, 32767, 0, None, 1, 2, 3],
        "date": ["2024-02-29", "1970-01-01", "1969-12-31", "0001-01-01", "9999-12-31", None, "2000-03-01"],
        "ts_us_utc": ["2024-05-06T07:08:09.123456Z", "1969-12-31T23:59:59.999999Z", "1970-01-01T00:00:00Z", None, "2000-02-29T12:00:00.500000Z", "0001-01-01T00:00:00Z", "9999-12-31T23:59:59Z"],
        "ts_ms": ["2024-05-06T07:08:09.123", None, "1970-01-01T00:00:00", "1969-12-31T23:59:59.999", "2000-01-01T00:00:00.007", "2038-01-19T03:14:08", "1999-12-31T23:59:59"],
        "ts_ns": ["2024-05-06T07:08:09.123456789", "1969-12-31T23:59:59.999999999", "1970-01-01T00:00:00", None, "1970-01-01T00:00:01.000000001", "1969-12-31T23:59:59", "2000-02-29T00:00:00"],
        "dec20_4": ["-123456789012345.6789", "0.0001", "12.0000", None, "-0.0001", "0.0000", "9999999999999999.9999"],
        "dec9_2": ["-1234567.89", "0.05", "7.00", None, "-0.01", "0.00", "9999999.99"],
        "dec18_3": ["-123456789012345.678", "0.005", "7.000", None, "-0.001", "0.000", "999999999999999.999"],
        "time_us": ["13:14:15.123456", "00:00:00", "23:59:59.999999", None, "01:02:03", "12:00:00.500000", "00:00:01"],
        "time_ms": ["01:02:03.004", "00:00:00", "23:59:59.999", None, "01:02:03", "12:00:00.500", "00:00:01"],
        "bin": [base64.b64encode(b"\xff\xfe\x00").decode(), "plain", "", None, base64.b64encode(b"\xc3\x28").decode(), "caf\u00e9", "\u0000"],
        "fixed4": [base64.b64encode(b"\x00\x01\x02\xff").decode(), "abcd", None, base64.b64encode(b"\x80\x00\x00\x00").decode(), base64.b64encode(b"\xff\xff\xff\xff").decode(), "\u0000\u0000\u0000\u0000", "\u007f\u007f\u007f\u007f"],
    }
    return arrays, expected


def build_logical_table():
    pa = require("pyarrow")
    arrays, expected = logical_fixture()
    types = {
        "int64": pa.int64(),
        "uint64": pa.uint64(),
        "uint32": pa.uint32(),
        "uint8": pa.uint8(),
        "int16": pa.int16(),
        "date32": pa.date32(),
        "timestamp_us_utc": pa.timestamp("us", tz="UTC"),
        "timestamp_ms": pa.timestamp("ms"),
        "timestamp_ns": pa.timestamp("ns"),
        "decimal128(20, 4)": pa.decimal128(20, 4),
        "decimal128(9, 2)": pa.decimal128(9, 2),
        "decimal128(18, 3)": pa.decimal128(18, 3),
        "time64_us": pa.time64("us"),
        "time32_ms": pa.time32("ms"),
        "binary": pa.binary(),
        "fixed4": pa.binary(4),
    }
    columns = {}
    for name, (values, kind) in arrays.items():
        columns[name] = pa.array(values, type=types[kind])
    return pa.table(columns), expected


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
    logical, logical_expected = build_logical_table()
    pq.write_table(logical, os.path.join(out_dir, "logical-types.parquet"), compression="snappy")
    pq.write_table(logical, os.path.join(out_dir, "logical-types-plain.parquet"), compression="none", use_dictionary=False)
    with open(os.path.join(out_dir, "logical-expected.json"), "w", encoding="utf-8") as fh:
        json.dump(logical_expected, fh)
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
