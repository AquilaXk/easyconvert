import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DOCUMENT_FIXTURES, fixtureBytes, sha256 } from './helpers/document-fixtures';
import { pythonModuleAvailable, runPythonHelper } from './helpers/python-oracle';
import { skipUnless } from './helpers/strict-skip';

/**
 * The golden documents are the files recorded in PROVENANCE.md, and an independent Word reader (python-docx) finds
 * the structure the hand-written expectations list.
 */

interface DocxFacts {
  headings: { style: string; text: string }[];
  tables: string[][][];
  inlineShapes: number;
}

describe('fixture provenance', () => {
  it('every .docx and .epub fixture is the file recorded in PROVENANCE.md', () => {
    const provenance = fs.readFileSync(path.join(DOCUMENT_FIXTURES, 'PROVENANCE.md'), 'utf-8');
    const recorded = new Map([...provenance.matchAll(/^\| `([^`]+\.(?:docx|epub))` \|.*\| ([0-9a-f]{64}) \|$/gm)].map((match) => [match[1], match[2]]));
    const present = fs.readdirSync(DOCUMENT_FIXTURES).filter((name) => /\.(?:docx|epub)$/.test(name)).sort();
    expect([...recorded.keys()].sort()).toEqual(present);
    for (const name of present) expect(sha256(fixtureBytes(name)), name).toBe(recorded.get(name));
  });
});

describe.skipIf(skipUnless('python-docx', pythonModuleAvailable('docx')))('python-docx reads the golden documents', () => {
  it('rich-structure.docx has the headings, table and pictures the expectations list', () => {
    const facts = runPythonHelper<DocxFacts>('docx_facts.py', [path.join(DOCUMENT_FIXTURES, 'rich-structure.docx')]);
    expect(facts.headings.map((heading) => `${heading.style}|${heading.text}`)).toEqual([
      'Title|Pump Station Handbook',
      'Heading 1|1 Overview',
      'Heading 2|Scope',
      'Heading 2|Readings',
      'Heading 1|2 Images',
    ]);
    expect(facts.tables).toHaveLength(1);
    expect(facts.tables[0][0]).toEqual(['Station', 'Flow rate|span=2', 'Flow rate|span=2']);
    expect(facts.inlineShapes).toBe(2);
  });

  it('merged-tables.docx is a single four-row table', () => {
    const facts = runPythonHelper<DocxFacts>('docx_facts.py', [path.join(DOCUMENT_FIXTURES, 'merged-tables.docx')]);
    expect(facts.tables).toHaveLength(1);
    expect(facts.tables[0]).toHaveLength(4);
  });
});
