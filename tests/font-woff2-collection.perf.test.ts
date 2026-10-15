import { describe, expect, it } from 'vitest';
import { decodeWoff2Fonts } from '../src/lib/conversions/font-woff2';
import { buildWoff2, collectionHeader, COLLECTION_FLAVOR, type Woff2TableSpec } from './helpers/woff2-builder';
import { expectSizeIndependentOnInputs, SCALING_TEST_TIMEOUT_MS, settle } from './helpers/timing';

/**
 * Timing-ratio checks moved out of font-woff2-collection.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in font-woff2-collection.test.ts.
 */

const MIB = 1024 * 1024;

function collectionFile(tables: Woff2TableSpec[], fonts: Array<{ indices: number[] }>): Buffer {
  return buildWoff2({ flavor: COLLECTION_FLAVOR, tables, afterDirectory: collectionHeader(fonts) });
}

describe('WOFF2 collection: tables shared between fonts', () => {
  it('refuses a head table that is not 54 bytes before inflating anything', async () => {
    const BOMB_BYTES = 32 * MIB;
    const MODEST_BOMB_BYTES = 2 * MIB;
    const FONTS = 16;
    const bombFile = (bytes: number) =>
      collectionFile([{ tag: 'head', data: Buffer.alloc(bytes) }], Array.from({ length: FONTS }, () => ({ indices: [0] })));
    const modest = bombFile(MODEST_BOMB_BYTES);
    const huge = bombFile(BOMB_BYTES);
    expect(huge.length).toBeLessThan(64 * 1024);
    const before = process.memoryUsage().arrayBuffers;
    // Refusing before inflating means a 16x larger declared head table costs the same (tests/helpers/timing.ts).
    const { largeResult } = await expectSizeIndependentOnInputs(
      'head table bomb',
      (file: Buffer) => settle(() => decodeWoff2Fonts(file)),
      { modest, huge }
    );
    if (largeResult.ok) throw new Error('the oversized head table was decoded instead of refused');
    expect((largeResult.error as Error).message).toMatch(/head/);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(8 * MIB);
  }, SCALING_TEST_TIMEOUT_MS);
});
