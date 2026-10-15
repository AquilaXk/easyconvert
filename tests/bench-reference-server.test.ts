import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolRunError } from '../bench/errors';
import { ReferenceServer } from '../bench/reference-server';
import { defaultResolver } from '../bench/tools';
import { skipUnless } from './helpers/strict-skip';

/**
 * The reference server of the data and font families: the Python process that scores an output cell by cell against the
 * source. The scoring is the quality oracle of the data rows, so its rules are pinned here on hand-written tables: what counts
 * as the same cell (the same text, the same instant, the same boolean) and what does not (a number for a string, a missing row).
 * Only the standard library is needed for these cases.
 */

const python = defaultResolver()('python3');
const NEEDS = 'python3';

interface Check {
  readers: Record<string, { cells: number; mismatches: number; first: string | null }>;
}

describe.skipIf(skipUnless(NEEDS, python !== null))('the reference server', () => {
  let work: string;
  let server: ReferenceServer;

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-reference-server-'));
    server = ReferenceServer.start(python as string);
  });
  afterAll(async () => {
    await server.close();
    fs.rmSync(work, { recursive: true, force: true });
  });

  const write = (name: string, text: string): string => {
    const file = path.join(work, name);
    fs.writeFileSync(file, text);
    return file;
  };
  const check = async (kind: 'csv' | 'json', output: string, truth: string): Promise<Check['readers'][string]> =>
    (await server.call<Check>('data.check', { kind, file: output, truth: { kind: 'csv', file: truth } })).readers[kind];

  const TRUTH = 'id,code,name,active,ts,note\r\n1,007,"Müller, Anna",true,2024-01-01T00:00:30.000Z,\r\n2,1e4,"line one\nline two",false,2024-01-01T00:01:00.500Z,"said ""ok"""\r\n';

  it('finds no difference in an output that holds every cell of the source', async () => {
    const truth = write('truth.csv', TRUTH);
    expect(await check('csv', write('same.csv', `﻿${TRUTH}`), truth)).toEqual({ cells: 12, mismatches: 0, first: null });
    const json = [
      { id: 1, code: '007', name: 'Müller, Anna', active: true, ts: '2024-01-01T00:00:30.000Z', note: null },
      { id: 2, code: '1e4', name: 'line one\nline two', active: false, ts: '2024-01-01T00:01:00.500Z', note: 'said "ok"' },
    ];
    expect(await check('json', write('same.json', JSON.stringify(json)), truth)).toMatchObject({ mismatches: 0 });
  });

  it('counts a string that became a number, a spelling of the timestamp that is another instant, and a lost row', async () => {
    const truth = write('truth-diff.csv', TRUTH);
    const json = [
      { id: 1, code: 7, name: 'Müller, Anna', active: true, ts: '2024-01-01T00:00:30.000Z', note: null },
      { id: 2, code: 10000.0, name: 'line one\nline two', active: false, ts: '2024-01-01T00:01:00.600Z', note: 'said "ok"' },
    ];
    const result = await check('json', write('diff.json', JSON.stringify(json)), truth);
    // "007" read as 7, "1e4" read as 10000.0, and a timestamp that is 100 ms off.
    expect(result.mismatches).toBe(3);
    expect(result.first).toBe("row 0 column code: expected '007', got '7'");
    const lost = await check('json', write('lost.json', JSON.stringify(json.slice(0, 1))), truth);
    expect(lost.mismatches).toBe(1 + 6);
    expect(lost.first).toContain("expected '007', got '7'");
  });

  it('takes the same instant, the same boolean in another case and a number written as an integer for the same cell', async () => {
    const truth = write('truth-lenient.csv', 'ts,flag,n\r\n2024-01-01T00:00:30.000Z,true,3\r\n');
    const csv = write('lenient.csv', 'ts,flag,n\r\n2024-01-01 00:00:30+00,TRUE,3\r\n');
    expect(await check('csv', csv, truth)).toMatchObject({ mismatches: 0 });
    const json = write('lenient.json', JSON.stringify([{ ts: '2024-01-01T00:00:30Z', flag: true, n: 3.0 }]));
    expect(await check('json', json, truth)).toMatchObject({ mismatches: 0 });
    const other = write('other.csv', 'ts,flag,n\r\n2024-01-01 00:00:31+00,TRUE,3.5\r\n');
    expect(await check('csv', other, truth)).toMatchObject({ mismatches: 2 });
  });

  it('answers an unknown operation with a typed error naming it, and keeps serving', async () => {
    await expect(server.call('no.such.op', {})).rejects.toThrow(ToolRunError);
    await expect(server.call('no.such.op', {})).rejects.toThrow('KeyError');
    expect(await check('csv', write('again.csv', TRUTH), write('truth-again.csv', TRUTH))).toMatchObject({ mismatches: 0 });
  });

  it('refuses a call once it has been closed', async () => {
    const own = ReferenceServer.start(python as string);
    const answered = await own.call<Check>('data.check', { kind: 'csv', file: write('c1.csv', TRUTH), truth: { kind: 'csv', file: write('c2.csv', TRUTH) } });
    expect(answered.readers.csv.mismatches).toBe(0);
    await own.close();
    await expect(own.call('data.check', {})).rejects.toThrow('not running');
  });
});
