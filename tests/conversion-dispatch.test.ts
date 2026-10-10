import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { executeWorkerConversion } from '../src/worker/engines';
import { EngineUnavailableError, UnsupportedTargetError } from '../src/lib/types';
import { withMissingBinary } from './helpers/native-tools';
import { skipWithoutTools } from './helpers/strict-skip';
import { extractTextWithExternalPdftotext } from './helpers/differential-oracle';

const FIXTURES = path.resolve(__dirname, 'fixtures');
const SAMPLE_DOCX = readFileSync(path.join(FIXTURES, 'sample.docx'));
const SAMPLE_XLSX = readFileSync(path.join(FIXTURES, 'sample.xlsx'));
const DOCX_BODY_TEXT = 'deterministic regression fixture text';

describe('worker orchestrator without in-process fallback', () => {
  it('rethrows the missing engine instead of handing a native-only pair to the in-process engine', async () => {
    const run = withMissingBinary('SOFFICE_PATH', () =>
      executeWorkerConversion(SAMPLE_DOCX, 'docx', 'png', { inProcessFallback: false }, 'sample.docx')
    );
    await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toMatchObject({ engineName: 'soffice' });
  });

  it('rejects a pair that no native route handles with a routing error', async () => {
    const run = executeWorkerConversion(Buffer.from('a,b\n1,2\n'), 'csv', 'json', { inProcessFallback: false }, 'in.csv');
    await expect(run).rejects.toBeInstanceOf(UnsupportedTargetError);
    await expect(run).rejects.toThrow(/^No native engine route converts csv to json$/);
  });
});

describe('dispatchConversion', () => {
  it('rejects a pair the registry does not offer before any engine runs', async () => {
    const run = dispatchConversion(Buffer.from('plain text'), 'txt', 'dwg', {}, 'in.txt');
    await expect(run).rejects.toBeInstanceOf(UnsupportedTargetError);
    await expect(run).rejects.toThrow(/^Unsupported conversion from \.txt to \.dwg/);
  });

  it('converts a pair without a native route in-process', async () => {
    const result = await dispatchConversion(Buffer.from('name,count\nalpha,1\nbeta,2\n'), 'csv', 'json', {}, 'in.csv');
    expect(result.engineUsed).toBe('internal-fallback');
    expect(result.mimeType).toBe('application/json');
    expect(JSON.parse(result.buffer.toString('utf-8'))).toEqual([
      { name: 'alpha', count: '1' },
      { name: 'beta', count: '2' },
    ]);
  });

  it('fails with EngineUnavailableError when spreadsheet recalculation needs a missing LibreOffice', async () => {
    const run = withMissingBinary('SOFFICE_PATH', () =>
      dispatchConversion(SAMPLE_XLSX, 'xlsx', 'pdf', { recalculate: true }, 'sample.xlsx')
    );
    await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toMatchObject({ engineName: 'soffice' });
  });

  it.skipIf(skipWithoutTools('soffice', 'pdftotext'))(
    'routes a native-capable pair to LibreOffice and returns the output in memory (needs soffice, pdftotext)',
    async () => {
      const result = await dispatchConversion(SAMPLE_DOCX, 'docx', 'pdf', {}, 'sample.docx');
      expect(result.engineUsed).toMatch(/^native-soffice/);
      expect(result.filePath).toBeUndefined();
      expect(result.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(result.size).toBe(result.buffer.length);
      expect(extractTextWithExternalPdftotext(result.buffer)).toContain(DOCX_BODY_TEXT);
    },
    120_000
  );
});
