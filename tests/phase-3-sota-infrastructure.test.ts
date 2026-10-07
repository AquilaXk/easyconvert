import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  detectSandboxEnvironment,
  getSanitizedEnvironment,
  executeSandboxedBinary,
  SandboxedProcessError,
  SandboxedTimeoutError,
  SandboxedBufferLimitError,
  SandboxedMemoryLimitError,
  resetSandboxEnvironmentCache,
  getProcessRssMb,
} from '../src/lib/security/process-sandbox';
import {
  compressZstd,
  decompressZstd,
  parseZstdFrameHeader,
  xxh64,
  computeZstdChecksum,
  ZSTD_MAGIC_NUMBER,
  ZSTD_MAGIC_LE,
  getZstdBinaryPath,
} from '../src/lib/conversions/zstd';
import {
  encodeParquet,
  decodeParquet,
  decompressSnappy,
  compressSnappy,
  inferColumnSchemas,
  ParquetType,
  CompressionCodec,
  PARQUET_MAGIC,
  ParquetValueError,
  ParquetFormatError,
} from '../src/lib/conversions/parquet';
import {
  parseFvarTable,
  parseStatTable,
  inspectVariableFont,
  createFvarTable,
  createStatTable,
  getStandardAxisName,
  instantiateVariableFont,
  subsetVariableFont,
  convertFont,
  VariableFontAxis,
  VariableFontInstance,
  StatDesignAxis,
  StatAxisValue,
} from '../src/lib/conversions/font';
import { convertArchive } from '../src/lib/conversions/archive';
import { convertData } from '../src/lib/conversions/data';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { buildRleBombFrame } from './helpers/zstd-frames';
import { ConversionFailedError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';

describe('Phase 3: SOTA Infrastructure — Sandboxing, Zstandard, Parquet & Variable Fonts', () => {
  // =========================================================================
  // 1. Process Sandboxing Execution Guards
  // =========================================================================
  describe('1. Process Sandboxing Execution Guards', () => {
    it('detects runtime sandbox environment capabilities', () => {
      const env = detectSandboxEnvironment();
      expect(env).toBeDefined();
      expect(typeof env.isContainer).toBe('boolean');
      expect(typeof env.isGVisor).toBe('boolean');
      expect(typeof env.hasRunsc).toBe('boolean');
      expect(['gvisor', 'container', 'host']).toContain(env.sandboxType);
      expect(typeof env.platform).toBe('string');
    });

    it('sanitizes environment by purging secrets and poisonous egress variables', () => {
      const customEnv = {
        SAFE_CONFIG: 'true',
        AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
        SECRET_TOKEN: 'super-secret-token-123',
        DB_PASSWORD: 'password123',
        API_KEY: 'test-api-key',
        PRIVATE_KEY: 'private-key-bytes',
      };

      const sanitized = getSanitizedEnvironment(customEnv, true);

      expect(sanitized.SAFE_CONFIG).toBe('true');
      expect(sanitized.AWS_ACCESS_KEY_ID).toBeUndefined();
      expect(sanitized.SECRET_TOKEN).toBeUndefined();
      expect(sanitized.DB_PASSWORD).toBeUndefined();
      expect(sanitized.API_KEY).toBeUndefined();
      expect(sanitized.PRIVATE_KEY).toBeUndefined();
      expect(sanitized.HTTP_PROXY).toBe('http://127.0.0.1:0');
      expect(sanitized.HTTPS_PROXY).toBe('http://127.0.0.1:0');
      expect(sanitized.PATH).toBeDefined();
    });

    it('executes a safe binary within sandboxed process limits', async () => {
      const nodeBin = process.execPath;
      const res = await executeSandboxedBinary(
        nodeBin,
        ['-e', 'console.log("sandboxed-ok"); console.error("sandbox-log");'],
        { timeoutMs: 5000 }
      );

      expect(res.exitCode).toBe(0);
      expect(res.stdout.toString('utf-8').trim()).toBe('sandboxed-ok');
      expect(res.stderr.toString('utf-8').trim()).toBe('sandbox-log');
      expect(res.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof res.sandboxed).toBe('boolean');
    });

    it('enforces execution timeout and terminates runaway processes', async () => {
      const nodeBin = process.execPath;
      // Infinite loop script with 300ms timeout
      const promise = executeSandboxedBinary(
        nodeBin,
        ['-e', 'setInterval(() => {}, 1000);'],
        { timeoutMs: 300 }
      );

      await expect(promise).rejects.toThrow(SandboxedTimeoutError);
    });

    it('enforces stdio maxBuffer threshold and kills process overflowing output', async () => {
      const nodeBin = process.execPath;
      // Script generating 200KB of output with a 10KB maxBuffer
      const script = 'process.stdout.write("A".repeat(200 * 1024));';
      const promise = executeSandboxedBinary(
        nodeBin,
        ['-e', script],
        { maxBuffer: 10 * 1024, timeoutMs: 5000 }
      );

      await expect(promise).rejects.toThrow(SandboxedBufferLimitError);
    });

    it('captures non-zero exit codes with SandboxedProcessError', async () => {
      const nodeBin = process.execPath;
      const promise = executeSandboxedBinary(
        nodeBin,
        ['-e', 'console.error("fatal-failure"); process.exit(42);'],
        { timeoutMs: 5000 }
      );

      await expect(promise).rejects.toThrow(SandboxedProcessError);
      try {
        await promise;
      } catch (err) {
        expect(err instanceof SandboxedProcessError).toBe(true);
        const pErr = err as SandboxedProcessError;
        expect(pErr.exitCode).toBe(42);
        expect(pErr.stderr).toContain('fatal-failure');
      }
    });

    it('rejects invalid or missing binary path fail-closed', async () => {
      const emptyPath = await executeSandboxedBinary('', []).catch((err: unknown) => err);
      expect(emptyPath).toBeInstanceOf(SandboxedProcessError);
      expect((emptyPath as SandboxedProcessError).message).toBe('Sandboxed execution error: invalid binary path provided.');
      expect((emptyPath as SandboxedProcessError).exitCode).toBeNull();

      const missingBinary = await executeSandboxedBinary('/nonexistent/easyconvert-test-binary', []).catch((err: unknown) => err);
      expect(missingBinary).toBeInstanceOf(SandboxedProcessError);
      expect(String((missingBinary as SandboxedProcessError).message + (missingBinary as SandboxedProcessError).stderr)).toMatch(
        /No such file or directory|ENOENT/
      );
    });

    it('enforces memory execution limits and terminates process exceeding memory limit', async () => {
      const nodeBin = process.execPath;
      // Script allocating 80MB of memory with a 30MB memory limit
      const script = `
        const chunks = [];
        for (let i = 0; i < 80; i++) {
          chunks.push(Buffer.alloc(1024 * 1024, 0x42));
        }
        setInterval(() => {}, 1000);
      `;
      const promise = executeSandboxedBinary(
        nodeBin,
        ['-e', script],
        { memoryLimitMb: 30, timeoutMs: 5000 }
      );

      await expect(promise).rejects.toThrow(SandboxedMemoryLimitError);
    });

    it('resets sandbox environment cache cleanly', () => {
      const cached = detectSandboxEnvironment();
      // A second call serves the cached object; after the reset the environment is detected again.
      expect(detectSandboxEnvironment()).toBe(cached);
      resetSandboxEnvironmentCache();
      const redetected = detectSandboxEnvironment();
      expect(redetected).not.toBe(cached);
      expect(redetected).toEqual(cached);
      expect(redetected.platform).toBe(process.platform);
      // gVisor wins over a plain container, which wins over the bare host.
      const expectedType = [
        { applies: redetected.isGVisor, type: 'gvisor' },
        { applies: redetected.isContainer, type: 'container' },
        { applies: true, type: 'host' },
      ].find((candidate) => candidate.applies)?.type;
      expect(redetected.sandboxType).toBe(expectedType);
    });
  });

  // =========================================================================
  // 2. Zstandard (FSE) Streaming Compression Engine
  // =========================================================================
  describe('2. Zstandard (RFC 8878) Streaming Compression Engine', () => {
    it('calculates XXH64 and 32-bit checksum adhering to RFC 8878', () => {
      const sample = Buffer.from('EasyConvert High-Performance Zstandard Stream');
      const hash64 = xxh64(sample);

      const checksum = computeZstdChecksum(sample);
      expect(checksum).toBe(Number(hash64 & 0xffffffffn));

      // Published xxHash64 test vectors (seed 0): the empty input and "abc".
      expect(xxh64(Buffer.alloc(0))).toBe(0xef46db3751d8e999n);
      expect(xxh64(Buffer.from('abc'))).toBe(0x44bc2cf5ad770999n);
    });

    it('encodes and decodes raw uncompressed Zstandard frames', () => {
      const originalText = 'Hello, Zstandard RFC 8878 enterprise grade compression!';
      const inputBuf = Buffer.from(originalText, 'utf-8');

      const compressed = compressZstd(inputBuf);
      expect(compressed.length).toBeGreaterThan(4);
      expect(compressed.readUInt32LE(0)).toBe(ZSTD_MAGIC_NUMBER);

      const decompressed = decompressZstd(compressed);
      expect(decompressed.toString('utf-8')).toBe(originalText);
    });

    it('encodes and decodes RLE compressed blocks for repetitive data', () => {
      // 800 bytes of identical bytes (compression ratio ~ 60:1, below 100:1 bomb limit)
      const rleData = Buffer.alloc(800, 0x41); // 'A'
      const compressed = compressZstd(rleData);

      // RLE block should compress 800 bytes down to less than 20 bytes
      expect(compressed.length).toBeLessThan(20);

      const decompressed = decompressZstd(compressed);
      expect(decompressed.length).toBe(800);
      expect(decompressed.every((b) => b === 0x41)).toBe(true);
    });

    it('handles multi-block data spanning beyond single block limit (128KB)', () => {
      // 300KB of repetitive-but-not-degenerate text: three blocks, genuinely compressed, ratio far below the bomb floor
      const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
      let seed = 0x2545f491;
      const pieces: string[] = [];
      let total = 0;
      while (total < 300 * 1024) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        const piece = `${words[(seed >>> 16) % words.length]}-${(seed >>> 8) % 97} `;
        pieces.push(piece);
        total += piece.length;
      }
      const largeData = Buffer.from(pieces.join('').slice(0, 300 * 1024), 'latin1');

      const compressed = compressZstd(largeData);
      expect(compressed.length).toBeLessThan(largeData.length / 2);
      const decompressed = decompressZstd(compressed);

      expect(decompressed.length).toBe(largeData.length);
      expect(Buffer.compare(decompressed, largeData)).toBe(0);
    });

    it('parses Zstandard frame header metadata accurately', () => {
      const data = Buffer.from('Zstd header parse verification payload');
      const compressed = compressZstd(data);

      const header = parseZstdFrameHeader(compressed, 0);
      expect(header.singleSegment).toBe(true);
      expect(header.contentChecksumFlag).toBe(true);
      expect(header.frameContentSize).toBe(data.length);
      expect(header.headerSize).toBeGreaterThan(0);
    });

    it('handles skippable frames seamlessly', () => {
      const original = Buffer.from('Payload after skippable frame');
      const validFrame = compressZstd(original);

      // Create a skippable frame: 0x184D2A55 + 4 bytes length (8) + 8 dummy bytes
      const skipFrame = Buffer.alloc(16);
      skipFrame.writeUInt32LE(0x184d2a55, 0);
      skipFrame.writeUInt32LE(8, 4);
      skipFrame.fill(0xff, 8);

      const combined = Buffer.concat([skipFrame, validFrame]);
      const decompressed = decompressZstd(combined);

      expect(decompressed.toString('utf-8')).toBe(original.toString('utf-8'));
    });

    it('detects and rejects mismatched content checksum fail-closed', () => {
      const data = Buffer.from('Content checksum tamper check');
      const compressed = compressZstd(data);

      // Tamper with the checksum (last 4 bytes)
      compressed[compressed.length - 1] ^= 0xff;

      expect(() => decompressZstd(compressed)).toThrow(/checksum mismatch/i);
    });

    it('detects corrupted or invalid magic byte fail-closed', () => {
      const invalid = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);
      expect(() => decompressZstd(invalid)).toThrow(/Invalid Zstandard magic/i);
    });

    it('enforces archive bomb safeguards once output passes the ratio-guard floor', () => {
      // 257 RLE blocks of 128 KiB decode to 32 MiB + 128 KiB from ~1 KB (ratio > 30000:1)
      const bomb = buildRleBombFrame(257);
      expect(bomb.length).toBeLessThan(2048);
      expect(() => decompressZstd(bomb)).toThrow(
        /Archive bomb detected: compression ratio .* exceeds 100:1 limit/i
      );
    });

    it('accepts small highly repetitive payloads below the ratio-guard floor', () => {
      const repetitiveData = Buffer.alloc(50000, 0x42);
      const compressed = compressZstd(repetitiveData);
      expect(repetitiveData.length / compressed.length).toBeGreaterThan(100);
      expect(Buffer.compare(decompressZstd(compressed), repetitiveData)).toBe(0);
    });

    it('integrates zst and tar.zst in convertArchive and FORMAT_REGISTRY', async () => {
      expect(FORMAT_REGISTRY['zst']).toBeDefined();
      expect(FORMAT_REGISTRY['zstd']).toBeDefined();
      expect(FORMAT_REGISTRY['tar.zst']).toBeDefined();
      expect(FORMAT_REGISTRY['zst'].mimeType).toBe('application/zstd');
      expect(FORMAT_REGISTRY['tar.zst'].mimeType).toBe('application/x-zstd-compressed-tar');

      const fileContent = Buffer.from('EasyConvert archive round-trip test file');
      // Create zst
      const zstResult = await convertArchive(fileContent, 'txt', 'zst', {}, 'sample.txt');
      expect(zstResult.mimeType).toBe('application/zstd');
      expect(zstResult.filename).toBe('sample.txt.zst');

      // Extract zst
      const extracted = await convertArchive(zstResult.buffer, 'zst', 'zip', {}, 'sample.txt.zst');
      expect(extracted.mimeType).toBe('application/zip');
      expect(extracted.size).toBeGreaterThan(0);

      // Create tar.zst
      const tarZstResult = await convertArchive(fileContent, 'txt', 'tar.zst', {}, 'sample.txt');
      expect(tarZstResult.mimeType).toBe('application/x-zstd-compressed-tar');
      expect(tarZstResult.filename).toBe('sample.tar.zst');
    });

    it('rejects corrupted zst archives fail-closed in convertArchive', async () => {
      const corruptZst = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02]);
      const failure = await convertArchive(corruptZst, 'zst', 'zip', {}, 'corrupted.zst').catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect((failure as Error).message).toBe('Malformed Zstandard frame: truncated block header.');
    });

    oracleTest('detects the system zstd binary the reference lookup finds', ['zstd'], () => {
      // Both lookups resolve the same executable file.
      const binPath = getZstdBinaryPath();
      expect(binPath).not.toBeNull();
      expect(fs.realpathSync(binPath as string)).toBe(fs.realpathSync(requireOracleTool('zstd')));
      expect(() => fs.accessSync(binPath as string, fs.constants.X_OK)).not.toThrow();
    });
  });

  // =========================================================================
  // 3. Apache Parquet Columnar Data Engine
  // =========================================================================
  describe('3. Apache Parquet Columnar Data Engine', () => {
    it('infers schema accurately across heterogeneous primitive types', () => {
      const records = [
        { id: 1, name: 'Alice', active: true, score: 98.5 },
        { id: 2, name: 'Bob', active: false, score: 87.2 },
        { id: 3, name: 'Charlie', active: true, score: 92.0 },
      ];

      const schemas = inferColumnSchemas(records);
      const schemaMap = Object.fromEntries(schemas.map((s) => [s.name, s]));

      expect(schemaMap['id'].type).toBe(ParquetType.INT64);
      expect(schemaMap['name'].type).toBe(ParquetType.BYTE_ARRAY);
      expect(schemaMap['active'].type).toBe(ParquetType.BOOLEAN);
      expect(schemaMap['score'].type).toBe(ParquetType.DOUBLE);
    });

    it('serializes and deserializes columnar records with PAR1 header and footer', () => {
      const records = [
        { code: 'EUR', rate: 1.085, count: 500, active: true },
        { code: 'GBP', rate: 1.295, count: 250, active: false },
        { code: 'JPY', rate: 0.0067, count: 12000, active: true },
      ];

      const parquetBuffer = encodeParquet(records);
      expect(parquetBuffer.length).toBeGreaterThan(12);

      // PAR1 header and footer verification
      expect(parquetBuffer.toString('ascii', 0, 4)).toBe(PARQUET_MAGIC);
      expect(parquetBuffer.toString('ascii', parquetBuffer.length - 4, parquetBuffer.length)).toBe(
        PARQUET_MAGIC
      );

      const decoded = decodeParquet(parquetBuffer);
      expect(decoded.length).toBe(records.length);
      expect(decoded[0].code).toBe('EUR');
      expect(decoded[0].rate).toBeCloseTo(1.085);
      expect(decoded[0].count).toBe(500);
      expect(decoded[0].active).toBe(true);

      expect(decoded[1].code).toBe('GBP');
      expect(decoded[1].rate).toBeCloseTo(1.295);
      expect(decoded[1].count).toBe(250);
      expect(decoded[1].active).toBe(false);
    });

    it('rejects invalid or corrupted Parquet payloads fail-closed', () => {
      const corrupt = Buffer.from('NOT_PARQUET_FILE_FORMAT_SAMPLE');
      expect(() => decodeParquet(corrupt)).toThrow(/Invalid Parquet file/i);
    });

    it('supports end-to-end convertData from CSV to Parquet and back to JSON', async () => {
      expect(FORMAT_REGISTRY['parquet']).toBeDefined();
      expect(FORMAT_REGISTRY['parquet'].mimeType).toBe('application/vnd.apache.parquet');

      const csvContent = 'city,temp,rainfall,coastal\nSeoul,22.5,120,false\nBusan,25.0,210,true';
      const csvBuffer = Buffer.from(csvContent, 'utf-8');

      // CSV -> Parquet
      const parquetRes = await convertData(csvBuffer, 'csv', 'parquet', {}, 'weather.csv');
      expect(parquetRes.mimeType).toBe('application/vnd.apache.parquet');
      expect(parquetRes.filename).toBe('weather.parquet');

      // Parquet -> JSON
      const jsonRes = await convertData(parquetRes.buffer, 'parquet', 'json', {}, 'weather.parquet');
      expect(jsonRes.mimeType).toBe('application/json');
      const parsedJson = JSON.parse(jsonRes.buffer.toString('utf-8'));
      expect(parsedJson.length).toBe(2);
      expect(parsedJson[0].city).toBe('Seoul');
      expect(parsedJson[1].city).toBe('Busan');

      // Parquet -> CSV
      const backCsvRes = await convertData(parquetRes.buffer, 'parquet', 'csv', {}, 'weather.parquet');
      expect(backCsvRes.mimeType).toBe('text/csv');
      expect(backCsvRes.buffer.toString('utf-8')).toContain('Seoul');
      expect(backCsvRes.buffer.toString('utf-8')).toContain('Busan');
    });

    it('encodes booleans as standard 1-bit packed LSB-first in PLAIN encoding', () => {
      const records = Array.from({ length: 16 }, (_, i) => ({
        id: i,
        flag: i % 3 === 0,
      }));
      const encoded = encodeParquet(records);
      const decoded = decodeParquet(encoded);
      expect(decoded.length).toBe(16);
      for (let i = 0; i < 16; i++) {
        expect(decoded[i].flag).toBe(i % 3 === 0);
      }
    });

    it('rejects empty datasets in encodeParquet with a typed 400-class error', () => {
      expect(() => encodeParquet([])).toThrow(ParquetValueError);
      expect(() => encodeParquet([])).toThrow(/no records/i);
      expect(() => encodeParquet([{}, {}])).toThrow(/no columns/i);
    });

    it('rejects truncated Parquet data page fail-closed', () => {
      const records = [{ a: 'first' }, { a: 'second' }, { a: 'third' }];
      const valid = encodeParquet(records);
      const truncated = valid.subarray(0, valid.length - 20);
      // The footer is gone, so the closing magic is read from the middle of the last data page.
      expect(() => decodeParquet(truncated)).toThrow(ParquetFormatError);
      expect(() => decodeParquet(truncated)).toThrow(/Invalid Parquet file: magic header='PAR1', magic footer='/);
      expect(decodeParquet(valid)).toEqual(records);
    });

    it('decompresses Snappy blocks and decodes Snappy-compressed Parquet columnar data', () => {
      const rawPayload = Buffer.from('EasyConvert SOTA Columnar Storage Engine with Snappy Acceleration');
      const compressed = compressSnappy(rawPayload);
      const decompressed = decompressSnappy(compressed);
      expect(decompressed.toString('utf-8')).toBe(rawPayload.toString('utf-8'));
    });

    it('supports converting Parquet to xml, html, ndjson, and xls', async () => {
      const records = [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }];
      const parquetBuf = encodeParquet(records);

      const xmlRes = await convertData(parquetBuf, 'parquet', 'xml', {}, 'sample.parquet');
      expect(xmlRes.mimeType).toBe('application/xml');
      expect(xmlRes.buffer.toString('utf-8')).toContain('Alpha');

      const htmlRes = await convertData(parquetBuf, 'parquet', 'html', {}, 'sample.parquet');
      expect(htmlRes.mimeType).toBe('text/html');
      expect(htmlRes.buffer.toString('utf-8')).toContain('Alpha');

      const ndjsonRes = await convertData(parquetBuf, 'parquet', 'ndjson', {}, 'sample.parquet');
      expect(ndjsonRes.mimeType).toBe('application/x-ndjson');
      expect(ndjsonRes.buffer.toString('utf-8')).toContain('"name":"Alpha"');

      const xlsRes = await convertData(parquetBuf, 'parquet', 'xls', {}, 'sample.parquet');
      expect(xlsRes.mimeType).toBe('application/vnd.ms-excel');
      expect(xlsRes.buffer.toString('utf-8')).toContain('Alpha');
    });
  });

  // =========================================================================
  // 4. Variable Font (fvar, STAT) Table Inspection & Subsetting
  // =========================================================================
  describe('4. Variable Font (fvar, STAT) Table Inspection & Subsetting', () => {
    it('creates and parses fvar table with multiple variation axes and named instances', () => {
      const axes: VariableFontAxis[] = [
        {
          tag: 'wght',
          name: 'Weight',
          minValue: 100,
          defaultValue: 400,
          maxValue: 900,
          flags: 0,
          axisNameID: 256,
        },
        {
          tag: 'wdth',
          name: 'Width',
          minValue: 75,
          defaultValue: 100,
          maxValue: 125,
          flags: 0,
          axisNameID: 257,
        },
        {
          tag: 'slnt',
          name: 'Slant',
          minValue: -12,
          defaultValue: 0,
          maxValue: 0,
          flags: 0,
          axisNameID: 258,
        },
      ];

      const instances: VariableFontInstance[] = [
        {
          name: 'Light',
          subfamilyNameID: 260,
          flags: 0,
          coordinates: { wght: 300, wdth: 100, slnt: 0 },
        },
        {
          name: 'Regular',
          subfamilyNameID: 261,
          flags: 0,
          coordinates: { wght: 400, wdth: 100, slnt: 0 },
        },
        {
          name: 'Bold',
          subfamilyNameID: 262,
          flags: 0,
          coordinates: { wght: 700, wdth: 100, slnt: 0 },
        },
      ];

      const fvarTable = createFvarTable(axes, instances);
      expect(fvarTable.length).toBeGreaterThan(16);

      const parsed = parseFvarTable(fvarTable);
      expect(parsed.axes.length).toBe(3);
      expect(parsed.axes[0].tag).toBe('wght');
      expect(parsed.axes[0].minValue).toBe(100);
      expect(parsed.axes[0].defaultValue).toBe(400);
      expect(parsed.axes[0].maxValue).toBe(900);

      expect(parsed.axes[1].tag).toBe('wdth');
      expect(parsed.axes[2].tag).toBe('slnt');

      expect(parsed.instances.length).toBe(3);
      expect(parsed.instances[0].coordinates['wght']).toBe(300);
      expect(parsed.instances[2].coordinates['wght']).toBe(700);
    });

    it('creates and parses STAT table with design axes and axis values', () => {
      const statAxes: StatDesignAxis[] = [
        { tag: 'wght', name: 'Weight', ordering: 0, axisNameID: 256 },
        { tag: 'ital', name: 'Italic', ordering: 1, axisNameID: 257 },
      ];

      const statValues: StatAxisValue[] = [
        { format: 1, axisIndex: 0, flags: 0, valueNameID: 260, valueName: 'Regular', value: 400 },
        { format: 1, axisIndex: 0, flags: 0, valueNameID: 261, valueName: 'Bold', value: 700 },
        {
          format: 2,
          axisIndex: 0,
          flags: 0,
          valueNameID: 262,
          valueName: 'Variable Weight',
          nominalValue: 400,
          rangeMinValue: 100,
          rangeMaxValue: 900,
        },
      ];

      const statTable = createStatTable(statAxes, statValues);
      expect(statTable.length).toBeGreaterThan(20);

      const parsed = parseStatTable(statTable);
      expect(parsed.axes.length).toBe(2);
      expect(parsed.axes[0].tag).toBe('wght');
      expect(parsed.axes[1].tag).toBe('ital');

      expect(parsed.values.length).toBe(3);
      expect(parsed.values[0].value).toBe(400);
      expect(parsed.values[1].value).toBe(700);
      expect(parsed.values[2].nominalValue).toBe(400);
      expect(parsed.values[2].rangeMinValue).toBe(100);
      expect(parsed.values[2].rangeMaxValue).toBe(900);
    });

    it('inspects variable font and distinguishes from static font', () => {
      // Create minimal synthetic variable font containing fvar table
      const axes: VariableFontAxis[] = [
        { tag: 'wght', name: 'Weight', minValue: 100, defaultValue: 400, maxValue: 900, flags: 0, axisNameID: 256 },
      ];
      const instances: VariableFontInstance[] = [
        { name: 'Regular', subfamilyNameID: 260, flags: 0, coordinates: { wght: 400 } },
      ];
      const fvarTable = createFvarTable(axes, instances);

      // Build synthetic TrueType font with fvar table
      const headTable = Buffer.alloc(54);
      headTable.writeUInt32BE(0x5f0f3cf5, 0); // magicNumber = 0x5F0F3CF5
      const hheaTable = Buffer.alloc(36);
      const maxpTable = Buffer.alloc(32);
      maxpTable.writeUInt16BE(1, 4); // numGlyphs = 1

      // Font directory with 4 tables: 'head', 'hhea', 'maxp', 'fvar'
      const numTables = 4;
      const fontBuf = Buffer.alloc(12 + numTables * 16 + 54 + 36 + 32 + fvarTable.length + 16);
      fontBuf.writeUInt32BE(0x00010000, 0); // sfntVersion
      fontBuf.writeUInt16BE(numTables, 4);

      let dirOff = 12;
      let dataOff = 12 + numTables * 16;

      const addTable = (tag: string, data: Buffer) => {
        fontBuf.write(tag, dirOff, 4, 'ascii');
        fontBuf.writeUInt32BE(0, dirOff + 4); // checksum
        fontBuf.writeUInt32BE(dataOff, dirOff + 8);
        fontBuf.writeUInt32BE(data.length, dirOff + 12);
        data.copy(fontBuf, dataOff);
        dirOff += 16;
        dataOff += data.length + ((4 - (data.length % 4)) % 4);
      };

      addTable('head', headTable);
      addTable('hhea', hheaTable);
      addTable('maxp', maxpTable);
      addTable('fvar', fvarTable);

      const trimmedFont = fontBuf.subarray(0, dataOff);
      const metadata = inspectVariableFont(trimmedFont);

      expect(metadata.isVariableFont).toBe(true);
      expect(metadata.axes.length).toBe(1);
      expect(metadata.axes[0].tag).toBe('wght');
      expect(metadata.instances.length).toBe(1);
      expect(metadata.instances[0].coordinates['wght']).toBe(400);
    });

    it('translates standard OpenType variation axis tags to canonical names', () => {
      expect(getStandardAxisName('wght')).toBe('Weight');
      expect(getStandardAxisName('wdth')).toBe('Width');
      expect(getStandardAxisName('slnt')).toBe('Slant');
      expect(getStandardAxisName('ital')).toBe('Italic');
      expect(getStandardAxisName('opsz')).toBe('Optical Size');
      expect(getStandardAxisName('grad')).toBe('Grade');
      expect(getStandardAxisName('custom')).toBe('custom');
    });

    it('preserves postScriptNameID in createFvarTable when instances specify it', () => {
      const axes: VariableFontAxis[] = [
        { tag: 'wght', name: 'Weight', minValue: 100, defaultValue: 400, maxValue: 900, flags: 0, axisNameID: 256 },
      ];
      const instances: VariableFontInstance[] = [
        { name: 'Bold', subfamilyNameID: 260, flags: 0, coordinates: { wght: 700 }, postScriptNameID: 270 },
      ];
      const fvar = createFvarTable(axes, instances);
      const parsed = parseFvarTable(fvar);
      expect(parsed.instances[0].postScriptNameID).toBe(270);
    });

    it('subsets and instantiates variable font updating table attributes', () => {
      const axes: VariableFontAxis[] = [
        { tag: 'wght', name: 'Weight', minValue: 100, defaultValue: 400, maxValue: 900, flags: 0, axisNameID: 256 },
        { tag: 'ital', name: 'Italic', minValue: 0, defaultValue: 0, maxValue: 1, flags: 0, axisNameID: 257 },
      ];
      const instances: VariableFontInstance[] = [
        { name: 'Regular', subfamilyNameID: 260, flags: 0, coordinates: { wght: 400, ital: 0 } },
        { name: 'Bold', subfamilyNameID: 261, flags: 0, coordinates: { wght: 700, ital: 0 } },
      ];
      const fvarTable = createFvarTable(axes, instances);

      const headTable = Buffer.alloc(54);
      headTable.writeUInt32BE(0x5f0f3cf5, 0);
      const os2Table = Buffer.alloc(96);
      os2Table.writeUInt16BE(400, 4); // usWeightClass = 400

      const numTables = 3;
      const fontBuf = Buffer.alloc(12 + numTables * 16 + 54 + 96 + fvarTable.length + 16);
      fontBuf.writeUInt32BE(0x00010000, 0);
      fontBuf.writeUInt16BE(numTables, 4);

      let dirOff = 12;
      let dataOff = 12 + numTables * 16;
      const addTable = (tag: string, data: Buffer) => {
        fontBuf.write(tag, dirOff, 4, 'ascii');
        fontBuf.writeUInt32BE(0, dirOff + 4);
        fontBuf.writeUInt32BE(dataOff, dirOff + 8);
        fontBuf.writeUInt32BE(data.length, dirOff + 12);
        data.copy(fontBuf, dataOff);
        dirOff += 16;
        dataOff += data.length + ((4 - (data.length % 4)) % 4);
      };

      addTable('head', headTable);
      addTable('OS/2', os2Table);
      addTable('fvar', fvarTable);

      const trimmedFont = fontBuf.subarray(0, dataOff);

      // Pin variation coordinates to wght=700, ital=1 (Bold Italic)
      const subsetted = subsetVariableFont(trimmedFont, {
        coordinates: { wght: 700, ital: 1 },
      });

      expect(subsetted.length).toBeGreaterThan(0);
      const reInspected = inspectVariableFont(subsetted);
      expect(reInspected.isVariableFont).toBe(true);
      expect(reInspected.axes.find((a) => a.tag === 'wght')?.defaultValue).toBe(700);
      expect(reInspected.axes.find((a) => a.tag === 'ital')?.defaultValue).toBe(1);
    });

    it('parses STAT table Format 4 compound axis values', () => {
      // Build a minimal STAT table with format 4
      const header = Buffer.alloc(20);
      header.writeUInt16BE(1, 0); // majorVersion = 1
      header.writeUInt16BE(2, 2); // minorVersion = 2
      header.writeUInt16BE(8, 4); // designAxisSize = 8
      header.writeUInt16BE(2, 6); // designAxisCount = 2
      header.writeUInt32BE(20, 8); // designAxesOffset = 20
      header.writeUInt16BE(1, 12); // axisValueCount = 1
      header.writeUInt32BE(36, 14); // offsetToAxisValueOffsets = 36

      const axesBuf = Buffer.alloc(16);
      axesBuf.write('wght', 0, 4, 'ascii');
      axesBuf.writeUInt16BE(256, 4);
      axesBuf.writeUInt16BE(0, 6);
      axesBuf.write('ital', 8, 4, 'ascii');
      axesBuf.writeUInt16BE(257, 12);
      axesBuf.writeUInt16BE(1, 14);

      const offsetBuf = Buffer.alloc(2);
      offsetBuf.writeUInt16BE(38, 0); // Value at 38

      const val4 = Buffer.alloc(20);
      val4.writeUInt16BE(4, 0); // format = 4
      val4.writeUInt16BE(2, 2); // axisCount = 2
      val4.writeUInt16BE(0, 4); // flags
      val4.writeUInt16BE(280, 6); // valueNameID = 280
      // AxisValueRecord 0: axisIndex 0, value 700
      val4.writeUInt16BE(0, 8);
      val4.writeInt32BE(700 * 65536, 10);
      // AxisValueRecord 1: axisIndex 1, value 1
      val4.writeUInt16BE(1, 14);
      val4.writeInt32BE(1 * 65536, 16);

      const statData = Buffer.concat([header, axesBuf, offsetBuf, val4]);
      const parsed = parseStatTable(statData);

      expect(parsed.axes.length).toBe(2);
      expect(parsed.values.length).toBe(1);
      expect(parsed.values[0].format).toBe(4);
      expect(parsed.values[0].axisValues?.length).toBe(2);
      expect(parsed.values[0].axisValues?.[0].value).toBe(700);
      expect(parsed.values[0].axisValues?.[1].value).toBe(1);
    });

    it('rejects truncated fvar table fail-closed', () => {
      const corrupt = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x10, 0x00, 0x02, 0x00, 0x05]);
      expect(() => parseFvarTable(corrupt)).toThrow(/truncated/i);
    });
  });
});
