import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import MarkdownIt from 'markdown-it';
import { convertFile } from '../src/lib/conversions';
import { convertOffice } from '../src/lib/conversions/office';
import { EngineUnavailableError, UnsupportedTargetError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';
import {
  RICH_HEADINGS,
  RICH_LIST_ITEMS,
  RICH_NOTES,
  fixtureBytes,
  richStructureImageHashes,
  richStructureTruth,
  sha256,
} from './helpers/document-fixtures';
import { overallScore, scoreStructure, structureOfHtml } from '../bench/structure-metrics';

/**
 * In-process DOCX readers (docx to html, md, txt, pdf, epub) keep the structure the document holds. The golden
 * document tests/fixtures/document/rich-structure.docx is authored by build_docx_fixtures.py from ECMA-376 markup; the
 * structure it holds is written out by hand in tests/helpers/document-fixtures.ts. The oracles are a WHATWG HTML
 * parser, markdown-it, Poppler and LibreOffice, none of which is part of the code under test.
 */

const RICH = fixtureBytes('rich-structure.docx');

async function convertToText(target: string): Promise<string> {
  return (await convertFile(RICH, 'docx', target, {}, 'rich-structure.docx')).buffer.toString('utf-8');
}

describe('docx to html keeps the document structure', () => {
  it('headings, list items, table cells, images and notes match the hand-written structure', async () => {
    const html = await convertToText('html');
    const structure = structureOfHtml(html);
    const truth = await richStructureTruth();
    expect(structure.headings).toEqual(truth.headings);
    expect(structure.listItems).toEqual(truth.listItems);
    expect(structure.tableCells).toEqual(truth.tableCells);
    expect(structure.images).toEqual(truth.images);
    expect(structure.notes).toEqual(truth.notes);
  });

  it('writes the restart, the roman start value and nested list types', async () => {
    const html = await convertToText('html');
    // Second list restarts at 1 (no start attribute), the roman list starts at III, nested levels use letters and roman numerals.
    expect(html).toMatch(/<ol type="a"><li>Isolate line/);
    expect(html).toMatch(/<ol type="i"><li>Record level/);
    expect(html).toMatch(/<ol type="I" start="3"><li>Roman list from three/);
    expect(html.match(/<ol type="1">/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('embeds the source JPEG byte for byte', async () => {
    const html = await convertToText('html');
    const { jpegBytes } = await richStructureImageHashes();
    const match = /src="data:image\/jpeg;base64,([^"]+)"/.exec(html);
    expect(match).not.toBeNull();
    expect(Buffer.from((match as RegExpExecArray)[1], 'base64').equals(jpegBytes)).toBe(true);
  });

  it('keeps the hyperlink target and the alternative text of pictures', async () => {
    const html = await convertToText('html');
    expect([...html.matchAll(/<a href="([^"]+)">([^<]*)<\/a>/g)].map((match) => [match[1], match[2]])).toEqual([['https://example.org/portal', 'the maintenance portal']]);
    expect([...html.matchAll(/<img [^>]*alt="([^"]*)"/g)].map((match) => match[1])).toEqual(['Green checker photo', 'Red and blue bars']);
  });
});

describe('docx targets the in-process engine cannot write', () => {
  it.each(['rtf', 'doc'])('%s needs LibreOffice and answers as a missing engine, not an untyped failure', async (target) => {
    const failure = await convertFile(RICH, 'docx', target, {}, 'rich-structure.docx').then(() => undefined, (err: unknown) => err);
    expect(failure).toBeInstanceOf(EngineUnavailableError);
    expect((failure as Error).message).toBe(`Engine 'soffice' is unavailable: Converting DOCX to .${target} needs the native LibreOffice engine; the in-process engine has no writer for it.`);
  });

  it('a target no engine writes is an unsupported-target error', async () => {
    const failure = await convertOffice(RICH, 'docx', 'xyz', {}, 'rich-structure.docx').then(() => undefined, (err: unknown) => err);
    expect(failure).toBeInstanceOf(UnsupportedTargetError);
    expect((failure as Error).message).toBe("Cannot convert DOCX documents to '.xyz'.");
  });
});

describe('docx to md keeps the document structure', () => {
  it('parses to the headings, nested lists, table and images of the document', async () => {
    const markdown = await convertToText('md');
    const tokens = new MarkdownIt('commonmark').enable('table').enable('strikethrough').parse(markdown, {});
    const headings = tokens
      .map((token, index) => (token.type === 'heading_open' ? `${token.tag.slice(1)}|${tokens[index + 1].content}` : null))
      .filter((entry): entry is string => entry !== null);
    expect(headings).toEqual([...RICH_HEADINGS]);

    const listItems = tokens.filter((token) => token.type === 'list_item_open');
    expect(listItems).toHaveLength(RICH_LIST_ITEMS.length);
    const nesting = tokens.filter((token) => token.type === 'ordered_list_open' || token.type === 'bullet_list_open');
    // CommonMark counts only decimal lists as ordered: the lettered and roman lists are bullets that show their marker as text.
    expect(nesting.map((token) => token.type).filter((type) => type === 'ordered_list_open')).toHaveLength(2);

    expect(tokens.filter((token) => token.type === 'table_open')).toHaveLength(1);
    const cells = tokens.filter((token) => token.type === 'th_open' || token.type === 'td_open');
    // 4 grid rows of 3 columns: merged positions are written as empty cells.
    expect(cells).toHaveLength(12);

    const inline = tokens.filter((token) => token.type === 'inline').flatMap((token) => token.children ?? []);
    expect(inline.filter((child) => child.type === 'image')).toHaveLength(2);
    expect(inline.filter((child) => child.type === 'link_open').map((child) => child.attrGet('href'))).toEqual(['https://example.org/portal']);
    for (const note of RICH_NOTES) expect(markdown).toContain(note);
  });

  it('carries the picture bytes unchanged', async () => {
    const markdown = await convertToText('md');
    const { jpegBytes } = await richStructureImageHashes();
    const match = /\(data:image\/jpeg;base64,([^)]+)\)/.exec(markdown);
    expect((match as RegExpExecArray)[1]).toBe(jpegBytes.toString('base64'));
  });
});

describe('docx to txt keeps list markers and notes', () => {
  it('writes the markers Word shows in document order', async () => {
    const text = await convertToText('txt');
    const markers = [...text.matchAll(/^\s*(1\.|2\.|a\.|b\.|i\.|3\.|•|◦|III\)|IV\)) (Inspect pumps|Check valves|Isolate line|Drain line|Record level|Close out|Restart item one|Restart item two|Bearings|Seals|Gaskets|Roman list from three|Second roman item)$/gm)];
    expect(markers.map((match) => `${match[1]} ${match[2]}`)).toEqual([
      '1. Inspect pumps',
      '2. Check valves',
      'a. Isolate line',
      'b. Drain line',
      'i. Record level',
      '3. Close out',
      '1. Restart item one',
      '2. Restart item two',
      '• Bearings',
      '◦ Seals',
      '• Gaskets',
      'III) Roman list from three',
      'IV) Second roman item',
    ]);
    expect(text).toContain('Flow figures are monthly means.');
  });
});

describe('structure against the LibreOffice conversion of the same file', () => {
  oracleTest('docx to html: precision and recall are at least the reference tool\'s', ['soffice'], async () => {
    const truth = await richStructureTruth();
    const ours = scoreStructure(truth, structureOfHtml(await convertToText('html')));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-ref-'));
    try {
      fs.writeFileSync(path.join(dir, 'rich-structure.docx'), RICH);
      execFileSync(requireOracleTool('soffice'), ['--headless', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', 'html', '--outdir', path.join(dir, 'ref'), path.join(dir, 'rich-structure.docx')], { stdio: 'ignore', timeout: 120_000 });
      const referenceHtml = fs.readFileSync(path.join(dir, 'ref', 'rich-structure.html'), 'utf-8');
      const reference = scoreStructure(truth, structureOfHtml(referenceHtml, (src) => {
        const file = path.join(dir, 'ref', src);
        return fs.existsSync(file) ? fs.readFileSync(file) : undefined;
      }));
      for (const category of Object.keys(ours) as (keyof typeof ours)[]) {
        expect(ours[category].precision, `${category} precision`).toBeGreaterThanOrEqual(reference[category].precision);
        expect(ours[category].recall, `${category} recall`).toBeGreaterThanOrEqual(reference[category].recall);
      }
      expect(overallScore(truth, structureOfHtml(await convertToText('html'))).recall).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
