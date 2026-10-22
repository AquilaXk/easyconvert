import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Checks the numbering of docs/policy-decisions.md: headings, contents rows and their order.
const DEFAULT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'policy-decisions.md');
const HEADING = /^## (\d+)\. (.+)$/;
const CONTENTS_START = /^## Contents\s*$/;
const CONTENTS_END = /^(---|## )/;
const ROW = /^(\d+)\. \[(.+)\]\(#([^)]+)\)$/;

/** GitHub's anchor for a heading text: lower case, punctuation dropped, spaces and hyphens kept. */
export function anchorOf(number, title) {
  const slug = `${number}. ${title}`
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, '')
    .replace(/ /g, '-');
  return slug;
}

function readHeadings(lines) {
  const headings = [];
  lines.forEach((text, index) => {
    const match = HEADING.exec(text);
    if (match) headings.push({ number: Number(match[1]), title: match[2], line: index + 1 });
  });
  return headings;
}

function readRows(lines) {
  const start = lines.findIndex((text) => CONTENTS_START.test(text));
  if (start === -1) return { rows: [], found: false };
  const rows = [];
  let group = '';
  for (let index = start + 1; index < lines.length && !CONTENTS_END.test(lines[index]); index++) {
    const text = lines[index].trim();
    if (text === '') continue;
    const match = ROW.exec(text);
    if (match) rows.push({ number: Number(match[1]), title: match[2], anchor: match[3], group, line: index + 1 });
    else group = text;
  }
  return { rows, found: true };
}

function duplicates(items, describe) {
  const seen = new Map();
  const faults = [];
  for (const item of items) {
    const first = seen.get(item.number);
    if (first) faults.push(describe(item, first));
    else seen.set(item.number, item);
  }
  return faults;
}

function rowFaults(row, heading) {
  const faults = [];
  if (row.title !== heading.title) {
    faults.push(`line ${row.line}: the row for ${row.number} reads "${row.title}" but the heading on line ${heading.line} reads "${heading.title}"`);
  }
  const anchor = anchorOf(heading.number, heading.title);
  if (row.anchor !== anchor) {
    faults.push(`line ${row.line}: the row for ${row.number} links to #${row.anchor} but the heading on line ${heading.line} is #${anchor}`);
  }
  return faults;
}

function orderFaults(rows) {
  const faults = [];
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1];
    const row = rows[index];
    if (row.group === previous.group && row.number < previous.number) {
      faults.push(`line ${row.line}: row ${row.number} follows row ${previous.number} in the group "${row.group}"`);
    }
  }
  return faults;
}

/** Every numbering fault of a policy document, as a list of sentences; empty when the numbering is sound. */
export function policyNumberingFaults(markdown) {
  const lines = markdown.split(/\r?\n/);
  const headings = readHeadings(lines);
  const { rows, found } = readRows(lines);
  if (!found) return ['the document has no "## Contents" section'];

  const faults = [
    ...duplicates(headings, (heading, first) => `line ${heading.line}: entry number ${heading.number} is already used by the heading on line ${first.line}`),
    ...duplicates(rows, (row, first) => `line ${row.line}: the contents list ${row.number} twice (first on line ${first.line})`),
  ];
  const headingByNumber = new Map(headings.map((heading) => [heading.number, heading]));
  const rowNumbers = new Set(rows.map((row) => row.number));
  for (const heading of headings) {
    if (!rowNumbers.has(heading.number)) faults.push(`line ${heading.line}: entry ${heading.number} has no row in the contents`);
  }
  for (const row of rows) {
    const heading = headingByNumber.get(row.number);
    if (heading) faults.push(...rowFaults(row, heading));
    else faults.push(`line ${row.line}: the contents list ${row.number} but no heading has that number`);
  }
  return [...faults, ...orderFaults(rows)];
}

function main() {
  const file = process.argv[2] ?? DEFAULT_FILE;
  const faults = policyNumberingFaults(fs.readFileSync(file, 'utf8'));
  if (faults.length === 0) {
    console.log(`${path.relative(process.cwd(), file)}: numbering and contents are consistent`);
    return;
  }
  for (const fault of faults) console.error(`${path.relative(process.cwd(), file)}:${fault}`);
  console.error(`\n${faults.length} numbering fault(s). Take the next free number on origin/main and keep the contents rows in order within their group.`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
