"""Nested Parquet fixtures and their expected values, from the reference Arrow implementation.

Run as `python3 -I parquet_nested_oracle.py <command> ...` with pyarrow 26 installed.

  make <dir>                      write the synthetic nested files (closed-form rows, no random data)
  expect <dir> <out.json> <name>  read every named file in <dir> with pyarrow and write its rows as JSON

`expect` writes the rows in the shape the converter writes for json: a list is an array, a struct an object, and a map
an object when its keys are strings, otherwise an array of {key, value}. It also writes, per column, how a table target
cuts the column into cells ("shapes"). Nothing is read from this repository.
"""

import datetime
import json
import os
import sys

import pyarrow as pa
import pyarrow.parquet as pq

ROWS = 60


def element_struct():
    return pa.struct([("sku", pa.string()), ("qty", pa.int32()), ("tags", pa.list_(pa.string()))])


def build_table():
    ids = list(range(ROWS))

    def items(i):
        if i % 11 == 0:
            return None
        if i % 7 == 0:
            return []
        out = []
        for j in range(i % 4 + 1):
            if (i + j) % 9 == 0:
                out.append(None)
                continue
            tags = None if (i + j) % 5 == 0 else ([] if (i + j) % 5 == 1 else [None if k == 1 and j == 0 else "t%d_%d_%d" % (i, j, k) for k in range((i + j) % 3 + 1)])
            out.append({"sku": None if (i * j) % 8 == 3 else "sku-%d-%d" % (i, j), "qty": None if (i + j) % 6 == 2 else i * 10 + j, "tags": tags})
        return out

    def attrs(i):
        if i % 10 == 0:
            return None
        if i % 10 == 1:
            return []
        out = []
        for j in range(i % 3 + 1):
            value = None if (i + j) % 4 == 0 else ([] if (i + j) % 4 == 1 else [None if (k + i) % 5 == 0 else i + j + k for k in range((i + j) % 4)])
            out.append(("k%d" % j, value))
        return out

    def point(i):
        if i % 8 == 0:
            return None
        inner = None if i % 5 == 0 else {"a": None if i % 3 == 0 else i, "b": None if i % 4 == 0 else [i, None, i + 1][: i % 4]}
        return {"x": None if i % 6 == 0 else i / 4.0, "inner": inner}

    def grid(i):
        if i % 13 == 0:
            return None
        return [None if (i + r) % 4 == 0 else [] if (i + r) % 4 == 1 else [float(i * r + c) / 2 for c in range((i + r) % 3 + 1)] for r in range(i % 4)]

    def imap(i):
        if i % 6 == 0:
            return None
        return [(i * 100 + j, None if j == 1 else "v%d_%d" % (i, j)) for j in range(i % 3)]

    def maplist(i):
        return [[("m%d" % j, None if j == 2 else i + j)] if (i + j) % 3 else [] for j in range(i % 3)]

    return pa.table(
        {
            "id": pa.array(ids, pa.int64()),
            "items": pa.array([items(i) for i in ids], pa.list_(element_struct())),
            "attrs": pa.array([attrs(i) for i in ids], pa.map_(pa.string(), pa.list_(pa.int32()))),
            "point": pa.array(
                [point(i) for i in ids],
                pa.struct([("x", pa.float64()), ("inner", pa.struct([("a", pa.int64()), ("b", pa.list_(pa.int32()))]))]),
            ),
            "grid": pa.array([grid(i) for i in ids], pa.list_(pa.list_(pa.float64()))),
            "imap": pa.array([imap(i) for i in ids], pa.map_(pa.int64(), pa.string())),
            "maplist": pa.array([maplist(i) for i in ids], pa.list_(pa.map_(pa.string(), pa.int32()))),
            "req": pa.array(
                [[i, i + 1][: i % 3] for i in ids],
                pa.list_(pa.field("item", pa.int32(), nullable=False)),
            ),
        },
        schema=pa.schema(
            [
                pa.field("id", pa.int64(), nullable=False),
                pa.field("items", pa.list_(element_struct())),
                pa.field("attrs", pa.map_(pa.string(), pa.list_(pa.int32()))),
                pa.field("point", pa.struct([("x", pa.float64()), ("inner", pa.struct([("a", pa.int64()), ("b", pa.list_(pa.int32()))]))])),
                pa.field("grid", pa.list_(pa.list_(pa.float64()))),
                pa.field("imap", pa.map_(pa.int64(), pa.string())),
                pa.field("maplist", pa.list_(pa.map_(pa.string(), pa.int32()))),
                pa.field("req", pa.list_(pa.field("item", pa.int32(), nullable=False)), nullable=False),
            ]
        ),
    )


def command_make(out):
    os.makedirs(out, exist_ok=True)
    table = build_table()
    pq.write_table(table, out + "/nested-mixed-v1.parquet", compression="SNAPPY", data_page_version="1.0", row_group_size=25, data_page_size=512)
    pq.write_table(table, out + "/nested-mixed-v2.parquet", compression="ZSTD", data_page_version="2.0", use_dictionary=False, row_group_size=60, data_page_size=512)
    pq.write_table(table, out + "/nested-mixed-gzip.parquet", compression="GZIP", data_page_version="1.0", row_group_size=60)


EPOCH = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
UNIT_DIVISOR = {"s": 1, "ms": 1000, "us": 1000000, "ns": 1000000000}


def timestamp_text(value, unit):
    """ISO text of an integer timestamp, or {"$us": "<value in the unit>"} when the year is out of Python's range."""
    seconds, fraction = divmod(value, UNIT_DIVISOR[unit])
    try:
        moment = EPOCH + datetime.timedelta(seconds=seconds)
    except OverflowError:
        return {"$ticks": str(value), "unit": unit}
    text = moment.strftime("%Y-%m-%dT%H:%M:%S")
    if fraction:
        digits = len(str(UNIT_DIVISOR[unit])) - 1
        text += "." + str(fraction).rjust(digits, "0").rstrip("0")
    return text + "Z"


def integer_type(kind):
    """The type with every timestamp read as its integer ticks, so a year Python cannot hold still converts."""
    if pa.types.is_timestamp(kind):
        return pa.int64()
    if pa.types.is_struct(kind):
        return pa.struct([pa.field(kind.field(i).name, integer_type(kind.field(i).type), kind.field(i).nullable) for i in range(kind.num_fields)])
    if pa.types.is_list(kind):
        return pa.list_(pa.field(kind.value_field.name, integer_type(kind.value_type), kind.value_field.nullable))
    if pa.types.is_map(kind):
        return pa.map_(integer_type(kind.key_type), integer_type(kind.item_type))
    return kind


def represent(value, kind):
    if value is None:
        return None
    if pa.types.is_struct(kind):
        return {kind.field(i).name: represent(value[kind.field(i).name], kind.field(i).type) for i in range(kind.num_fields)}
    if pa.types.is_map(kind):
        if pa.types.is_string(kind.key_type) or pa.types.is_large_string(kind.key_type):
            return {k: represent(v, kind.item_type) for k, v in value}
        return [{"key": represent(k, kind.key_type), "value": represent(v, kind.item_type)} for k, v in value]
    if pa.types.is_list(kind) or pa.types.is_large_list(kind):
        return [represent(v, kind.value_type) for v in value]
    if pa.types.is_timestamp(kind):
        return timestamp_text(value, kind.unit)
    if isinstance(value, int) and abs(value) > 2**53 - 1:
        return str(value)
    return value


def table_shape(kind):
    """What a table target does with a value: "map" stays one JSON cell, a struct is {field: shape} (one column per
    field, dotted), anything else ("plain") is a cell of its own (a list as JSON text)."""
    if pa.types.is_map(kind):
        return "map"
    if pa.types.is_struct(kind):
        return {kind.field(i).name: table_shape(kind.field(i).type) for i in range(kind.num_fields)}
    return "plain"


def command_expect(directory, out, names):
    result = {}
    for name in names:
        table = pq.read_table(os.path.join(directory, name + ".parquet"))
        original = table.schema
        table = table.cast(pa.schema([pa.field(f.name, integer_type(f.type), f.nullable) for f in original]))
        rows = table.to_pylist()
        result[name] = {
            "columns": table.column_names,
            "shapes": {field.name: table_shape(field.type) for field in original},
            "rows": [{field.name: represent(row[field.name], field.type) for field in original} for row in rows],
        }
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=1, ensure_ascii=False, allow_nan=False)
        fh.write("\n")


if __name__ == "__main__":
    if sys.argv[1] == "make":
        command_make(sys.argv[2])
    elif sys.argv[1] == "expect":
        command_expect(sys.argv[2], sys.argv[3], sys.argv[4:])
    else:
        sys.exit("unknown command")
