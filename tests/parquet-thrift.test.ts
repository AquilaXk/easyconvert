import { describe, expect, it } from 'vitest';
import { CompactProtocolReader, ParquetFormatError } from '../src/lib/conversions/parquet';

/**
 * Thrift compact protocol reader behaviour, checked against byte sequences written by hand from the
 * protocol description (varints are base-128, list headers carry size and element type nibbles).
 */
describe('Thrift compact reader', () => {
  const TYPE_LIST = 9;
  const TYPE_I32 = 5;

  it('reads a ten byte varint (the longest 64-bit encoding) and rejects an eleventh byte', () => {
    const maxUint64 = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);
    expect(new CompactProtocolReader(maxUint64).readVarint()).toBe(18446744073709551615n);
    const eleven = Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00]);
    expect(() => new CompactProtocolReader(eleven).readVarint()).toThrow(/varint exceeds 10 bytes/);
  });

  it('stops reading a varint at ten bytes without touching the rest of the buffer', () => {
    const reader = new CompactProtocolReader(Buffer.alloc(64, 0x80));
    expect(() => reader.readVarint()).toThrow(ParquetFormatError);
    expect(reader.offset).toBeLessThanOrEqual(10);
  });

  it('skips one byte per boolean element of a list', () => {
    // list header: 3 elements of boolean type 1, elements 01 02 01, then a stop byte
    const reader = new CompactProtocolReader(Buffer.from([0x31, 0x01, 0x02, 0x01, 0x00]));
    reader.skip(TYPE_LIST);
    expect(reader.offset).toBe(4);
  });

  it('skips a struct list that contains boolean fields without consuming element bytes', () => {
    // field 1 of type boolean-true carries its value in the header and has no payload
    const reader = new CompactProtocolReader(Buffer.from([0x11, 0x15, 0x04, 0x00]));
    reader.structBegin();
    const first = reader.readFieldBegin();
    expect(first.type).toBe(1);
    reader.skip(first.type);
    const second = reader.readFieldBegin();
    expect(second.type).toBe(TYPE_I32);
    expect(reader.readZigzag32()).toBe(2);
  });

  it('treats end of input inside a struct as corruption, not as a field stop', () => {
    const reader = new CompactProtocolReader(Buffer.alloc(0));
    reader.structBegin();
    expect(() => reader.readFieldBegin()).toThrow(ParquetFormatError);
    expect(() => reader.readFieldBegin()).toThrow(/unexpected EOF/);
  });

  it('rejects skipping through structs nested deeper than the limit', () => {
    const reader = new CompactProtocolReader(Buffer.concat([Buffer.alloc(40, 0x1c), Buffer.alloc(41, 0)]));
    expect(() => reader.skip(12)).toThrow(/nesting deeper than 32 levels/);
  });
});
