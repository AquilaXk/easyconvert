/**
 * Input grid and formulas of the formula oracle. `generate.mts` writes them as one workbook without cached values,
 * lets LibreOffice recalculate it and stores the values in `expected.json`; `tests/spreadsheet-formula-oracle.test.ts`
 * evaluates the same cells with the formula engine and compares.
 *
 * Every formula sits in column `H` (row = index + 1). The inputs stay in `A` to `G`, so no range reads a formula cell.
 */
export type OracleInput = number | string | boolean;

/** Cell inputs by A1 reference. A reference that is not listed is an empty cell. */
export const ORACLE_INPUTS: Record<string, OracleInput> = (() => {
  const cells: Record<string, OracleInput> = {};
  for (let r = 1; r <= 10; r++) {
    cells[`A${r}`] = r;
    cells[`B${r}`] = r * 2.5;
  }
  const words = ['apple', 'Banana', 'cherry', 'apple', '  Date ', 'elder', 'fig', 'Grape', 'hello world', 'x1'];
  words.forEach((w, i) => {
    cells[`C${i + 1}`] = w;
  });
  // Mixed column: number, number kept as text, text, text, empty (D5), negative, decimal, empty (D8).
  cells.D1 = 10;
  cells.D2 = '20';
  cells.D3 = 'x';
  cells.D4 = 'abc';
  cells.D6 = -3;
  cells.D7 = 4.5;
  // Dates as serial numbers: 2020-01-01 + 31 * n.
  for (let r = 1; r <= 5; r++) cells[`E${r}`] = 43831 + 31 * (r - 1);
  // Sorted keys with labels, for lookups.
  [10, 20, 30, 40, 50].forEach((v, i) => {
    cells[`F${i + 1}`] = v;
    cells[`G${i + 1}`] = String.fromCharCode(97 + i);
  });
  // Cash flows for IRR.
  [-1000, 300, 400, 500, 200].forEach((v, i) => {
    cells[`I${i + 1}`] = v;
  });
  // Booleans: LibreOffice counts a boolean cell inside a range as 1 where Excel skips it, so ranges that hold one are kept apart.
  cells.J1 = true;
  cells.J2 = 2;
  cells.F7 = 'k';
  cells.G7 = 'seven';
  return cells;
})();

export interface OracleFormula {
  /** Stable name of the case, `<group>-<function or topic>`. */
  id: string;
  formula: string;
}

const f = (id: string, formula: string): OracleFormula => ({ id, formula });

export const ORACLE_FORMULAS: OracleFormula[] = [
  // Arithmetic and coercion.
  f('op-precedence', '1+2*3^2'),
  f('op-unary-minus-power', '-2^2'),
  f('op-percent', '50%+1'),
  f('op-div-zero', '1/0'),
  f('op-concat-number', '"a"&1&TRUE'),
  f('op-text-number-add', '"2"+3'),
  f('op-text-number-bad', '"x"+1'),
  f('op-bool-add', 'TRUE+TRUE'),
  f('op-empty-cell-add', 'A1+Z99'),
  f('op-compare-text-number', '"a">1'),
  f('op-compare-case', '"A"="a"'),
  f('op-compare-numbers', 'A3>=3'),
  f('op-ne', 'A3<>3'),
  // Math.
  f('math-sum-range', 'SUM(A1:A10)'),
  f('math-sum-mixed', 'SUM(D1:D8)'),
  f('math-sum-text-literal', 'SUM("5",A1)'),
  f('math-sum-bool-literal', 'SUM(TRUE,A1)'),
  f('math-sum-empty', 'SUM(Y1:Y5)'),
  f('math-sum-error-arg', 'SUM(A1,1/0)'),
  f('math-product', 'PRODUCT(A1:A5)'),
  f('math-sumproduct', 'SUMPRODUCT(A1:A5,B1:B5)'),
  f('math-sumsq', 'SUMSQ(A1:A3)'),
  f('math-abs', 'ABS(-4.5)'),
  f('math-round', 'ROUND(2.675,2)'),
  f('math-round-neg', 'ROUND(-1.5,0)'),
  f('math-round-digits-neg', 'ROUND(1234.5,-2)'),
  f('math-roundup', 'ROUNDUP(3.14159,3)'),
  f('math-rounddown', 'ROUNDDOWN(-3.99,0)'),
  f('math-int', 'INT(-7.8)'),
  f('math-trunc', 'TRUNC(7.89,1)'),
  f('math-mod', 'MOD(-10,3)'),
  f('math-mod-zero', 'MOD(5,0)'),
  f('math-power', 'POWER(2,10)'),
  f('math-sqrt', 'SQRT(144)'),
  f('math-sqrt-neg', 'SQRT(-1)'),
  f('math-exp', 'EXP(1)'),
  f('math-ln', 'LN(10)'),
  f('math-log', 'LOG(8,2)'),
  f('math-log10', 'LOG10(1000)'),
  f('math-ceiling', 'CEILING(2.1,0.5)'),
  f('math-floor', 'FLOOR(2.9,0.5)'),
  f('math-sign', 'SIGN(-9)'),
  f('math-pi', 'PI()'),
  f('math-fact', 'FACT(6)'),
  f('math-gcd', 'GCD(12,18)'),
  f('math-lcm', 'LCM(4,6)'),
  f('math-mround', 'MROUND(10,3)'),
  f('math-quotient', 'QUOTIENT(7,2)'),
  f('math-even', 'EVEN(3)'),
  f('math-odd', 'ODD(2)'),
  f('math-combin', 'COMBIN(5,2)'),
  f('math-sin', 'SIN(0.5)'),
  f('math-cos', 'COS(0.5)'),
  f('math-atan2', 'ATAN2(1,2)'),
  f('math-degrees', 'DEGREES(PI())'),
  // Statistics.
  f('stat-average', 'AVERAGE(B1:B20)'),
  f('stat-average-mixed', 'AVERAGE(D1:D8)'),
  f('stat-average-empty', 'AVERAGE(Y1:Y5)'),
  f('stat-count', 'COUNT(D1:D8)'),
  f('stat-sum-bool-range', 'SUM(J1:J2)'),
  f('stat-count-bool-range', 'COUNT(J1:J2)'),
  f('stat-counta', 'COUNTA(A1:D10)'),
  f('stat-countblank', 'COUNTBLANK(D1:D8)'),
  f('stat-max', 'MAX(A1:A10)'),
  f('stat-max-mixed', 'MAX(D1:D8)'),
  f('stat-max-empty', 'MAX(Y1:Y5)'),
  f('stat-max-text-literal', 'MAX("30",A1)'),
  f('stat-min', 'MIN(B1:B10)'),
  f('stat-min-mixed', 'MIN(D1:D8)'),
  f('stat-min-empty', 'MIN(Y1:Y5)'),
  f('stat-median', 'MEDIAN(A1:A10)'),
  f('stat-median-even-mixed', 'MEDIAN(D1:D8)'),
  f('stat-mode', 'MODE(1,2,2,3)'),
  f('stat-stdev', 'STDEV(A1:A10)'),
  f('stat-stdev-s', '_xlfn.STDEV.S(B1:B10)'),
  f('stat-stdev-p', '_xlfn.STDEV.P(A1:A10)'),
  f('stat-var', 'VAR(A1:A10)'),
  f('stat-var-p', 'VARP(A1:A10)'),
  f('stat-large', 'LARGE(A1:A10,2)'),
  f('stat-small', 'SMALL(B1:B10,3)'),
  f('stat-rank', 'RANK(5,A1:A10)'),
  f('stat-rank-asc', 'RANK(5,A1:A10,1)'),
  f('stat-percentile', 'PERCENTILE(A1:A10,0.9)'),
  f('stat-quartile', 'QUARTILE(A1:A10,1)'),
  f('stat-correl', 'CORREL(A1:A10,B1:B10)'),
  f('stat-slope', 'SLOPE(B1:B10,A1:A10)'),
  f('stat-intercept', 'INTERCEPT(B1:B10,A1:A10)'),
  f('stat-geomean', 'GEOMEAN(A1:A5)'),
  f('stat-maxifs', '_xlfn.MAXIFS(B1:B10,A1:A10,"<=4")'),
  f('stat-minifs', '_xlfn.MINIFS(B1:B10,A1:A10,">=4")'),
  // Criteria strings.
  f('crit-countif-gt', 'COUNTIF(A1:A10,">5")'),
  f('crit-countif-ge', 'COUNTIF(A1:A10,">=5")'),
  f('crit-countif-ne', 'COUNTIF(A1:A10,"<>3")'),
  f('crit-countif-eq-number', 'COUNTIF(A1:A10,3)'),
  f('crit-countif-eq-text-number', 'COUNTIF(D1:D8,"20")'),
  f('crit-countif-text', 'COUNTIF(C1:C10,"apple")'),
  f('crit-countif-case', 'COUNTIF(C1:C10,"BANANA")'),
  f('crit-countif-wild-star', 'COUNTIF(C1:C10,"*e")'),
  f('crit-countif-wild-q', 'COUNTIF(C1:C10,"?ig")'),
  f('crit-countif-blank', 'COUNTIF(D1:D8,"")'),
  f('crit-countif-nonblank', 'COUNTIF(D1:D8,"<>")'),
  f('crit-countif-bool', 'COUNTIF(J1:J2,TRUE)'),
  f('crit-countif-cell', 'COUNTIF(A1:A10,A3)'),
  f('crit-countifs', 'COUNTIFS(A1:A10,">2",A1:A10,"<8")'),
  f('crit-sumif', 'SUMIF(A1:A10,">3",B1:B10)'),
  f('crit-sumif-same-range', 'SUMIF(A1:A10,">8")'),
  f('crit-sumif-text', 'SUMIF(C1:C10,"apple",A1:A10)'),
  f('crit-sumifs', 'SUMIFS(B1:B10,A1:A10,">3",A1:A10,"<9")'),
  f('crit-sumifs-text', 'SUMIFS(A1:A10,C1:C10,"apple",B1:B10,">2")'),
  f('crit-averageif', 'AVERAGEIF(A1:A10,">5")'),
  f('crit-averageif-nomatch', 'AVERAGEIF(A1:A10,">50")'),
  f('crit-averageifs', 'AVERAGEIFS(B1:B10,A1:A10,">2",A1:A10,"<6")'),
  // Logical.
  f('logic-if', 'IF(A3>2,"yes","no")'),
  f('logic-if-no-else', 'IF(A3>5,"yes")'),
  f('logic-if-text-cond', 'IF("x","a","b")'),
  f('logic-if-number-cond', 'IF(0,"a","b")'),
  f('logic-if-nested', 'IF(A1>5,"hi",IF(A1>0,"mid","lo"))'),
  f('logic-ifs', '_xlfn.IFS(A1>5,"big",A1>0,"small")'),
  f('logic-switch', '_xlfn.SWITCH(A2,1,"one",2,"two","other")'),
  f('logic-choose', 'CHOOSE(2,"a","b","c")'),
  f('logic-and', 'AND(A1>0,A2>0)'),
  f('logic-and-range', 'AND(A1:A3)'),
  f('logic-and-text', 'AND(A1,"x")'),
  f('logic-or', 'OR(A1>5,A2>5)'),
  f('logic-not', 'NOT(A1>5)'),
  f('logic-xor', '_xlfn.XOR(TRUE,TRUE,TRUE)'),
  f('logic-iferror-div', 'IFERROR(1/0,"err")'),
  f('logic-iferror-ok', 'IFERROR(A1,"err")'),
  f('logic-iferror-na', 'IFERROR(MATCH(99,A1:A10,0),"none")'),
  f('logic-ifna', '_xlfn.IFNA(MATCH(99,A1:A10,0),"na")'),
  f('logic-true', 'TRUE()'),
  // Information.
  f('info-isblank', 'ISBLANK(Z99)'),
  f('info-isblank-empty-string', 'ISBLANK("")'),
  f('info-isnumber', 'ISNUMBER(D2)'),
  f('info-istext', 'ISTEXT(D2)'),
  f('info-iserror', 'ISERROR(1/0)'),
  f('info-isna', 'ISNA(NA())'),
  f('info-islogical', 'ISLOGICAL(J1)'),
  f('info-iseven', 'ISEVEN(A2)'),
  f('info-isodd', 'ISODD(A2)'),
  f('info-n', 'N(J1)'),
  f('info-na', 'NA()'),
  // Text.
  f('text-len', 'LEN(C9)'),
  f('text-len-number', 'LEN(12345)'),
  f('text-upper', 'UPPER(C3)'),
  f('text-lower', 'LOWER(C2)'),
  f('text-proper', 'PROPER(C9)'),
  f('text-trim', 'TRIM(C5)'),
  f('text-left', 'LEFT(C9,5)'),
  f('text-left-default', 'LEFT(C1)'),
  f('text-right', 'RIGHT(C9,5)'),
  f('text-mid', 'MID(C9,7,3)'),
  f('text-mid-past-end', 'MID(C1,10,3)'),
  f('text-concat', '_xlfn.CONCAT(C1,C2)'),
  f('text-concat-range', '_xlfn.CONCAT(A1:A3)'),
  f('text-concatenate', 'CONCATENATE(C1,"-",C2)'),
  f('text-textjoin', '_xlfn.TEXTJOIN(",",TRUE,C1:C3)'),
  f('text-textjoin-empty', '_xlfn.TEXTJOIN("-",FALSE,D1:D8)'),
  f('text-find', 'FIND("l",C9)'),
  f('text-find-case', 'FIND("L",C9)'),
  f('text-find-missing', 'FIND("z",C9)'),
  f('text-search', 'SEARCH("L",C9)'),
  f('text-search-wild', 'SEARCH("h*o",C9)'),
  f('text-substitute', 'SUBSTITUTE(C9,"l","L")'),
  f('text-substitute-nth', 'SUBSTITUTE(C9,"l","L",2)'),
  f('text-replace', 'REPLACE(C9,1,5,"bye")'),
  f('text-rept', 'REPT("ab",3)'),
  f('text-text-number', 'TEXT(1234.5,"0.00")'),
  f('text-text-thousands', 'TEXT(1234567.891,"#,##0.0")'),
  f('text-text-percent', 'TEXT(0.256,"0%")'),
  f('text-text-date', 'TEXT(43831,"yyyy-mm-dd")'),
  f('text-value', 'VALUE("12.5")'),
  f('text-value-bad', 'VALUE("abc")'),
  f('text-exact', 'EXACT(C1,"APPLE")'),
  f('text-char', 'CHAR(65)'),
  f('text-code', 'CODE("A")'),
  f('text-clean-trim-len', 'LEN(TRIM(C5))'),
  f('text-numbervalue', '_xlfn.NUMBERVALUE("1.234,5",",",".")'),
  // Lookup and reference.
  f('lookup-vlookup-exact', 'VLOOKUP(30,F1:G5,2,FALSE)'),
  f('lookup-vlookup-exact-missing', 'VLOOKUP(35,F1:G5,2,FALSE)'),
  f('lookup-vlookup-approx', 'VLOOKUP(35,F1:G5,2,TRUE)'),
  f('lookup-vlookup-approx-below', 'VLOOKUP(5,F1:G5,2,TRUE)'),
  f('lookup-vlookup-default', 'VLOOKUP(50,F1:G5,2)'),
  f('lookup-vlookup-col-out', 'VLOOKUP(30,F1:G5,3,FALSE)'),
  f('lookup-vlookup-text', 'VLOOKUP("apple",C1:D10,2,FALSE)'),
  f('lookup-vlookup-text-case', 'VLOOKUP("BANANA",C1:D10,1,FALSE)'),
  f('lookup-vlookup-text-number', 'VLOOKUP("20",D1:D8,1,FALSE)'),
  f('lookup-hlookup', 'HLOOKUP(2.5,A1:C2,2,FALSE)'),
  f('lookup-index', 'INDEX(A1:B10,3,2)'),
  f('lookup-index-col', 'INDEX(A1:A10,4)'),
  f('lookup-index-out', 'INDEX(A1:B10,11,1)'),
  f('lookup-match-exact', 'MATCH(7,A1:A10,0)'),
  f('lookup-match-missing', 'MATCH(99,A1:A10,0)'),
  f('lookup-match-asc', 'MATCH(35,F1:F5,1)'),
  f('lookup-match-text', 'MATCH("cherry",C1:C10,0)'),
  f('lookup-match-text-case', 'MATCH("CHERRY",C1:C10,0)'),
  f('lookup-match-wild', 'MATCH("ch*",C1:C10,0)'),
  f('lookup-lookup', 'LOOKUP(35,F1:F5,G1:G5)'),
  f('lookup-xlookup', '_xlfn.XLOOKUP(30,F1:F5,G1:G5)'),
  f('lookup-xlookup-missing', '_xlfn.XLOOKUP(35,F1:F5,G1:G5)'),
  f('lookup-xlookup-default', '_xlfn.XLOOKUP(35,F1:F5,G1:G5,"none")'),
  f('lookup-xlookup-next-smaller', '_xlfn.XLOOKUP(35,F1:F5,G1:G5,"none",-1)'),
  f('lookup-xlookup-next-larger', '_xlfn.XLOOKUP(35,F1:F5,G1:G5,"none",1)'),
  f('lookup-xlookup-wild', '_xlfn.XLOOKUP("ch*",C1:C10,A1:A10,"none",2)'),
  f('lookup-xlookup-last', '_xlfn.XLOOKUP("apple",C1:C10,A1:A10,"none",0,-1)'),
  f('lookup-xmatch', '_xlfn.XMATCH(30,F1:F5)'),
  f('lookup-row', 'ROW(C7)'),
  f('lookup-column', 'COLUMN(C7)'),
  f('lookup-rows', 'ROWS(A1:B10)'),
  f('lookup-columns', 'COLUMNS(A1:D1)'),
  // Dates.
  f('date-date', 'DATE(2020,5,17)'),
  f('date-date-overflow', 'DATE(2020,14,35)'),
  f('date-year', 'YEAR(E3)'),
  f('date-month', 'MONTH(E3)'),
  f('date-day', 'DAY(E3)'),
  f('date-year-of-date', 'YEAR(DATE(2021,12,31))'),
  f('date-weekday', 'WEEKDAY(E1)'),
  f('date-weekday-mode2', 'WEEKDAY(E1,2)'),
  f('date-diff', 'E3-E1'),
  f('date-days', '_xlfn.DAYS(E3,E1)'),
  f('date-edate', 'EDATE(E1,1)'),
  f('date-eomonth', 'EOMONTH(E1,1)'),
  f('date-datevalue', 'DATEVALUE("2020-03-15")'),
  f('date-time', 'TIME(6,30,0)'),
  f('date-hour', 'HOUR(0.75)'),
  f('date-networkdays', 'NETWORKDAYS(E1,E2)'),
  f('date-datedif', 'DATEDIF(E1,E5,"d")'),
  f('date-yearfrac', 'YEARFRAC(E1,E5,1)'),
  f('date-weeknum', 'WEEKNUM(E3)'),
  // Financial.
  f('fin-pmt', 'PMT(0.05/12,60,10000)'),
  f('fin-fv', 'FV(0.06/12,12,-100)'),
  f('fin-pv', 'PV(0.08/12,24,-500)'),
  f('fin-npv', 'NPV(0.1,100,200,300)'),
  f('fin-irr', 'IRR(I1:I5)'),
  f('fin-nper', 'NPER(0.01,-100,1000)'),
  f('fin-rate', 'RATE(60,-200,10000)'),
  f('fin-ipmt', 'IPMT(0.05/12,1,60,10000)'),
  f('fin-ppmt', 'PPMT(0.05/12,1,60,10000)'),
  f('fin-sln', 'SLN(10000,1000,5)'),
  f('fin-db', 'DB(10000,1000,5,1)'),
  // Errors and edge cases.
  f('err-na-propagates', 'NA()+1'),
  f('err-error-in-range-sum', 'SUM(A1:A3,NA())'),
  f('err-nested-iferror', 'IFERROR(IFERROR(1/0,2/0),"inner")'),
  f('err-unknown-function', 'NOSUCHFUNCTION(1)'),
  f('err-ref-text-arithmetic', 'C1*2'),
  f('err-empty-compare', 'Z99=0'),
  f('err-empty-text-compare', 'Z99=""'),
];
