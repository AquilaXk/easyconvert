/**
 * Speed of the formula engine: per-formula evaluation and a 50,000-formula DAG pass, median of 5 warm runs.
 *   npx tsx bench/formula-speed.mts [old|new]
 * `old` needs a copy of the previous engine at src/lib/conversions/office/spreadsheet-formula-old.ts.
 */
const which = process.argv[2] === 'old' ? 'old' : 'new';
const mod = await import(
  which === 'old' ? '../src/lib/conversions/office/spreadsheet-formula-old' : '../src/lib/conversions/office/spreadsheet-formula'
);
const { SpreadsheetFormulaEvaluator, SpreadsheetDagEngine } = mod;

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
function bench(fn: () => void, runs = 5): number {
  fn(); // warm
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    fn();
    t.push(performance.now() - s);
  }
  return median(t);
}

// Audit workbook: 50 rows of A (numbers), B (decimals), C (text).
const data: Record<string, unknown> = {};
for (let r = 1; r <= 50; r++) {
  data[`A${r}`] = r;
  data[`B${r}`] = r * 2.5;
  data[`C${r}`] = `txt${r}`;
}
const ev = new SpreadsheetFormulaEvaluator((ref: string) => data[ref.replace(/\$/g, '').toUpperCase()] ?? '');
const audit = ['SUM(A1:A10)+B2*2', 'IF(A3>2,"yes","no")', 'ROUND(B4/3,2)', 'SUM(A1:A50)-AVERAGE(B1:B50)', 'VLOOKUP(5,A1:B50,2,FALSE)', 'CONCAT(C1,C2)'];
const N = 2000;
const perFormula = bench(() => {
  for (let i = 0; i < N; i++) for (const f of audit) ev.evaluate(`=${f}`);
}) / (N * audit.length);

// 50,000-formula sheet: data in A1:A50000, formulas in C.
function dagRun(): void {
  const cells: Record<string, unknown> = {};
  for (let r = 1; r <= 50_000; r++) cells[`A${r}`] = r % 97;
  const formulas: Array<{ ref: string; formula: string }> = [];
  for (let r = 1; r <= 50_000; r++) {
    const kind = r % 5;
    const formula =
      kind === 0 ? `=A${r}*2+1` : kind === 1 ? `=IF(A${r}>50,"hi","lo")` : kind === 2 ? `=SUM(A${r}:A${Math.min(r + 9, 50_000)})` : kind === 3 ? `=ROUND(A${r}/3,2)` : `=MAX(A${r},10)-MIN(A${r},5)`;
    formulas.push({ ref: `C${r}`, formula });
  }
  new SpreadsheetDagEngine(cells).evaluateWithDag(formulas);
}
const dag = bench(dagRun);
console.log(JSON.stringify({ engine: which, node: process.version, perFormulaUs: +(perFormula * 1000).toFixed(2), dag50kMs: +dag.toFixed(0) }));
