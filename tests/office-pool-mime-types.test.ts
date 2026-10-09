import { describe, expect } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { oracleTest } from './helpers/oracle-test';
import { authorWithReferenceSuite, type OfficeSource } from './helpers/office-pair-fixtures';

/** The office-engine pool reports the registry's MIME type for the target it wrote. */

const TEST_TIMEOUT_MS = 180_000;

const PAIRS: ReadonlyArray<readonly [OfficeSource, 'doc' | 'rtf']> = [
  ['doc', 'rtf'],
  ['rtf', 'doc'],
];

describe('office pool result MIME type', () => {
  for (const [source, target] of PAIRS) {
    oracleTest(
      `${source} -> ${target} reports the registry MIME type of ${target}`,
      ['soffice'],
      async () => {
        const result = await dispatchConversion(authorWithReferenceSuite(source), source, target, {}, `fixture.${source}`);
        expect(result.mimeType).toBe(FORMAT_REGISTRY[target].mimeType);
        expect(result.mimeType).not.toBe('application/octet-stream');
        expect(result.buffer.length).toBeGreaterThan(0);
      },
      TEST_TIMEOUT_MS
    );
  }
});
