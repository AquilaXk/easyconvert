import { describe, expect, it } from 'vitest';
import { reportConversionWarning, withConversionWarnings } from '../src/lib/conversions/conversion-warnings';
import type { ConversionResult } from '../src/lib/types';

const result = (warnings?: string[]): ConversionResult => ({
  buffer: Buffer.from('x'),
  mimeType: 'text/plain',
  filename: 'x.txt',
  size: 1,
  ...(warnings ? { metadata: { warnings } } : {}),
});

describe('warnings raised inside a conversion', () => {
  it('drops a report made outside any conversion: a later conversion does not carry it', async () => {
    reportConversionWarning('nobody listens');
    const converted = await withConversionWarnings(async () => result());
    expect(converted.metadata).toBeUndefined();
  });

  it('adds each distinct line once to the warnings of the result, after the ones it already had', async () => {
    const converted = await withConversionWarnings(async () => {
      reportConversionWarning('first');
      await Promise.resolve();
      reportConversionWarning('second');
      reportConversionWarning('first');
      reportConversionWarning('kept');
      return result(['kept', 'own']);
    });
    expect(converted.metadata?.warnings).toEqual(['kept', 'own', 'first', 'second']);
  });

  it('leaves a result without reports as it is', async () => {
    const plain = result();
    expect(await withConversionWarnings(async () => plain)).toBe(plain);
  });

  it('keeps the reports of concurrent conversions apart', async () => {
    const run = (line: string): Promise<ConversionResult> =>
      withConversionWarnings(async () => {
        await new Promise((resolve) => setTimeout(resolve, line === 'a' ? 10 : 1));
        reportConversionWarning(line);
        return result();
      });
    const [a, b] = await Promise.all([run('a'), run('b')]);
    expect([a.metadata?.warnings, b.metadata?.warnings]).toEqual([['a'], ['b']]);
  });

  it('lets a nested conversion report to the outer one, which attaches the lines', async () => {
    let inner: ConversionResult | undefined;
    const outer = await withConversionWarnings(async () => {
      inner = await withConversionWarnings(async () => {
        reportConversionWarning('from inside');
        return result();
      });
      return result();
    });
    expect(inner?.metadata).toBeUndefined();
    expect(outer.metadata?.warnings).toEqual(['from inside']);
  });

  it('caps the combined warnings of the result and the scope at 200 distinct lines', async () => {
    const existing = Array.from({ length: 120 }, (_, i) => `existing-${i}`);
    const converted = await withConversionWarnings(async () => {
      for (let i = 0; i < 150; i++) reportConversionWarning(`reported-${i}`);
      return result(existing);
    });
    expect(converted.metadata?.warnings).toHaveLength(200);
    expect(converted.metadata?.warnings?.slice(0, 120)).toEqual(existing);
    expect(converted.metadata?.warnings?.slice(120)).toEqual(Array.from({ length: 80 }, (_, i) => `reported-${i}`));
  });
});
