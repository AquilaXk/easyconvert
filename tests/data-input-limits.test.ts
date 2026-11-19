import { afterAll, describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { PayloadLimitError } from '../src/lib/types';
import { DATA_SOURCE_LIMITS } from '../src/lib/conversions/data-limits';
import { shutdownCpuPool } from '../src/lib/workers/cpu-pool';

/**
 * The structured-data converters read the whole input into JavaScript values, so a small hostile text can ask for gigabytes
 * (`- 1` lines, empty `{}` objects, a row of commas) and a large honest one keeps the event loop busy for seconds. Each source
 * has an input size and an item count past which it is refused as an input over the limit, and a text of 64 KiB or more is
 * converted on a CPU pool thread.
 */
const MIB = 1024 * 1024;
const TICK_INTERVAL_MS = 5;
const MIN_TICKS = 5;

async function refusal(input: Buffer, src: string, tgt: string): Promise<PayloadLimitError> {
  const outcome = await convertFile(input, src, tgt, {}, `input.${src}`).then(
    () => null,
    (error: unknown) => error
  );
  expect(outcome).toBeInstanceOf(PayloadLimitError);
  return outcome as PayloadLimitError;
}

describe('structured-data input limits', () => {
  afterAll(() => shutdownCpuPool());

  it.each([
    ['YAML over its size', Buffer.from('- 1\n'.repeat((8 * MIB) / 4 + 1)), 'yaml', 'json'],
    ['YAML over its item count', Buffer.from('- 1\n'.repeat(524_289)), 'yaml', 'json'],
    ['TOML over its size', Buffer.from(`a = "${'x'.repeat(8 * MIB)}"\n`), 'toml', 'json'],
    ['JSON over its size', Buffer.from(`["${'x'.repeat(32 * MIB)}"]`), 'json', 'yaml'],
    ['JSON over its structural count', Buffer.from(`[${'{},'.repeat(DATA_SOURCE_LIMITS.json.maxItems / 2 + 1)}{}]`), 'json', 'csv'],
    ['NDJSON over its structural count', Buffer.from('{}\n'.repeat(DATA_SOURCE_LIMITS.ndjson.maxItems / 2 + 1)), 'ndjson', 'json'],
    ['XML over its element count', Buffer.from(`<r>${'<a/>'.repeat(DATA_SOURCE_LIMITS.xml.maxItems + 1)}</r>`), 'xml', 'json'],
    ['CSV of commas over its item count', Buffer.alloc(DATA_SOURCE_LIMITS.delimited.maxItems + 1, ','), 'csv', 'json'],
    ['CSV over its record count', Buffer.from('a\n'.repeat(DATA_SOURCE_LIMITS.delimited.maxItems + 1)), 'csv', 'json'],
    ['CSV over its size', Buffer.from(`a\n${'x'.repeat(32 * MIB)}`), 'csv', 'json'],
  ] as const)('refuses %s as an input over the limit', async (_name, input, src, tgt) => {
    const error = await refusal(input, src, tgt);
    expect(error.status).toBe(413);
    expect(error.refusalCode).toBe('input_over_limit');
  });

  it('keeps the position of a parse error that a pool thread found', async () => {
    const lines = Array.from({ length: 8000 }, (_, i) => `{"id":${i},"name":"item ${i}","note":"${'n'.repeat(20)}"}`);
    lines[5000] = '{"id": }';
    const error = await convertFile(Buffer.from(lines.join('\n')), 'ndjson', 'json', {}, 'rows.ndjson').catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'DataParseError', refusalCode: 'malformed_input', line: 5001 });
  });

  it('reports the warnings of a conversion that a pool thread ran', async () => {
    const rows = ['a,b,c', ...Array.from({ length: 6000 }, (_, i) => `${i},item ${i},${'z'.repeat(20)}`), '1,2'];
    const result = await convertFile(Buffer.from(rows.join('\n')), 'csv', 'json', {}, 'rows.csv');
    expect(String(result.metadata?.warnings)).toMatch(/fewer fields/);
  });

  it('leaves the event loop free while a large table converts', async () => {
    const rows = ['id,name,note', ...Array.from({ length: 600_000 }, (_, i) => `${i},item ${i},some note text ${i}`)];
    const input = Buffer.from(rows.join('\n'));
    expect(input.length).toBeGreaterThan(16 * MIB);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, TICK_INTERVAL_MS);
    try {
      await convertFile(input, 'csv', 'json', {}, 'rows.csv');
    } finally {
      clearInterval(timer);
    }
    // On the calling thread the parse is one block, and the timer fires once at most when it ends.
    expect(ticks).toBeGreaterThan(MIN_TICKS);
  }, 120_000);
});
