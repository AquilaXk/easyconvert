"""Independent Parquet oracle: reads and writes Parquet with the reference Arrow implementation.

Run as `python3 -I parquet_oracle.py <command> ...`. Exit code 3 with `MODULE_MISSING <name>` on stderr
means a required module is not installed (the TypeScript wrapper turns that into an explicit skip).

Commands (JSON on stdout):
  read <file>                              pyarrow read: schema, row-group metadata, statistics, every value
  duckdb <file>                            DuckDB read: column names, types, every value
  write <rows.json> <schema.json> <out> <codec>   reference writer used for size comparison
  snappy-compress <in> <out>               raw snappy block
  snappy-decompress <in> <out> <size>      raw snappy block

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


def command_snappy_compress(in_path, out_path):
    pa = require("pyarrow")
    with open(in_path, "rb") as fh:
        raw = fh.read()
    packed = pa.compress(raw, codec="snappy", asbytes=True)
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


COMMANDS = {
    "read": command_read,
    "duckdb": command_duckdb,
    "write": command_write,
    "snappy-compress": command_snappy_compress,
    "snappy-decompress": command_snappy_decompress,
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        sys.stderr.write("usage: parquet_oracle.py <%s> ...\n" % "|".join(COMMANDS))
        sys.exit(2)
    COMMANDS[sys.argv[1]](*sys.argv[2:])
