import zlib from 'zlib';
import { decompressZstd } from './zstd';

/**
 * Pure TypeScript Apache Parquet Columnar Storage Engine
 *
 * Implements:
 * - Parquet file structure: 4-byte 'PAR1' header & footer
 * - Columnar decomposition of tabular data (JSON / CSV / TSV / YAML records)
 * - PLAIN columnar encoding for BYTE_ARRAY (UTF-8 strings), DOUBLE, INT64, INT32, FLOAT, and BOOLEAN
 * - Thrift Compact Protocol FileMetaData serialization and deserialization
 * - Complete round-trip columnar serialization & deserialization with fail-closed validation
 */

export const PARQUET_MAGIC = 'PAR1';

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

export enum ConvertedType {
  UTF8 = 0,
}

export enum CompressionCodec {
  UNCOMPRESSED = 0,
  SNAPPY = 1,
  GZIP = 2,
  LZO = 3,
  BROTLI = 4,
  LZ4 = 5,
  ZSTD = 6,
}

export enum PageType {
  DATA_PAGE = 0,
  INDEX_PAGE = 1,
  DICTIONARY_PAGE = 2,
  DATA_PAGE_V2 = 3,
}

export enum Encoding {
  PLAIN = 0,
  PLAIN_DICTIONARY = 2,
  RLE = 3,
}

// ==========================================
// Thrift Compact Protocol Engine
// ==========================================

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

export class CompactProtocolReader {
  public offset = 0;
  private lastFieldIdStack: number[] = [0];

  constructor(public buf: Buffer, startOffset = 0) {
    this.offset = startOffset;
  }

  readByte(): number {
    if (this.offset >= this.buf.length) {
      throw new Error(`Truncated Thrift payload: unexpected EOF at offset ${this.offset}`);
    }
    return this.buf[this.offset++];
  }

  readVarint(): bigint {
    let result = 0n;
    let shift = 0n;
    while (true) {
      if (this.offset >= this.buf.length) {
        throw new Error(`Truncated Thrift payload: unexpected EOF reading varint at offset ${this.offset}`);
      }
      const b = this.buf[this.offset++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7n;
    }
    return result;
  }

  readZigzag32(): number {
    const n = Number(this.readVarint());
    return (n >>> 1) ^ -(n & 1);
  }

  readZigzag64(): bigint {
    const n = this.readVarint();
    return (n >> 1n) ^ -(n & 1n);
  }

  readString(): string {
    const len = Number(this.readVarint());
    if (this.offset + len > this.buf.length) {
      throw new Error(`Truncated Thrift payload: string length ${len} exceeds buffer boundary`);
    }
    const str = this.buf.toString('utf-8', this.offset, this.offset + len);
    this.offset += len;
    return str;
  }

  readBinary(): Buffer {
    const len = Number(this.readVarint());
    if (this.offset + len > this.buf.length) {
      throw new Error(`Truncated Thrift payload: binary length ${len} exceeds buffer boundary`);
    }
    const res = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    return res;
  }

  readFieldBegin(): { fieldId: number; type: number; isStop: boolean } {
    if (this.offset >= this.buf.length) {
      return { fieldId: 0, type: 0, isStop: true };
    }
    const b = this.buf[this.offset++];
    if (b === 0) {
      return { fieldId: 0, type: 0, isStop: true };
    }
    const type = b & 0x0f;
    const modifier = (b >> 4) & 0x0f;
    let fieldId = 0;
    const lastId = this.lastFieldIdStack[this.lastFieldIdStack.length - 1];
    if (modifier === 0) {
      fieldId = this.readZigzag32();
    } else {
      fieldId = lastId + modifier;
    }
    this.lastFieldIdStack[this.lastFieldIdStack.length - 1] = fieldId;
    return { fieldId, type, isStop: false };
  }

  structBegin() {
    this.lastFieldIdStack.push(0);
  }

  structEnd() {
    this.lastFieldIdStack.pop();
  }

  readListBegin(): { elemType: number; size: number } {
    if (this.offset >= this.buf.length) {
      throw new Error(`Truncated Thrift payload: unexpected EOF reading list header`);
    }
    const b = this.buf[this.offset++];
    const sizeHigh = (b >> 4) & 0x0f;
    const elemType = b & 0x0f;
    let size = sizeHigh;
    if (sizeHigh === 0x0f) {
      size = Number(this.readVarint());
    }
    return { elemType, size };
  }

  skip(type: number) {
    if (type === 1 || type === 2) {
      return;
    } else if (type === 3) {
      this.offset += 1;
    } else if (type === 4 || type === 5 || type === 6) {
      this.readVarint();
    } else if (type === 7) {
      this.offset += 8;
    } else if (type === 8) {
      const len = Number(this.readVarint());
      this.offset += len;
    } else if (type === 9 || type === 10) {
      const { elemType, size } = this.readListBegin();
      for (let i = 0; i < size; i++) this.skip(elemType);
    } else if (type === 11) {
      const size = Number(this.readVarint());
      if (size > 0) {
        const header = this.buf[this.offset++];
        const ktype = (header >> 4) & 0x0f;
        const vtype = header & 0x0f;
        for (let i = 0; i < size; i++) {
          this.skip(ktype);
          this.skip(vtype);
        }
      }
    } else if (type === 12) {
      this.structBegin();
      while (true) {
        const f = this.readFieldBegin();
        if (f.isStop) break;
        this.skip(f.type);
      }
      this.structEnd();
    } else {
      throw new Error(`Corrupted Thrift payload: unsupported type ${type} at offset ${this.offset}`);
    }
  }
}

// ==========================================
// Parquet Schema and Column Data Engine
// ==========================================

export interface ColumnSchema {
  name: string;
  type: ParquetType;
  convertedType?: ConvertedType;
  repetitionType: FieldRepetitionType;
}

export interface EncodedColumnData {
  schema: ColumnSchema;
  numValues: number;
  dataPageOffset: number;
  uncompressedSize: number;
  compressedSize: number;
  buffer: Buffer;
}

/**
 * Infer column schema from a collection of records
 */
export function inferColumnSchemas(records: Record<string, unknown>[]): ColumnSchema[] {
  if (records.length === 0) return [];

  const colNames = Array.from(new Set(records.flatMap((r) => Object.keys(r))));
  return colNames.map((name) => {
    let hasString = false;
    let hasFloat = false;
    let hasInt = false;
    let hasBool = false;

    for (const r of records) {
      const val = r[name];
      if (val === null || val === undefined || val === '') continue;
      if (typeof val === 'boolean') {
        hasBool = true;
      } else if (typeof val === 'number') {
        if (Number.isInteger(val)) {
          hasInt = true;
        } else {
          hasFloat = true;
        }
      } else {
        hasString = true;
      }
    }

    if (hasString) {
      return {
        name,
        type: ParquetType.BYTE_ARRAY,
        convertedType: ConvertedType.UTF8,
        repetitionType: FieldRepetitionType.OPTIONAL,
      };
    } else if (hasFloat) {
      return {
        name,
        type: ParquetType.DOUBLE,
        repetitionType: FieldRepetitionType.OPTIONAL,
      };
    } else if (hasInt) {
      return {
        name,
        type: ParquetType.INT64,
        repetitionType: FieldRepetitionType.OPTIONAL,
      };
    } else if (hasBool) {
      return {
        name,
        type: ParquetType.BOOLEAN,
        repetitionType: FieldRepetitionType.OPTIONAL,
      };
    }

    // Default to string
    return {
      name,
      type: ParquetType.BYTE_ARRAY,
      convertedType: ConvertedType.UTF8,
      repetitionType: FieldRepetitionType.OPTIONAL,
    };
  });
}

/**
 * Serializes an array of row objects into a standard Apache Parquet columnar file buffer.
 */
export function encodeParquet(records: Record<string, unknown>[]): Buffer {
  const schemas = inferColumnSchemas(records);
  const numRows = records.length;

  // 1. Columnar Encoding (PLAIN)
  const encodedColumns: EncodedColumnData[] = [];
  let currentFileOffset = 4; // Skip 'PAR1' header

  for (const schema of schemas) {
    const colName = schema.name;
    const pageDataChunks: Buffer[] = [];

    if (schema.type === ParquetType.BOOLEAN) {
      // Standard Parquet PLAIN encoding for BOOLEAN: 1 bit per value, packed LSB-first
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
        } else if (schema.type === ParquetType.FLOAT) {
          const numVal = typeof rawVal === 'number' ? rawVal : Number(rawVal) || 0.0;
          const numBuf = Buffer.alloc(4);
          numBuf.writeFloatLE(numVal, 0);
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

    // Build PageHeader using Thrift Compact Protocol
    const pageHeaderWriter = new CompactProtocolWriter();
    pageHeaderWriter.writeStructBegin();
    // 1: type = DATA_PAGE (0)
    pageHeaderWriter.writeFieldBegin(1, 5); // I32
    pageHeaderWriter.writeI32(PageType.DATA_PAGE);
    // 2: uncompressed_page_size
    pageHeaderWriter.writeFieldBegin(2, 5); // I32
    pageHeaderWriter.writeI32(pageDataBuffer.length);
    // 3: compressed_page_size
    pageHeaderWriter.writeFieldBegin(3, 5); // I32
    pageHeaderWriter.writeI32(pageDataBuffer.length);
    // 5: data_page_header
    pageHeaderWriter.writeFieldBegin(5, 12); // Struct
    pageHeaderWriter.writeStructBegin();
    //   1: num_values
    pageHeaderWriter.writeFieldBegin(1, 5);
    pageHeaderWriter.writeI32(numRows);
    //   2: encoding = PLAIN (0)
    pageHeaderWriter.writeFieldBegin(2, 5);
    pageHeaderWriter.writeI32(Encoding.PLAIN);
    //   3: definition_level_encoding = PLAIN (0)
    pageHeaderWriter.writeFieldBegin(3, 5);
    pageHeaderWriter.writeI32(Encoding.PLAIN);
    //   4: repetition_level_encoding = PLAIN (0)
    pageHeaderWriter.writeFieldBegin(4, 5);
    pageHeaderWriter.writeI32(Encoding.PLAIN);
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

  // 2. Build FileMetaData (Thrift Compact Protocol)
  const metaWriter = new CompactProtocolWriter();
  metaWriter.writeStructBegin();

  // 1: version = 1
  metaWriter.writeFieldBegin(1, 5);
  metaWriter.writeI32(1);

  // 2: schema (list<SchemaElement>)
  metaWriter.writeFieldBegin(2, 9); // List
  const totalSchemaElements = 1 + schemas.length;
  metaWriter.writeListBegin(12, totalSchemaElements); // List of structs

  // Root SchemaElement
  metaWriter.writeStructBegin();
  metaWriter.writeFieldBegin(4, 8); // Binary/string: name
  metaWriter.writeString('root');
  metaWriter.writeFieldBegin(5, 5); // I32: num_children
  metaWriter.writeI32(schemas.length);
  metaWriter.writeFieldStop();
  metaWriter.writeStructEnd();

  // Column SchemaElements
  for (const s of schemas) {
    metaWriter.writeStructBegin();
    metaWriter.writeFieldBegin(1, 5); // Type
    metaWriter.writeI32(s.type);
    metaWriter.writeFieldBegin(3, 5); // RepetitionType
    metaWriter.writeI32(s.repetitionType);
    metaWriter.writeFieldBegin(4, 8); // Name
    metaWriter.writeString(s.name);
    if (s.convertedType !== undefined) {
      metaWriter.writeFieldBegin(6, 5); // ConvertedType
      metaWriter.writeI32(s.convertedType);
    }
    metaWriter.writeFieldStop();
    metaWriter.writeStructEnd();
  }

  // 3: num_rows
  metaWriter.writeFieldBegin(3, 6); // I64
  metaWriter.writeI64(BigInt(numRows));

  // 4: row_groups (list<RowGroup>)
  metaWriter.writeFieldBegin(4, 9);
  metaWriter.writeListBegin(12, 1); // 1 row group

  metaWriter.writeStructBegin();
  // 1: columns (list<ColumnChunk>)
  metaWriter.writeFieldBegin(1, 9);
  metaWriter.writeListBegin(12, encodedColumns.length);

  for (const col of encodedColumns) {
    metaWriter.writeStructBegin();
    // 2: file_offset
    metaWriter.writeFieldBegin(2, 6);
    metaWriter.writeI64(BigInt(col.dataPageOffset));
    // 3: meta_data (ColumnMetaData struct)
    metaWriter.writeFieldBegin(3, 12);
    metaWriter.writeStructBegin();
    //   1: type
    metaWriter.writeFieldBegin(1, 5);
    metaWriter.writeI32(col.schema.type);
    //   2: encodings (list<Encoding>)
    metaWriter.writeFieldBegin(2, 9);
    metaWriter.writeListBegin(5, 1);
    metaWriter.writeI32(Encoding.PLAIN);
    //   3: path_in_schema (list<string>)
    metaWriter.writeFieldBegin(3, 9);
    metaWriter.writeListBegin(8, 1);
    metaWriter.writeString(col.schema.name);
    //   4: codec (UNCOMPRESSED = 0)
    metaWriter.writeFieldBegin(4, 5);
    metaWriter.writeI32(CompressionCodec.UNCOMPRESSED);
    //   5: num_values
    metaWriter.writeFieldBegin(5, 6);
    metaWriter.writeI64(BigInt(col.numValues));
    //   6: total_uncompressed_size
    metaWriter.writeFieldBegin(6, 6);
    metaWriter.writeI64(BigInt(col.uncompressedSize));
    //   7: total_compressed_size
    metaWriter.writeFieldBegin(7, 6);
    metaWriter.writeI64(BigInt(col.compressedSize));
    //   9: data_page_offset
    metaWriter.writeFieldBegin(9, 6);
    metaWriter.writeI64(BigInt(col.dataPageOffset));

    metaWriter.writeFieldStop();
    metaWriter.writeStructEnd(); // ColumnMetaData end

    metaWriter.writeFieldStop();
    metaWriter.writeStructEnd(); // ColumnChunk end
  }

  // 2: total_byte_size
  const totalByteSize = encodedColumns.reduce((sum, c) => sum + c.uncompressedSize, 0);
  metaWriter.writeFieldBegin(2, 6);
  metaWriter.writeI64(BigInt(totalByteSize));

  // 3: num_rows
  metaWriter.writeFieldBegin(3, 6);
  metaWriter.writeI64(BigInt(numRows));

  metaWriter.writeFieldStop();
  metaWriter.writeStructEnd(); // RowGroup end

  // 6: created_by
  metaWriter.writeFieldBegin(6, 8);
  metaWriter.writeString('easyconvert');

  metaWriter.writeFieldStop();
  metaWriter.writeStructEnd(); // FileMetaData end

  const fileMetaDataBuf = metaWriter.toBuffer();

  // 3. Assemble Output: 'PAR1' + Column Chunks + FileMetaData + Metadata Length + 'PAR1'
  const headerBuf = Buffer.from(PARQUET_MAGIC, 'ascii');
  const footerLenBuf = Buffer.alloc(4);
  footerLenBuf.writeUInt32LE(fileMetaDataBuf.length, 0);
  const footerBuf = Buffer.from(PARQUET_MAGIC, 'ascii');

  return Buffer.concat([
    headerBuf,
    ...encodedColumns.map((c) => c.buffer),
    fileMetaDataBuf,
    footerLenBuf,
    footerBuf,
  ]);
}

/**
 * Deserializes an Apache Parquet columnar file buffer into an array of row records.
 */
export function decodeParquet(buffer: Buffer): Record<string, unknown>[] {
  if (buffer.length < 12) {
    throw new Error('Invalid Parquet file: buffer too small (minimum 12 bytes).');
  }

  const magicHeader = buffer.toString('ascii', 0, 4);
  const magicFooter = buffer.toString('ascii', buffer.length - 4, buffer.length);

  if (magicHeader !== PARQUET_MAGIC || magicFooter !== PARQUET_MAGIC) {
    throw new Error(
      `Invalid Parquet file: magic header='${magicHeader}', magic footer='${magicFooter}' (expected 'PAR1').`
    );
  }

  // 1. Read footer metadata length
  const metaLength = buffer.readUInt32LE(buffer.length - 8);
  if (metaLength <= 0 || metaLength > buffer.length - 8) {
    throw new Error(`Corrupted Parquet metadata: invalid footer length ${metaLength}.`);
  }

  const metaOffset = buffer.length - 8 - metaLength;
  const reader = new CompactProtocolReader(buffer, metaOffset);

  // 2. Parse FileMetaData
  reader.structBegin();
  let version = 1;
  let schemaList: { name: string; type?: ParquetType }[] = [];
  let numRows = 0;
  let columnChunks: {
    name: string;
    type: ParquetType;
    codec: CompressionCodec;
    offset: number;
    numValues: number;
    totalSize: number;
  }[] = [];

  while (true) {
    const f = reader.readFieldBegin();
    if (f.isStop) break;

    if (f.fieldId === 1) {
      version = reader.readZigzag32();
    } else if (f.fieldId === 2) {
      // Schema
      const { size } = reader.readListBegin();
      schemaList = [];
      for (let i = 0; i < size; i++) {
        reader.structBegin();
        let colType: ParquetType | undefined;
        let colName = '';
        while (true) {
          const sf = reader.readFieldBegin();
          if (sf.isStop) break;
          if (sf.fieldId === 1) {
            colType = reader.readZigzag32() as ParquetType;
          } else if (sf.fieldId === 4) {
            colName = reader.readString();
          } else {
            reader.skip(sf.type);
          }
        }
        reader.structEnd();
        schemaList.push({ name: colName, type: colType });
      }
    } else if (f.fieldId === 3) {
      numRows = Number(reader.readZigzag64());
    } else if (f.fieldId === 4) {
      // Row groups
      const { size: rgSize } = reader.readListBegin();
      for (let rg = 0; rg < rgSize; rg++) {
        reader.structBegin();
        while (true) {
          const rgf = reader.readFieldBegin();
          if (rgf.isStop) break;

          if (rgf.fieldId === 1) {
            // columns list<ColumnChunk>
            const { size: colListSize } = reader.readListBegin();
            for (let c = 0; c < colListSize; c++) {
              reader.structBegin();
              let fileOffset = 0;
              let colMetaType = ParquetType.BYTE_ARRAY;
              let colMetaPath = '';
              let colNumValues = 0;
              let colTotalSize = 0;
              let dataPageOffset = 0;
              let colCodec = CompressionCodec.UNCOMPRESSED;

              while (true) {
                const ccf = reader.readFieldBegin();
                if (ccf.isStop) break;

                if (ccf.fieldId === 2) {
                  fileOffset = Number(reader.readZigzag64());
                } else if (ccf.fieldId === 3) {
                  // meta_data
                  reader.structBegin();
                  while (true) {
                    const mf = reader.readFieldBegin();
                    if (mf.isStop) break;
                    if (mf.fieldId === 1) {
                      colMetaType = reader.readZigzag32() as ParquetType;
                    } else if (mf.fieldId === 3) {
                      // path_in_schema list<string>
                      const { size: pSize } = reader.readListBegin();
                      for (let p = 0; p < pSize; p++) {
                        const pathPart = reader.readString();
                        if (!colMetaPath) colMetaPath = pathPart;
                      }
                    } else if (mf.fieldId === 4) {
                      colCodec = reader.readZigzag32() as CompressionCodec;
                    } else if (mf.fieldId === 5) {
                      colNumValues = Number(reader.readZigzag64());
                    } else if (mf.fieldId === 6) {
                      colTotalSize = Number(reader.readZigzag64());
                    } else if (mf.fieldId === 9) {
                      dataPageOffset = Number(reader.readZigzag64());
                    } else {
                      reader.skip(mf.type);
                    }
                  }
                  reader.structEnd();
                } else {
                  reader.skip(ccf.type);
                }
              }
              reader.structEnd(); // ColumnChunk end

              columnChunks.push({
                name: colMetaPath,
                type: colMetaType,
                codec: colCodec,
                offset: dataPageOffset || fileOffset,
                numValues: colNumValues || numRows,
                totalSize: colTotalSize,
              });
            }
          } else {
            reader.skip(rgf.type);
          }
        }
        reader.structEnd(); // RowGroup end
      }
    } else {
      reader.skip(f.type);
    }
  }
  reader.structEnd();

  if (numRows === 0) {
    return [];
  }

  // 3. Decode Column Values
  const columnDataMap: Record<string, unknown[]> = {};

  for (const chunk of columnChunks) {
    const colName = chunk.name;
    const pageOffset = chunk.offset;
    if (pageOffset <= 0 || pageOffset >= buffer.length) continue;

    // Read PageHeader
    const pageReader = new CompactProtocolReader(buffer, pageOffset);
    pageReader.structBegin();
    let uncompressedPageSize = 0;
    let compressedPageSize = 0;
    let pageNumValues = chunk.numValues;

    while (true) {
      const pf = pageReader.readFieldBegin();
      if (pf.isStop) break;
      if (pf.fieldId === 2) {
        uncompressedPageSize = pageReader.readZigzag32();
      } else if (pf.fieldId === 3) {
        compressedPageSize = pageReader.readZigzag32();
      } else if (pf.fieldId === 5) {
        // data_page_header
        pageReader.structBegin();
        while (true) {
          const dpf = pageReader.readFieldBegin();
          if (dpf.isStop) break;
          if (dpf.fieldId === 1) {
            pageNumValues = pageReader.readZigzag32();
          } else {
            pageReader.skip(dpf.type);
          }
        }
        pageReader.structEnd();
      } else {
        pageReader.skip(pf.type);
      }
    }
    pageReader.structEnd();

    // Data starts at pageReader.offset
    const pageSliceSize = compressedPageSize > 0 ? compressedPageSize : uncompressedPageSize;
    const rawPageSlice = pageSliceSize > 0
      ? buffer.subarray(pageReader.offset, pageReader.offset + pageSliceSize)
      : buffer.subarray(pageReader.offset);

    let pageBuffer: Buffer;
    if (chunk.codec === CompressionCodec.UNCOMPRESSED) {
      pageBuffer = rawPageSlice;
    } else if (chunk.codec === CompressionCodec.GZIP) {
      try {
        pageBuffer = zlib.gunzipSync(rawPageSlice);
      } catch {
        pageBuffer = zlib.inflateRawSync(rawPageSlice);
      }
    } else if (chunk.codec === CompressionCodec.ZSTD) {
      pageBuffer = decompressZstd(rawPageSlice);
    } else {
      const codecName = CompressionCodec[chunk.codec] ?? String(chunk.codec);
      throw new Error(
        `Unsupported Parquet compression codec: ${codecName}. Supported codecs: UNCOMPRESSED, GZIP, ZSTD.`
      );
    }

    let dataOffset = 0;
    const values: unknown[] = [];

    if (chunk.type === ParquetType.BOOLEAN) {
      // Support both bit-packed (1 bit per value LSB-first) and loose 1-byte booleans
      const remainingBytes = pageBuffer.length - dataOffset;
      const isBitPacked = remainingBytes < pageNumValues || remainingBytes === Math.ceil(pageNumValues / 8);
      if (isBitPacked) {
        for (let i = 0; i < pageNumValues; i++) {
          const byteIdx = dataOffset + Math.floor(i / 8);
          if (byteIdx >= pageBuffer.length) {
            throw new Error(`Corrupted Parquet file: truncated boolean data in column '${colName}'`);
          }
          const bit = (pageBuffer[byteIdx] >> (i % 8)) & 1;
          values.push(bit === 1);
        }
        dataOffset += Math.ceil(pageNumValues / 8);
      } else {
        for (let i = 0; i < pageNumValues; i++) {
          if (dataOffset >= pageBuffer.length) {
            throw new Error(`Corrupted Parquet file: truncated boolean data in column '${colName}'`);
          }
          values.push(pageBuffer[dataOffset++] !== 0);
        }
      }
    } else {
      for (let i = 0; i < pageNumValues; i++) {
        if (chunk.type === ParquetType.BYTE_ARRAY) {
          if (dataOffset + 4 > pageBuffer.length) {
            throw new Error(`Corrupted Parquet file: truncated string length in column '${colName}'`);
          }
          const strLen = pageBuffer.readUInt32LE(dataOffset);
          dataOffset += 4;
          if (dataOffset + strLen > pageBuffer.length) {
            throw new Error(
              `Corrupted Parquet file: string length ${strLen} exceeds page bounds in column '${colName}'`
            );
          }
          const str = pageBuffer.toString('utf-8', dataOffset, dataOffset + strLen);
          dataOffset += strLen;
          values.push(str);
        } else if (chunk.type === ParquetType.DOUBLE) {
          if (dataOffset + 8 > pageBuffer.length) {
            throw new Error(`Corrupted Parquet file: truncated double value in column '${colName}'`);
          }
          values.push(pageBuffer.readDoubleLE(dataOffset));
          dataOffset += 8;
        } else if (chunk.type === ParquetType.FLOAT) {
          if (dataOffset + 4 > pageBuffer.length) {
            throw new Error(`Corrupted Parquet file: truncated float value in column '${colName}'`);
          }
          values.push(pageBuffer.readFloatLE(dataOffset));
          dataOffset += 4;
        } else if (chunk.type === ParquetType.INT64) {
          if (dataOffset + 8 > pageBuffer.length) {
            throw new Error(`Corrupted Parquet file: truncated int64 value in column '${colName}'`);
          }
          values.push(Number(pageBuffer.readBigInt64LE(dataOffset)));
          dataOffset += 8;
        } else if (chunk.type === ParquetType.INT32) {
          if (dataOffset + 4 > pageBuffer.length) {
            throw new Error(`Corrupted Parquet file: truncated int32 value in column '${colName}'`);
          }
          values.push(pageBuffer.readInt32LE(dataOffset));
          dataOffset += 4;
        } else {
          values.push(null);
        }
      }
    }

    columnDataMap[colName] = values;
  }

  // 4. Reassemble rows
  const colNames = Object.keys(columnDataMap);
  const records: Record<string, unknown>[] = [];

  for (let r = 0; r < numRows; r++) {
    const row: Record<string, unknown> = {};
    for (const name of colNames) {
      row[name] = columnDataMap[name]?.[r] ?? null;
    }
    records.push(row);
  }

  return records;
}
