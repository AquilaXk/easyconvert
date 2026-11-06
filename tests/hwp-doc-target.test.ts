import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, vi } from 'vitest';
import { CFBF_MAGIC, startsWithBytes } from '../src/lib/format-signatures';
import { isFormatCompatibleWithMagicBytes } from '../src/lib/registry';
import { executeWorkerConversion } from '../src/worker/engines';
import { oracleTest } from './helpers/oracle-test';

vi.setConfig({ testTimeout: 180_000 });

const SOURCES: ReadonlyArray<{ format: 'hwp' | 'hwpx'; file: string }> = [
  { format: 'hwpx', file: 'golden/document/multi-column-annotated.hwpx' },
  { format: 'hwp', file: 'hwp/basics-report.hwp' },
];

describe('a Hangul document written as .doc', () => {
  for (const source of SOURCES) {
    oracleTest(`${source.format} to doc is a Word 97-2003 compound file, not a text stream under the .doc name`, ['soffice'], async () => {
      const input = fs.readFileSync(path.join(__dirname, 'fixtures', source.file));
      const result = await executeWorkerConversion(input, source.format, 'doc', {}, `sample.${source.format}`);
      expect(result.mimeType).toBe('application/msword');
      expect(startsWithBytes(result.buffer, CFBF_MAGIC)).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(result.buffer, 'doc')).toBe(true);
      // The document the converter wrote reads back as the same text.
      const text = await executeWorkerConversion(result.buffer, 'doc', 'txt', {}, 'sample.doc');
      const expected = await executeWorkerConversion(input, source.format, 'txt', {}, `sample.${source.format}`);
      const words = (value: Buffer): string[] => value.toString('utf8').split(/\s+/).filter((word) => word !== '').sort();
      expect(words(text.buffer)).toEqual(words(expected.buffer));
    });
  }
});
