import { describe, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTarArchive } from '../src/lib/conversions/archive';
import { compressZstd } from '../src/lib/conversions/zstd';
import { SandboxedProcessError } from '../src/lib/security/process-sandbox';
import { ConversionFailedError } from '../src/lib/types';
import { executeWorkerConversion } from '../src/worker/engines';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { buildRleBombFrame } from './helpers/zstd-frames';

const PAYLOAD = Buffer.from('routing regression payload for the in-process zstd engine\n'.repeat(40));
const FLOOR_BLOCKS_PLUS_ONE = 257;

function withTempFile<T>(name: string, data: Buffer, action: (file: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-zstd-'));
  try {
    const file = path.join(dir, name);
    fs.writeFileSync(file, data);
    return action(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Decompresses the single member of a zip with the independent 7z binary. */
function zipMemberVia7z(zip: Buffer): Buffer {
  const bin = requireOracleTool('7z');
  return withTempFile('result.zip', zip, (file) =>
    execFileSync(bin, ['x', '-so', '-y', file], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  );
}

/** Reads the single member of a tar with the system tar. */
function tarMemberViaTar(tar: Buffer): Buffer {
  return withTempFile('result.tar', tar, (file) => execFileSync('tar', ['-xOf', file], { maxBuffer: 64 * 1024 * 1024 }));
}

async function captureRejection(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  return null;
}

// Stock 7-Zip cannot open Zstandard streams. While 7z is installed the worker used to hand .zst
// files to it and surface its "Cannot open the file as archive" failure instead of decoding them.
describe('worker routes zstd archives to the in-process engine even when 7z is installed', () => {
  oracleTest('zst -> zip decodes to the original bytes', ['7z'], async () => {
    const result = await executeWorkerConversion(compressZstd(PAYLOAD), 'zst', 'zip', {}, 'sample.txt.zst');
    expect(Buffer.compare(zipMemberVia7z(result.buffer as Buffer), PAYLOAD)).toBe(0);
  });

  oracleTest('zst -> tar decodes to the original bytes', ['7z'], async () => {
    const result = await executeWorkerConversion(compressZstd(PAYLOAD), 'zst', 'tar', {}, 'sample.txt.zst');
    expect(Buffer.compare(tarMemberViaTar(result.buffer as Buffer), PAYLOAD)).toBe(0);
  });

  oracleTest('zst holding a tar -> zip extracts the tar member', ['7z'], async () => {
    const tar = createTarArchive([{ filename: 'member.txt', buffer: PAYLOAD }]).buffer;
    const result = await executeWorkerConversion(compressZstd(tar), 'zst', 'zip', {}, 'bundle.tar.zst');
    expect(Buffer.compare(zipMemberVia7z(result.buffer as Buffer), PAYLOAD)).toBe(0);
  });

  oracleTest('a corrupt or hostile zstd input raises ConversionFailedError, not a sandbox error', ['7z'], async () => {
    const valid = compressZstd(PAYLOAD);
    const cases: Array<[string, Buffer, RegExp]> = [
      ['truncated frame', valid.subarray(0, valid.length - 6), /Zstandard|zstd|truncated|checksum/i],
      ['flipped checksum', Buffer.concat([valid.subarray(0, valid.length - 1), Buffer.from([valid[valid.length - 1] ^ 0xff])]), /checksum/i],
      ['decompression bomb', buildRleBombFrame(FLOOR_BLOCKS_PLUS_ONE), /Archive bomb detected/],
    ];
    for (const target of ['zip', 'tar']) {
      for (const [name, input, message] of cases) {
        const error = await captureRejection(executeWorkerConversion(input, 'zst', target, {}, 'broken.zst'));
        expect(error, `${name} -> ${target}`).toBeInstanceOf(ConversionFailedError);
        expect(error, `${name} -> ${target}`).not.toBeInstanceOf(SandboxedProcessError);
        expect((error as Error).message, `${name} -> ${target}`).toMatch(message);
      }
    }
  });
});
