// Independent Synthetic Parquet Encoder for Test Corpus Generation
// Strictly zero dependency on production conversion modules to eliminate circular mocking.

export enum ParquetType {
  BOOLEAN = 0,
  INT32 = 1,
  INT64 = 2,
  INT96 = 3,
  FLOAT = 4,
  DOUBLE = 5,
  BYTE_ARRAY = 6,
  FIXED_LEN_BYTE_ARRAY = 7,
}

export enum FieldRepetitionType {
  REQUIRED = 0,
  OPTIONAL = 1,
  REPEATED = 2,
}

export class CompactProtocolWriter {
  private chunks: Buffer[] = [];
  private lastFieldIdStack: number[] = [0];

  writeFieldBegin(fieldId: number, type: number) {
    const lastId = this.lastFieldIdStack[this.lastFieldIdStack.length - 1];
    const delta = fieldId - lastId;
    if (delta > 0 && delta <= 15) {
      this.chunks.push(Buffer.from([(delta << 4) | type]));
    } else {
      this.chunks.push(Buffer.from([type]));
      this.writeI16(fieldId);
    }
    this.lastFieldIdStack[this.lastFieldIdStack.length - 1] = fieldId;
  }

  writeFieldStop() {
    this.chunks.push(Buffer.from([0]));
  }

  writeStructBegin() {
    this.lastFieldIdStack.push(0);
  }

  writeStructEnd() {
    this.lastFieldIdStack.pop();
  }

  writeVarint(n: number | bigint) {
    let val = typeof n === 'bigint' ? n : BigInt(n);
    const parts: number[] = [];
    while (val >= 0x80n) {
      parts.push(Number(val & 0x7fn) | 0x80);
      val >>= 7n;
    }
    parts.push(Number(val & 0x7fn));
    this.chunks.push(Buffer.from(parts));
  }

  writeZigzag(n: number) {
    const zz = (n << 1) ^ (n >> 31);
    this.writeVarint(zz >>> 0);
  }

  writeZigzag64(n: bigint) {
    const zz = (n << 1n) ^ (n >> 63n);
    this.writeVarint(zz);
  }

  writeI32(n: number) {
    this.writeZigzag(n);
  }

  writeI64(n: bigint | number) {
    this.writeZigzag64(typeof n === 'bigint' ? n : BigInt(n));
  }

  writeI16(n: number) {
    this.writeZigzag(n);
  }

  writeBinary(buf: Buffer) {
    this.writeVarint(buf.length);
    this.chunks.push(buf);
  }

  writeString(str: string) {
    this.writeBinary(Buffer.from(str, 'utf-8'));
  }

  writeListBegin(elemType: number, size: number) {
    if (size < 15) {
      this.chunks.push(Buffer.from([(size << 4) | elemType]));
    } else {
      this.chunks.push(Buffer.from([0xf0 | elemType]));
      this.writeVarint(size);
    }
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

interface InferredSchema {
  name: string;
  type: ParquetType;
  repetitionType: FieldRepetitionType;
}

function inferSchemas(records: Record<string, unknown>[]): InferredSchema[] {
  if (records.length === 0) return [];
  const schemas: InferredSchema[] = [];
  const sample = records[0];

  for (const key of Object.keys(sample)) {
    let inferredType = ParquetType.BYTE_ARRAY;
    for (const r of records) {
      const val = r[key];
      if (val === null || val === undefined) continue;
      if (typeof val === 'boolean') {
        inferredType = ParquetType.BOOLEAN;
        break;
      }
      if (typeof val === 'number') {
        inferredType = Number.isInteger(val) ? ParquetType.INT64 : ParquetType.DOUBLE;
        break;
      }
      if (typeof val === 'bigint') {
        inferredType = ParquetType.INT64;
        break;
      }
    }
    schemas.push({
      name: key,
      type: inferredType,
      repetitionType: FieldRepetitionType.OPTIONAL,
    });
  }
  return schemas;
}

export function encodeSyntheticParquet(records: Record<string, unknown>[]): Buffer {
  const schemas = inferSchemas(records);
  const numRows = records.length;
  const encodedColumns: Array<{
    schema: InferredSchema;
    numValues: number;
    dataPageOffset: number;
    uncompressedSize: number;
    compressedSize: number;
    buffer: Buffer;
  }> = [];

  let currentFileOffset = 4; // Skip 'PAR1'

  for (const schema of schemas) {
    const colName = schema.name;
    const pageDataChunks: Buffer[] = [];

    if (schema.type === ParquetType.BOOLEAN) {
      const byteCount = Math.ceil(numRows / 8);
      const boolBuf = Buffer.alloc(byteCount);
      for (let r = 0; r < numRows; r++) {
        const rawVal = records[r]?.[colName];
        if (Boolean(rawVal)) {
          boolBuf[Math.floor(r / 8)] |= 1 << (r % 8);
        }
      }
      pageDataChunks.push(boolBuf);
    } else {
      for (let r = 0; r < numRows; r++) {
        const rawVal = records[r]?.[colName];
        if (schema.type === ParquetType.BYTE_ARRAY) {
          const strVal = rawVal === null || rawVal === undefined ? '' : String(rawVal);
          const strBytes = Buffer.from(strVal, 'utf-8');
          const lenBuf = Buffer.alloc(4);
          lenBuf.writeUInt32LE(strBytes.length, 0);
          pageDataChunks.push(lenBuf);
          pageDataChunks.push(strBytes);
        } else if (schema.type === ParquetType.DOUBLE) {
          const numVal = typeof rawVal === 'number' ? rawVal : Number(rawVal) || 0.0;
          const numBuf = Buffer.alloc(8);
          numBuf.writeDoubleLE(numVal, 0);
          pageDataChunks.push(numBuf);
        } else if (schema.type === ParquetType.INT64) {
          const intVal = typeof rawVal === 'bigint' ? rawVal : BigInt(Math.trunc(Number(rawVal) || 0));
          const intBuf = Buffer.alloc(8);
          intBuf.writeBigInt64LE(intVal, 0);
          pageDataChunks.push(intBuf);
        } else if (schema.type === ParquetType.INT32) {
          const intVal = Math.trunc(Number(rawVal) || 0);
          const intBuf = Buffer.alloc(4);
          intBuf.writeInt32LE(intVal, 0);
          pageDataChunks.push(intBuf);
        }
      }
    }

    const pageDataBuffer = Buffer.concat(pageDataChunks);

    const pageHeaderWriter = new CompactProtocolWriter();
    pageHeaderWriter.writeStructBegin();
    pageHeaderWriter.writeFieldBegin(1, 5); // I32: type = DATA_PAGE (0)
    pageHeaderWriter.writeI32(0);
    pageHeaderWriter.writeFieldBegin(2, 5); // uncompressed_page_size
    pageHeaderWriter.writeI32(pageDataBuffer.length);
    pageHeaderWriter.writeFieldBegin(3, 5); // compressed_page_size
    pageHeaderWriter.writeI32(pageDataBuffer.length);
    pageHeaderWriter.writeFieldBegin(5, 12); // data_page_header
    pageHeaderWriter.writeStructBegin();
    pageHeaderWriter.writeFieldBegin(1, 5); // num_values
    pageHeaderWriter.writeI32(numRows);
    pageHeaderWriter.writeFieldBegin(2, 5); // encoding = PLAIN (0)
    pageHeaderWriter.writeI32(0);
    pageHeaderWriter.writeFieldBegin(3, 5); // definition_level_encoding = PLAIN (0)
    pageHeaderWriter.writeI32(0);
    pageHeaderWriter.writeFieldBegin(4, 5); // repetition_level_encoding = PLAIN (0)
    pageHeaderWriter.writeI32(0);
    pageHeaderWriter.writeFieldStop();
    pageHeaderWriter.writeStructEnd();
    pageHeaderWriter.writeFieldStop();
    pageHeaderWriter.writeStructEnd();

    const pageHeaderBuf = pageHeaderWriter.toBuffer();
    const fullChunkBuf = Buffer.concat([pageHeaderBuf, pageDataBuffer]);

    encodedColumns.push({
      schema,
      numValues: numRows,
      dataPageOffset: currentFileOffset,
      uncompressedSize: fullChunkBuf.length,
      compressedSize: fullChunkBuf.length,
      buffer: fullChunkBuf,
    });

    currentFileOffset += fullChunkBuf.length;
  }

  // FileMetaData
  const metaWriter = new CompactProtocolWriter();
  metaWriter.writeStructBegin();
  metaWriter.writeFieldBegin(1, 5); // version = 1
  metaWriter.writeI32(1);

  metaWriter.writeFieldBegin(2, 9); // schema (list<SchemaElement>)
  metaWriter.writeListBegin(12, 1 + schemas.length);

  // Root SchemaElement
  metaWriter.writeStructBegin();
  metaWriter.writeFieldBegin(4, 8); // name = 'root'
  metaWriter.writeString('root');
  metaWriter.writeFieldBegin(5, 5); // num_children
  metaWriter.writeI32(schemas.length);
  metaWriter.writeFieldStop();
  metaWriter.writeStructEnd();

  // Column SchemaElements
  for (const s of schemas) {
    metaWriter.writeStructBegin();
    metaWriter.writeFieldBegin(1, 5); // type
    metaWriter.writeI32(s.type);
    metaWriter.writeFieldBegin(3, 5); // repetition_type
    metaWriter.writeI32(s.repetitionType);
    metaWriter.writeFieldBegin(4, 8); // name
    metaWriter.writeString(s.name);
    metaWriter.writeFieldStop();
    metaWriter.writeStructEnd();
  }

  metaWriter.writeFieldBegin(3, 6); // num_rows
  metaWriter.writeI64(BigInt(numRows));

  metaWriter.writeFieldBegin(4, 9); // row_groups
  metaWriter.writeListBegin(12, 1);

  // RowGroup 0
  metaWriter.writeStructBegin();
  metaWriter.writeFieldBegin(1, 9); // columns (list<ColumnChunk>)
  metaWriter.writeListBegin(12, encodedColumns.length);

  for (const col of encodedColumns) {
    metaWriter.writeStructBegin();
    metaWriter.writeFieldBegin(2, 6); // file_offset
    metaWriter.writeI64(BigInt(col.dataPageOffset));

    metaWriter.writeFieldBegin(3, 12); // meta_data (ColumnMetaData)
    metaWriter.writeStructBegin();
    metaWriter.writeFieldBegin(1, 5); // type
    metaWriter.writeI32(col.schema.type);
    metaWriter.writeFieldBegin(2, 9); // encodings = [PLAIN (0)]
    metaWriter.writeListBegin(5, 1);
    metaWriter.writeI32(0);
    metaWriter.writeFieldBegin(3, 9); // path_in_schema = [col.schema.name]
    metaWriter.writeListBegin(8, 1);
    metaWriter.writeString(col.schema.name);
    metaWriter.writeFieldBegin(4, 5); // codec = UNCOMPRESSED (0)
    metaWriter.writeI32(0);
    metaWriter.writeFieldBegin(5, 6); // num_values
    metaWriter.writeI64(BigInt(col.numValues));
    metaWriter.writeFieldBegin(6, 6); // total_uncompressed_size
    metaWriter.writeI64(BigInt(col.uncompressedSize));
    metaWriter.writeFieldBegin(7, 6); // total_compressed_size
    metaWriter.writeI64(BigInt(col.compressedSize));
    metaWriter.writeFieldBegin(9, 6); // data_page_offset
    metaWriter.writeI64(BigInt(col.dataPageOffset));
    metaWriter.writeFieldStop();
    metaWriter.writeStructEnd();

    metaWriter.writeFieldStop();
    metaWriter.writeStructEnd();
  }

  const totalByteSize = encodedColumns.reduce((sum, c) => sum + c.uncompressedSize, 0);
  metaWriter.writeFieldBegin(2, 6); // total_byte_size
  metaWriter.writeI64(BigInt(totalByteSize));
  metaWriter.writeFieldBegin(3, 6); // num_rows
  metaWriter.writeI64(BigInt(numRows));

  metaWriter.writeFieldStop();
  metaWriter.writeStructEnd(); // End RowGroup

  metaWriter.writeFieldBegin(5, 8); // created_by
  metaWriter.writeString('EasyConvert Independent Synthetic Oracle');
  metaWriter.writeFieldStop();
  metaWriter.writeStructEnd(); // End FileMetaData

  const metaBuffer = metaWriter.toBuffer();
  const metaLengthBuffer = Buffer.alloc(4);
  metaLengthBuffer.writeUInt32LE(metaBuffer.length, 0);

  const par1 = Buffer.from('PAR1', 'ascii');
  const allColumnChunks = Buffer.concat(encodedColumns.map((c) => c.buffer));

  return Buffer.concat([par1, allColumnChunks, metaBuffer, metaLengthBuffer, par1]);
}
