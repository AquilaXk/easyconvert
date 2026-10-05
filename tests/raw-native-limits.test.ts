import { describe, it, expect, afterAll } from 'vitest';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { RawDecodeError } from '../src/lib/types';
import { RAW_DECODE_MAX_PIXELS } from '../src/worker/raw-decoded-tiff';

/**
 * The decoder binary is replaced by a small script (through DCRAW_EMU_PATH) that emits a chosen
 * result; the engine under test still runs its real sandbox, size checks and error mapping.
 */
const STUB_DIR = mkdtempSync(path.join(os.tmpdir(), 'raw-stub-'));
const TEMP_PREFIX = 'easyconvert-raw-';
const DNG_HEADER = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);

/** Writes a stub that creates a TIFF header (and nothing else) claiming the given size at the -Z path. */
function headerOnlyStub(width: number, height: number): string {
  const script = path.join(STUB_DIR, `stub-${width}x${height}.sh`);
  const python = `
import struct, sys
out = sys.argv[sys.argv.index('-Z') + 1]
entries = [(256, 4, 1, ${width}), (257, 4, 1, ${height}), (273, 4, 1, 200), (277, 3, 1, 3)]
body = struct.pack('<H', len(entries)) + b''.join(struct.pack('<HHII', *e) for e in entries) + struct.pack('<I', 0)
open(out, 'wb').write(b'II*\\x00' + struct.pack('<I', 8) + body + b'\\x00' * 200)
`;
  writeFileSync(script, `#!/bin/sh\nexec python3 -c "${python.replace(/"/g, '\\"')}" "$@"\n`);
  chmodSync(script, 0o755);
  return script;
}

function signalStub(signalName: string): string {
  const script = path.join(STUB_DIR, `stub-${signalName}.sh`);
  writeFileSync(script, `#!/bin/sh\nkill -${signalName} $$\n`);
  chmodSync(script, 0o755);
  return script;
}

async function convertWithStub(stub: string): Promise<unknown> {
  const previous = process.env.DCRAW_EMU_PATH;
  process.env.DCRAW_EMU_PATH = stub;
  try {
    return await dispatchConversion(DNG_HEADER, 'dng', 'png', {}, 'stub.dng').catch((e: unknown) => e);
  } finally {
    if (previous === undefined) delete process.env.DCRAW_EMU_PATH;
    else process.env.DCRAW_EMU_PATH = previous;
  }
}

afterAll(() => rmSync(STUB_DIR, { recursive: true, force: true }));

describe('native RAW decoder resource bounds', () => {
  it('rejects a decoded size above the pixel cap from its header, without reading the pixels', async () => {
    const side = Math.ceil(Math.sqrt(RAW_DECODE_MAX_PIXELS)) + 1;
    const error = await convertWithStub(headerOnlyStub(side, side));
    expect(error).toBeInstanceOf(RawDecodeError);
    expect((error as RawDecodeError).message).toMatch(new RegExp(`${side}x${side} pixels exceeds the ${RAW_DECODE_MAX_PIXELS} pixel limit`));
  });

  it('maps an output-size signal (SIGXFSZ) to a client error and cleans up', async () => {
    const before = readdirSync(os.tmpdir()).filter((name) => name.startsWith(TEMP_PREFIX));
    const error = await convertWithStub(signalStub('XFSZ'));
    expect(error).toBeInstanceOf(RawDecodeError);
    expect((error as RawDecodeError).message).toMatch(/output limit/);
    expect(readdirSync(os.tmpdir()).filter((name) => name.startsWith(TEMP_PREFIX))).toEqual(before);
  });

  it('keeps a decoder timeout out of the client-error class', async () => {
    const script = path.join(STUB_DIR, 'stub-sleep.sh');
    writeFileSync(script, '#!/bin/sh\nsleep 30\n');
    chmodSync(script, 0o755);
    const previous = process.env.DCRAW_EMU_PATH;
    process.env.DCRAW_EMU_PATH = script;
    try {
      const error = await dispatchConversion(DNG_HEADER, 'dng', 'png', { timeoutMs: 500 }, 'stub.dng').catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(RawDecodeError);
      expect((error as Error).name).toBe('SandboxedTimeoutError');
    } finally {
      if (previous === undefined) delete process.env.DCRAW_EMU_PATH;
      else process.env.DCRAW_EMU_PATH = previous;
    }
  });
});
