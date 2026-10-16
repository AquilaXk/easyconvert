import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCodeSmellGuard, type SmellEntry } from '../scripts/guard-code-smells';

/** ESLint start-up dominates each case; the default 5 s fails on a loaded CI shard. */
const GUARD_TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: GUARD_TEST_TIMEOUT_MS });

const BASELINE_FILE = path.join('.github', 'code-smell-baseline.json');

/** Four parameters over a limit of six cannot trip; seven can: this function has exactly one max-params violation. */
const SEVEN_PARAMETERS = 'export function wide(a: number, b: number, c: number, d: number, e: number, f: number, g: number) { return a + b + c + d + e + f + g; }\n';
const CLEAN_FUNCTION = 'export function narrow(a: number) { return a; }\n';

describe('code smell ratchet guard (#774)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'smell-guard-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const writeSource = (name: string, content: string): void => fs.writeFileSync(path.join(root, 'src', name), content);
  const run = (update = false, allowGrowth = false): Promise<number> => runCodeSmellGuard({ root, update, allowGrowth });
  const readBaseline = (): SmellEntry[] => JSON.parse(fs.readFileSync(path.join(root, BASELINE_FILE), 'utf-8'));
  const errorOutput = (): string => vi.mocked(console.error).mock.calls.map((call) => call.join(' ')).join('\n');

  async function baselineWith(source: string): Promise<void> {
    writeSource('a.ts', source);
    expect(await run(true, true)).toBe(0);
  }

  it('records a known violation under file, rule and function, with its measured value', async () => {
    await baselineWith(SEVEN_PARAMETERS);
    expect(readBaseline()).toEqual([{ file: 'src/a.ts', rule: 'max-params', function: 'wide', count: 1, maxValue: 7 }]);
  });

  it('passes when the code matches the baseline', async () => {
    await baselineWith(SEVEN_PARAMETERS);
    expect(await run()).toBe(0);
  });

  it('fails when a count rises, naming file, function, rule and measured value', async () => {
    await baselineWith('export function f(x: any) { return x; }\n');
    writeSource('a.ts', 'export function f(x: any, y: any) { return [x, y]; }\n');
    expect(await run()).toBe(1);
    expect(errorOutput()).toMatch(/GREW src\/a\.ts :: f :: @typescript-eslint\/no-explicit-any \(count 2\)/);
  });

  it('fails when a measured value rises with the count unchanged', async () => {
    await baselineWith(SEVEN_PARAMETERS);
    writeSource('a.ts', SEVEN_PARAMETERS.replace('g: number)', 'g: number, h: number)'));
    expect(await run()).toBe(1);
    expect(errorOutput()).toMatch(/GREW src\/a\.ts :: wide :: max-params \(count 1, worst measured 8\)/);
  });

  it('fails on a new function with a violation and on a new file', async () => {
    await baselineWith(SEVEN_PARAMETERS);
    writeSource('a.ts', SEVEN_PARAMETERS + 'export const other = (a: number) => (a ? (a > 1 ? 1 : 2) : 3);\n');
    expect(await run()).toBe(1);
    expect(errorOutput()).toMatch(/NEW {2}src\/a\.ts :: other :: no-nested-ternary/);

    writeSource('a.ts', SEVEN_PARAMETERS);
    writeSource('b.ts', SEVEN_PARAMETERS);
    expect(await run()).toBe(1);
    expect(errorOutput()).toMatch(/NEW {2}src\/b\.ts :: wide :: max-params/);
  });

  it('keeps keys stable when lines are inserted above the violation', async () => {
    await baselineWith(SEVEN_PARAMETERS);
    writeSource('a.ts', `\n\n// unrelated comment\nconst unrelated = 1;\n\n${SEVEN_PARAMETERS}`);
    expect(await run()).toBe(0);
  });

  it('attributes a violation in an anonymous callback to the named function around it', async () => {
    await baselineWith('export function outer(items: unknown[]) { return items.map((item: any) => item); }\n');
    expect(readBaseline()).toEqual([
      { file: 'src/a.ts', rule: '@typescript-eslint/no-explicit-any', function: 'outer', count: 1 },
    ]);
  });

  it('ignores inline eslint-disable comments', async () => {
    writeSource('a.ts', '// eslint-disable-next-line @typescript-eslint/no-explicit-any\nexport const value: any = 1;\n');
    expect(await run()).toBe(1);
    expect(errorOutput()).toMatch(/NEW {2}src\/a\.ts :: <module> :: @typescript-eslint\/no-explicit-any/);
  });

  it('fails when a violation is removed without updating the baseline, and passes after --update', async () => {
    await baselineWith(SEVEN_PARAMETERS);
    writeSource('a.ts', CLEAN_FUNCTION);
    expect(await run()).toBe(1);
    expect(errorOutput()).toMatch(/GONE src\/a\.ts :: wide :: max-params/);
    expect(await run(true)).toBe(0);
    expect(readBaseline()).toEqual([]);
    expect(await run()).toBe(0);
  });

  it('refuses to raise the baseline with --update unless growth is allowed', async () => {
    await baselineWith(SEVEN_PARAMETERS);
    writeSource('b.ts', SEVEN_PARAMETERS);
    expect(await run(true)).toBe(1);
    expect(readBaseline()).toHaveLength(1);
  });

  it('preserves a recorded reason through --update', async () => {
    await baselineWith(SEVEN_PARAMETERS + 'export function two(x: any) { return x; }\n');
    const entries = readBaseline().map((entry) => (entry.function === 'wide' ? { ...entry, reason: 'hot codec loop' } : entry));
    fs.writeFileSync(path.join(root, BASELINE_FILE), JSON.stringify(entries));
    writeSource('a.ts', SEVEN_PARAMETERS);
    expect(await run(true)).toBe(0);
    expect(readBaseline()).toEqual([{ file: 'src/a.ts', rule: 'max-params', function: 'wide', count: 1, maxValue: 7, reason: 'hot codec loop' }]);
  });

  it('reports a file above the line limit as a module-level entry', async () => {
    writeSource('big.ts', 'export const x = 1;\n'.repeat(1501));
    expect(await run(true, true)).toBe(0);
    expect(readBaseline()).toEqual([{ file: 'src/big.ts', rule: 'max-lines', function: '<module>', count: 1, maxValue: 1501 }]);
  });
});
