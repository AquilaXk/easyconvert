import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions/index';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * Colour and vector shapes in the slides and the Word documents written from a PDF (entry 289). The documents are those of
 * tests/fixtures/pdf-colour, whose colours are the ones written in their sources; the packages are read by their XML.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'pdf-colour');
const STRUCTURE = path.join(__dirname, 'fixtures', 'pdf-structure');
const TEXT = path.join(__dirname, 'fixtures', 'pdf-text');

const converted = new Map<string, Promise<Buffer>>();
function convert(directory: string, name: string, target: 'pptx' | 'docx'): Promise<Buffer> {
  const key = `${directory}/${name}.${target}`;
  let result = converted.get(key);
  if (!result) {
    result = convertFile(fs.readFileSync(path.join(directory, `${name}.pdf`)), 'pdf', target, {}, `${name}.pdf`).then((out) => out.buffer);
    converted.set(key, result);
  }
  return result;
}

async function partOf(file: Buffer, entry: string): Promise<string> {
  const part = (await JSZip.loadAsync(file)).file(entry);
  if (!part) throw new Error(`the package has no ${entry}`);
  return part.async('string');
}

const slideOf = async (name: string, directory = FIXTURES): Promise<string> => partOf(await convert(directory, name, 'pptx'), 'ppt/slides/slide1.xml');
const bodyOf = async (name: string): Promise<string> => partOf(await convert(FIXTURES, name, 'docx'), 'word/document.xml');

/** The run of a slide whose text is `text`, with its properties. */
function slideRun(slide: string, text: string): string {
  // The space that follows a word is written with the word before it.
  const match = new RegExp(`<a:r><a:rPr[^>]*>(?:(?!</a:r>).)*<a:t>${text} ?</a:t></a:r>`).exec(slide);
  if (!match) throw new Error(`no run of ${text}`);
  return match[0];
}

describe('PDF to PPTX keeps colour and shapes', () => {
  it('writes the colour of each run of text and black for the rest', async () => {
    const slide = await slideOf('colour-text');
    expect(slideRun(slide, 'red lantern')).toContain('<a:srgbClr val="D32F2F"/>');
    expect(slideRun(slide, 'bright orange flare')).toContain('<a:srgbClr val="E65100"/>');
    expect(slideRun(slide, 'White on charcoal')).toContain('<a:srgbClr val="FFFFFF"/>');
    expect(slideRun(slide, 'Closing remark in the default colour.')).toContain('<a:srgbClr val="000000"/>');
  });

  it('draws the fills behind the text as rectangles that come before the text in the shape tree', async () => {
    const slide = await slideOf('colour-text');
    const fills = [...slide.matchAll(/<a:prstGeom prst="rect"><a:avLst\/><\/a:prstGeom><a:solidFill><a:srgbClr val="([0-9A-F]{6})"/g)].map((match) => match[1]);
    expect(fills).toEqual(['212121', 'FFEB3B', '1565C0']);
    expect(slide.indexOf('val="212121"')).toBeLessThan(slide.indexOf('White on charcoal'));
  });

  it('draws bars, a triangle and an ellipse with their fills and outlines', async () => {
    const slide = await slideOf('shapes-chart');
    for (const fill of ['0D47A1', '1976D2', 'E53935', '43A047', 'FB8C00']) expect(slide).toContain(`<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>`);
    // The triangle is a custom geometry with a fill and an outline; the ellipse has curves.
    expect(slide).toMatch(/<a:custGeom>.*?<a:solidFill><a:srgbClr val="CE93D8"\/>.*?<a:ln w="\d+"><a:solidFill><a:srgbClr val="4A148C"\/>/);
    expect(slide).toContain('<a:cubicBezTo>');
    // The outline of the bar that has one is lines in its colour (a producer that starts a rectangle half way along a side draws five).
    expect(slide.match(/<a:srgbClr val="8E0000"\/>/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('draws the border of a ruled table in the colour of its rules and the cells with the text colours', async () => {
    const slide = await slideOf('colour-table');
    expect(slide).toContain('<a:tbl>');
    expect(slide).toMatch(/<a:lnL w="\d+"><a:solidFill><a:srgbClr val="1F4E79"\/>/);
    expect(slideRun(slide, 'Station')).toContain('val="FFFFFF"');
    expect(slideRun(slide, '-0.4')).toContain('val="C62828"');
    // The shaded rows are rectangles behind the table.
    expect(slide.indexOf('val="E8EEF7"')).toBeLessThan(slide.indexOf('<a:tbl>'));
    const border = await slideOf('doc-02', STRUCTURE);
    expect(border).toMatch(/<a:lnL w="\d+"><a:solidFill><a:srgbClr val="808080"\/>/);
  });

  it('does not make a table of boxes that are drawn in several colours', async () => {
    const slide = await slideOf('diagram');
    expect(slide).not.toContain('<a:tbl>');
    for (const color of ['0277BD', 'EF6C00', '2E7D32', 'C62828']) expect(slide).toContain(`<a:srgbClr val="${color}"/>`);
    expect(slideRun(slide, 'Keeper')).toContain('val="E65100"');
  });

  it('draws a bar wider than a rule as a filled rectangle', async () => {
    const slide = await slideOf('colour-boxes');
    expect(slide).toMatch(/<a:prstGeom prst="rect"><a:avLst\/><\/a:prstGeom><a:solidFill><a:srgbClr val="FF8F00"\/>/);
  });

  oracleTest('every part is well-formed XML 1.0 (xmllint)', ['xmllint'], async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-colour-xml-'));
    try {
      for (const name of ['colour-text', 'shapes-chart', 'diagram']) {
        const zip = await JSZip.loadAsync(await convert(FIXTURES, name, 'pptx'));
        for (const entry of Object.keys(zip.files).filter((file) => /\.(xml|rels)$/.test(file))) {
          const file = path.join(dir, `${name}-${entry.replace(/\//g, '_')}`);
          fs.writeFileSync(file, await (zip.file(entry) as JSZip.JSZipObject).async('nodebuffer'));
          execFileSync(requireOracleTool('xmllint'), ['--noout', file]);
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PDF to DOCX keeps colour and shapes', () => {
  it('writes the colour of each run, and shades the paragraph a fill lies behind', async () => {
    const body = await bodyOf('colour-boxes');
    expect(body).toContain('<w:shd w:val="clear" w:color="auto" w:fill="263238"/>');
    expect(body).toMatch(/<w:color w:val="FFFFFF"\/>[^]*?Moorings close at dusk/);
    expect(body).toContain('w:fill="E3F2FD"');
    const text = await bodyOf('colour-text');
    expect(text).toContain('<w:color w:val="D32F2F"/>');
    expect(text).toContain('<w:color w:val="AD1457"/>');
  });

  it('leaves white text white only where its fill is carried: on the run, the paragraph or the cell', async () => {
    // The white words of colour-text sit on highlights narrower than their paragraph: each run carries its fill.
    const text = await bodyOf('colour-text');
    expect(text).toMatch(/<w:color w:val="FFFFFF"\/><w:shd w:val="clear" w:color="auto" w:fill="212121"\/><\/w:rPr><w:t xml:space="preserve">White on charcoal/);
    expect(text).toMatch(/w:fill="1565C0"\/>[^]*?White on blue/);
    // The title of shapes-chart is a running header, white on a band: the header carries the fill on the run.
    const header = await partOf(await convert(FIXTURES, 'shapes-chart', 'docx'), 'word/header1.xml');
    expect(header).toMatch(/<w:color w:val="FFFFFF"\/><w:shd w:val="clear" w:color="auto" w:fill="0D47A1"\/>/);
  });

  it('shades the cells of a table and draws its grid in the colour of the rules', async () => {
    const body = await bodyOf('colour-table');
    expect(body).toContain('w:fill="1F4E79"');
    expect(body).toContain('w:fill="E8EEF7"');
    // The second table has no rules, so the three shaded cells are not a table: their fills are shapes behind the text.
    for (const fill of ['FFF3CD', 'D4EDDA', 'F8D7DA']) expect(body).toContain(`<a:srgbClr val="${fill}"/>`);
    expect(body).toMatch(/<w:top w:val="single" w:sz="\d+" w:space="0" w:color="1F4E79"\/>/);
    expect(body).toContain('<w:color w:val="C62828"/>');
    const grey = await partOf(await convert(STRUCTURE, 'doc-02', 'docx'), 'word/document.xml');
    expect(grey).toMatch(/<w:top w:val="single" w:sz="\d+" w:space="0" w:color="808080"\/>/);
  });

  it('hangs the shapes of a chart on the document as floating drawings, a paragraph that holds the room open for each figure', async () => {
    const body = await bodyOf('shapes-chart');
    expect(body).toContain('xmlns:wps=');
    expect(body.match(/<wp:anchor /g)?.length).toBeGreaterThanOrEqual(18);
    for (const fill of ['1976D2', 'E53935', '43A047', 'FB8C00', 'CE93D8']) expect(body).toContain(`<a:srgbClr val="${fill}"/>`);
    expect(body).toContain('behindDoc="1"');
    expect(body).toContain('<a:cubicBezTo>');
    expect(body).toContain('w:lineRule="exact"');
  });

  it('turns the boxes of a diagram into shapes and keeps their text as paragraphs, with no table', async () => {
    const body = await bodyOf('diagram');
    expect(body).not.toContain('<w:tbl>');
    for (const word of ['Lantern', 'Keeper', 'Harbour']) expect(body).toContain(word);
    for (const color of ['0277BD', 'EF6C00', '2E7D32', 'C62828']) expect(body).toContain(`<a:srgbClr val="${color}"/>`);
  });

  it('draws nothing it was not given: a document in black and white has no shapes, shading or colour', async () => {
    const body = await partOf(await convert(TEXT, 'latin', 'docx'), 'word/document.xml');
    expect(body).not.toContain('<wp:anchor');
    expect(body).not.toContain('<w:shd');
    expect(body).not.toMatch(/<w:color w:val="(?!000000)/);
  });

  oracleTest('every part is well-formed XML 1.0 (xmllint)', ['xmllint'], async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-colour-docx-xml-'));
    try {
      for (const name of ['colour-boxes', 'shapes-chart', 'diagram']) {
        const zip = await JSZip.loadAsync(await convert(FIXTURES, name, 'docx'));
        for (const entry of Object.keys(zip.files).filter((file) => /\.(xml|rels)$/.test(file))) {
          const file = path.join(dir, `${name}-${entry.replace(/\//g, '_')}`);
          fs.writeFileSync(file, await (zip.file(entry) as JSZip.JSZipObject).async('nodebuffer'));
          execFileSync(requireOracleTool('xmllint'), ['--noout', file]);
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
