import { ParquetFormatError } from './parquet-format';

/**
 * Thrift Compact Protocol writer and reader for the Parquet footer and page headers.
 * Governing spec: Apache Thrift compact protocol (thrift/doc/specs/thrift-compact-protocol.md).
 */

/** Compact-protocol wire type ids (field/element types). */
export const ThriftType = {
  BOOL_TRUE: 1,
  BOOL_FALSE: 2,
  BYTE: 3,
  I16: 4,
  I32: 5,
  I64: 6,
  DOUBLE: 7,
  BINARY: 8,
  LIST: 9,
  SET: 10,
  MAP: 11,
  STRUCT: 12,
} as const;

/** Maximum nesting of structs/lists the reader skips through (untrusted footers). */
const MAX_THRIFT_SKIP_DEPTH = 32;
const MAX_FIELD_DELTA = 15;
const SHORT_LIST_LIMIT = 15;
/** A 64-bit varint is at most ten bytes of seven payload bits. */
const VARINT_MAX_BYTES = 10;
const VARINT_PAYLOAD_MASK = 0x7f;
const VARINT_PAYLOAD_MASK_BIG = 0x7fn;
const VARINT_CONTINUATION = 0x80;
const VARINT_CONTINUATION_BIG = 0x80n;
const VARINT_PAYLOAD_BITS = 7;
const VARINT_PAYLOAD_BITS_BIG = 7n;
const NIBBLE_BITS = 4;
const NIBBLE_MASK = 0x0f;
/** List header high nibble 0xf means the size follows as a varint; the long form sets that nibble. */
const LIST_LONG_FORM_HEADER = 0xf0;
const INT32_SIGN_SHIFT = 31;
const INT64_SIGN_SHIFT = 63n;
const FIELD_STOP = 0;
/** Bytes a boolean takes as a list element (as a struct field its value rides in the field header). */
const LIST_BOOLEAN_ELEMENT_BYTES = 1;
const DOUBLE_BYTES = 8;

export class CompactProtocolWriter {
  private chunks: Buffer[] = [];
  private lastFieldIdStack: number[] = [0];

  writeFieldBegin(fieldId: number, type: number) {
    const lastId = this.lastFieldIdStack[this.lastFieldIdStack.length - 1];
    const delta = fieldId - lastId;
    if (delta > 0 && delta <= MAX_FIELD_DELTA) {
      this.chunks.push(Buffer.from([(delta << NIBBLE_BITS) | type]));
    } else {
      this.chunks.push(Buffer.from([type]));
      this.writeI16(fieldId);
    }
    this.lastFieldIdStack[this.lastFieldIdStack.length - 1] = fieldId;
  }

  writeFieldStop() {
    this.chunks.push(Buffer.from([FIELD_STOP]));
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
    while (val >= VARINT_CONTINUATION_BIG) {
      parts.push(Number(val & VARINT_PAYLOAD_MASK_BIG) | VARINT_CONTINUATION);
      val >>= VARINT_PAYLOAD_BITS_BIG;
    }
    parts.push(Number(val & VARINT_PAYLOAD_MASK_BIG));
    this.chunks.push(Buffer.from(parts));
  }

  writeZigzag(n: number) {
    const zz = (n << 1) ^ (n >> INT32_SIGN_SHIFT);
    this.writeVarint(zz >>> 0);
  }

  writeZigzag64(n: bigint) {
    const zz = (n << 1n) ^ (n >> INT64_SIGN_SHIFT);
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

  writeBinary(buf: Uint8Array) {
    this.writeVarint(buf.length);
    this.chunks.push(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength));
  }

  writeString(str: string) {
    this.writeBinary(Buffer.from(str, 'utf-8'));
  }

  writeListBegin(elemType: number, size: number) {
    if (size < SHORT_LIST_LIMIT) {
      this.chunks.push(Buffer.from([(size << NIBBLE_BITS) | elemType]));
    } else {
      this.chunks.push(Buffer.from([LIST_LONG_FORM_HEADER | elemType]));
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
      throw new ParquetFormatError(`Truncated Thrift payload: unexpected EOF at offset ${this.offset}`);
    }
    return this.buf[this.offset++];
  }

  readVarint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let byteCount = 0; byteCount < VARINT_MAX_BYTES; byteCount++) {
      if (this.offset >= this.buf.length) {
        throw new ParquetFormatError(`Truncated Thrift payload: unexpected EOF reading varint at offset ${this.offset}`);
      }
      const b = this.buf[this.offset++];
      result |= BigInt(b & VARINT_PAYLOAD_MASK) << shift;
      if ((b & VARINT_CONTINUATION) === 0) return result;
      shift += VARINT_PAYLOAD_BITS_BIG;
    }
    throw new ParquetFormatError(
      `Corrupted Thrift payload: varint exceeds 10 bytes / 64-bit limit at offset ${this.offset}`
    );
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
    if (len < 0 || this.offset + len > this.buf.length) {
      throw new ParquetFormatError(`Truncated Thrift payload: string length ${len} exceeds buffer boundary`);
    }
    const str = this.buf.toString('utf-8', this.offset, this.offset + len);
    this.offset += len;
    return str;
  }

  readBinary(): Buffer {
    const len = Number(this.readVarint());
    if (len < 0 || this.offset + len > this.buf.length) {
      throw new ParquetFormatError(`Truncated Thrift payload: binary length ${len} exceeds buffer boundary`);
    }
    const res = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    return res;
  }

  readFieldBegin(): { fieldId: number; type: number; isStop: boolean } {
    if (this.offset >= this.buf.length) {
      throw new ParquetFormatError(`Truncated Thrift payload: unexpected EOF inside a struct at offset ${this.offset}`);
    }
    const b = this.buf[this.offset++];
    if (b === FIELD_STOP) {
      return { fieldId: 0, type: 0, isStop: true };
    }
    const type = b & NIBBLE_MASK;
    const modifier = (b >> NIBBLE_BITS) & NIBBLE_MASK;
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
      throw new ParquetFormatError(`Truncated Thrift payload: unexpected EOF reading list header`);
    }
    const b = this.buf[this.offset++];
    const sizeHigh = (b >> NIBBLE_BITS) & NIBBLE_MASK;
    const elemType = b & NIBBLE_MASK;
    let size = sizeHigh;
    if (sizeHigh === NIBBLE_MASK) {
      size = Number(this.readVarint());
    }
    const remainingBytes = this.buf.length - this.offset;
    if (size < 0 || size > remainingBytes + 1) {
      throw new ParquetFormatError(
        `Corrupted Thrift payload: list size ${size} exceeds remaining buffer bytes (${remainingBytes})`
      );
    }
    return { elemType, size };
  }

  private skipBytes(count: number) {
    if (count < 0 || this.offset + count > this.buf.length) {
      throw new ParquetFormatError(`Truncated Thrift payload: skip of ${count} bytes exceeds buffer boundary`);
    }
    this.offset += count;
  }

  private skipMapEntry(type: number, depth: number) {
    const isBoolean = type === ThriftType.BOOL_TRUE || type === ThriftType.BOOL_FALSE;
    if (isBoolean) this.skipBytes(LIST_BOOLEAN_ELEMENT_BYTES);
    else this.skip(type, depth + 1);
  }

  skip(type: number, depth = 0) {
    if (depth > MAX_THRIFT_SKIP_DEPTH) {
      throw new ParquetFormatError(`Corrupted Thrift payload: nesting deeper than ${MAX_THRIFT_SKIP_DEPTH} levels`);
    }
    if (type === ThriftType.BOOL_TRUE || type === ThriftType.BOOL_FALSE) {
      return;
    } else if (type === ThriftType.BYTE) {
      this.skipBytes(1);
    } else if (type === ThriftType.I16 || type === ThriftType.I32 || type === ThriftType.I64) {
      this.readVarint();
    } else if (type === ThriftType.DOUBLE) {
      this.skipBytes(DOUBLE_BYTES);
    } else if (type === ThriftType.BINARY) {
      this.skipBytes(Number(this.readVarint()));
    } else if (type === ThriftType.LIST || type === ThriftType.SET) {
      const { elemType, size } = this.readListBegin();
      const isBoolean = elemType === ThriftType.BOOL_TRUE || elemType === ThriftType.BOOL_FALSE;
      for (let i = 0; i < size; i++) {
        if (isBoolean) this.skipBytes(LIST_BOOLEAN_ELEMENT_BYTES);
        else this.skip(elemType, depth + 1);
      }
    } else if (type === ThriftType.MAP) {
      const size = Number(this.readVarint());
      if (size > this.buf.length - this.offset) {
        throw new ParquetFormatError(`Corrupted Thrift payload: map size ${size} exceeds remaining buffer bytes`);
      }
      if (size > 0) {
        const header = this.readByte();
        const ktype = (header >> NIBBLE_BITS) & NIBBLE_MASK;
        const vtype = header & NIBBLE_MASK;
        for (let i = 0; i < size; i++) {
          this.skipMapEntry(ktype, depth);
          this.skipMapEntry(vtype, depth);
        }
      }
    } else if (type === ThriftType.STRUCT) {
      this.structBegin();
      while (true) {
        const f = this.readFieldBegin();
        if (f.isStop) break;
        this.skip(f.type, depth + 1);
      }
      this.structEnd();
    } else {
      throw new ParquetFormatError(`Corrupted Thrift payload: unsupported type ${type} at offset ${this.offset}`);
    }
  }
}
