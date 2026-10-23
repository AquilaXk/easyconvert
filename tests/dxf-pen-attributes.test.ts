import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultResolver, EZDXF_PSEUDO_TOOL } from '../bench/tools';
import { MAX_DASH_ARRAY_CHARACTERS, MAX_DASH_VALUES } from '../src/lib/conversions/svg-pen';
import { encodeSvgPageToDxf, MAX_DASH_LINETYPES } from '../src/lib/conversions/vector-dxf';
import { readDxf, type DxfDocument } from './helpers/dxf-reader';
import { skipUnless } from './helpers/strict-skip';

/**
 * Pen attributes the DXF writer cannot hold. It writes the centre line of every stroke as LINE and POLYLINE entities, and a
 * DXF holds no stroke width, opacity or paint, so a page is not refused for them. The reference exporters agree: Inkscape's
 * dxf_outlines.py (`process_shape`) transforms the path and reads no width, dash, opacity or clip, and pstoedit's DXF
 * drivers write the dash pattern only as a line type (drvdxf.cpp `writeColorAndStyle`, drvbase.cpp `guess_linetype`).
 * A dash array is the one attribute a DXF holds, as an LTYPE table entry (ezdxf entities/ltype.py) named by the entities.
 */

const PAGE_WIDTH = 200;
const PAGE_HEIGHT = 100;
const HOSTILE_BUDGET_MS = 3000;

function page(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" viewBox="0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}">${body}</svg>`;
}

const stroked = (attributes: string, d = 'M 10 10 L 110 10'): string => `<path fill="none" stroke="rgb(0%, 0%, 0%)" d="${d}" ${attributes}/>`;

function dxfOf(body: string): DxfDocument {
  return readDxf(encodeSvgPageToDxf(Buffer.from(page(body))).toString('utf-8'));
}

const refusal = (body: string): string => {
  try {
    encodeSvgPageToDxf(Buffer.from(page(body)));
    return 'converted';
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
};

const PYTHON_WITH_EZDXF = defaultResolver()(EZDXF_PSEUDO_TOOL);

/** What ezdxf reads of a file, one line of JSON: the audit's errors, and for each entity its linetype and that linetype's compiled pattern (dash, gap, ...; empty for a solid line). */
const EZDXF_READ = `
import json, sys, ezdxf
document = ezdxf.readfile(sys.argv[1])
auditor = document.audit()
entities = [[e.dxftype(), e.dxf.linetype, list(document.linetypes.get(e.dxf.linetype).pattern_tags.compile()) if e.dxf.linetype in document.linetypes else None] for e in document.modelspace()]
print(json.dumps({"errors": len(auditor.errors), "entities": entities}))
`;

function ezdxfRead(dxf: string): { errors: number; entities: [string, string, number[] | null][] } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dxf-pen-'));
  try {
    const file = path.join(directory, 'page.dxf');
    fs.writeFileSync(file, dxf);
    return JSON.parse(execFileSync(PYTHON_WITH_EZDXF as string, ['-I', '-c', EZDXF_READ, file], { encoding: 'utf-8' }));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** The linetypes the page defines besides CONTINUOUS, which every writer output holds. */
const dashTypes = (dxf: DxfDocument) => dxf.linetypes.filter((type) => type.name !== 'CONTINUOUS');

describe('stroke-dasharray', () => {
  it('is written as a line type of the same pattern, which the entity names', () => {
    const dxf = dxfOf(stroked('stroke-dasharray="6 2"'));
    const [type] = dashTypes(dxf);
    expect(dashTypes(dxf)).toHaveLength(1);
    expect(type.elements).toEqual([6, -2]);
    expect(type.patternLength).toBe(8);
    expect(dxf.entities).toHaveLength(1);
    expect(dxf.entities[0].type).toBe('LINE');
    expect(dxf.entities[0].linetype).toBe(type.name);
  });

  it.skipIf(skipUnless('python3 and ezdxf', PYTHON_WITH_EZDXF !== null))('is read back by ezdxf as the same dashes, and audits without errors', () => {
    const body = `${stroked('stroke-dasharray="6 2"')}${stroked('stroke-dasharray="4 2 1 2"', 'M 10 20 L 60 20 L 60 50 Z')}${stroked('', 'M 10 60 L 110 60')}`;
    const read = ezdxfRead(encodeSvgPageToDxf(Buffer.from(page(body))).toString('utf-8'));
    expect(read.errors).toBe(0);
    expect(read.entities.map(([type, , pattern]) => [type, pattern])).toEqual([
      ['LINE', [6, 2]],
      ['POLYLINE', [4, 2, 1, 2]],
      ['LINE', []],
    ]);
  });

  it('keeps the solid line type for strokes without a pattern', () => {
    const dxf = dxfOf(`${stroked('stroke-dasharray="none"')}${stroked('')}`);
    expect(dashTypes(dxf)).toHaveLength(0);
    expect(dxf.entities.map((entity) => entity.linetype)).toEqual(['BYLAYER', 'BYLAYER']);
    expect(dxf.linetypes.map((type) => type.name)).toEqual(['CONTINUOUS']);
  });

  it('scales the pattern by the transform of the stroke', () => {
    const dxf = dxfOf(`<g transform="scale(2)">${stroked('stroke-dasharray="6 2"')}</g>`);
    expect(dashTypes(dxf)[0].elements).toEqual([12, -4]);
  });

  it('repeats a pattern of an odd length, as SVG 1.1 section 11.4 says', () => {
    expect(dashTypes(dxfOf(stroked('stroke-dasharray="4 2 1"')))[0].elements).toEqual([4, -2, 1, -4, 2, -1]);
  });

  it('separates numbers by commas, spaces or both', () => {
    for (const list of ['4,2', '4 , 2', ' 4   2 ', '4 ,2']) {
      expect(dashTypes(dxfOf(stroked(`stroke-dasharray="${list}"`)))[0].elements, list).toEqual([4, -2]);
    }
  });

  it('is inherited from a group and cancelled by none on a descendant', () => {
    const dxf = dxfOf(`<g stroke-dasharray="3 1">${stroked('')}${stroked('stroke-dasharray="none"', 'M 10 20 L 110 20')}${stroked('style="stroke-dasharray: 5 5"', 'M 10 30 L 110 30')}</g>`);
    expect(dashTypes(dxf).map((type) => type.elements)).toEqual([[3, -1], [5, -5]]);
    expect(dxf.entities.map((entity) => entity.linetype === 'BYLAYER')).toEqual([false, true, false]);
  });

  it('defines equal patterns once', () => {
    const dxf = dxfOf(`${stroked('stroke-dasharray="6 2"')}${stroked('stroke-dasharray="6,2"', 'M 10 20 L 110 20')}${stroked('stroke-dasharray="1 1"', 'M 10 30 L 110 30')}`);
    expect(dashTypes(dxf)).toHaveLength(2);
    expect(dxf.entities[0].linetype).toBe(dxf.entities[1].linetype);
    expect(dxf.entities[2].linetype).not.toBe(dxf.entities[0].linetype);
  });

  it('lets a polyline run its pattern on across the vertices, which AutoCAD does only when the polyline says so', () => {
    const dxf = dxfOf(`${stroked('stroke-dasharray="6 2"', 'M 10 10 L 60 10 L 60 50')}${stroked('', 'M 10 60 L 60 60 L 60 90')}${stroked('stroke-dasharray="6 2"', 'M 100 10 L 150 10 L 150 50 Z')}`);
    expect(dxf.entities.map((entity) => entity.type)).toEqual(['POLYLINE', 'POLYLINE', 'POLYLINE']);
    expect(dxf.entities.map((entity) => entity.linetypeGenerated)).toEqual([true, false, true]);
    expect(dxf.entities[2].closed).toBe(true);
  });

  it('applies to the strokes of a shape, not to a shape that is only filled', () => {
    const dxf = dxfOf('<rect x="10" y="10" width="50" height="30" fill="#000" stroke="none" stroke-dasharray="6 2"/>');
    expect(dashTypes(dxf)).toHaveLength(0);
    expect(dxf.entities[0].linetype).toBe('BYLAYER');
  });

  it('is solid when every length is zero or the dashes run into one another', () => {
    for (const list of ['0 0', '0', '5 0', '5 0 5 0', '0, 0, 0']) {
      expect(dashTypes(dxfOf(stroked(`stroke-dasharray="${list}"`))), list).toHaveLength(0);
    }
  });

  it('drops the zero-length gaps between dashes and the dashes that a butt cap does not draw', () => {
    expect(dashTypes(dxfOf(stroked('stroke-dasharray="4 0 2 3"')))[0].elements).toEqual([6, -3]);
    expect(dashTypes(dxfOf(stroked('stroke-dasharray="0 3 5 2"')))[0].elements).toEqual([5, -5]);
  });

  it('keeps a zero-length dash as a dot when the cap is round or square, which draws it', () => {
    expect(dashTypes(dxfOf(stroked('stroke-linecap="round" stroke-dasharray="0 4"')))[0].elements).toEqual([0, -4]);
    expect(dashTypes(dxfOf(stroked('stroke-linecap="square" stroke-dasharray="0 4"')))[0].elements).toEqual([0, -4]);
  });

  it('refuses a pattern whose dashes all draw nothing instead of drawing the line solid', () => {
    expect(refusal(stroked('stroke-dasharray="0 4"'))).toMatch(/ConversionFailedError: The page cannot be written as DXF: .*draws nothing/);
  });

  it('starts at its first dash: the offset is a phase that a line type does not hold', () => {
    const dxf = dxfOf(stroked('stroke-dasharray="6 2" stroke-dashoffset="3"'));
    expect(dashTypes(dxf)[0].elements).toEqual([6, -2]);
  });

  describe('hostile arrays', () => {
    it(`refuses more than ${MAX_DASH_VALUES} lengths, the most a line type of AutoCAD holds, and an odd list that repeats past it`, () => {
      expect(MAX_DASH_VALUES).toBe(12);
      const list = (count: number): string => Array.from({ length: count }, (_, k) => (k % 2 === 0 ? '3' : '1')).join(' ');
      expect(dashTypes(dxfOf(stroked(`stroke-dasharray="${list(MAX_DASH_VALUES)}"`)))[0].elements).toHaveLength(MAX_DASH_VALUES);
      expect(dashTypes(dxfOf(stroked(`stroke-dasharray="${list(MAX_DASH_VALUES / 2 - 1)}"`)))).toHaveLength(1);
      expect(refusal(stroked(`stroke-dasharray="${list(MAX_DASH_VALUES + 1)}"`))).toMatch(/ConversionFailedError: The page cannot be written as DXF: .*at most 12/);
      expect(refusal(stroked(`stroke-dasharray="${list(MAX_DASH_VALUES / 2 + 1)}"`))).toMatch(/ConversionFailedError: The page cannot be written as DXF: .*at most 12/);
    });

    it('refuses an array of a million lengths inside the budget, without reading them', () => {
      const started = Date.now();
      const result = refusal(stroked(`stroke-dasharray="${'1 '.repeat(1_000_000)}"`));
      expect(result).toMatch(/ConversionFailedError: The page cannot be written as DXF: .*longer than 1024 characters/);
      expect(Date.now() - started).toBeLessThan(HOSTILE_BUDGET_MS);
    });

    it(`reads a value of ${MAX_DASH_ARRAY_CHARACTERS} characters and refuses a longer one before reading it`, () => {
      expect(MAX_DASH_ARRAY_CHARACTERS).toBe(1024);
      const padded = (length: number): string => `4${' '.repeat(length - 2)}2`;
      expect(dashTypes(dxfOf(stroked(`stroke-dasharray="${padded(MAX_DASH_ARRAY_CHARACTERS)}"`)))[0].elements).toEqual([4, -2]);
      expect(refusal(stroked(`stroke-dasharray="${padded(MAX_DASH_ARRAY_CHARACTERS + 1)}"`))).toMatch(/ConversionFailedError: The page cannot be written as DXF: .*longer than 1024 characters/);
      const started = Date.now();
      expect(refusal(stroked(`stroke-dasharray="${padded(4_000_000)}"`))).toMatch(/longer than 1024 characters/);
      expect(Date.now() - started).toBeLessThan(HOSTILE_BUDGET_MS);
    });

    it('refuses a value of megabytes on a shape used thousands of times at its first use', () => {
      const uses = Array.from({ length: 2000 }, (_, k) => `<use href="#d" y="${k % 90}"/>`).join('');
      const started = Date.now();
      expect(refusal(`<defs>${stroked(`id="d" stroke-dasharray="4${' '.repeat(3_000_000)}2"`)}</defs>${uses}`)).toMatch(/longer than 1024 characters/);
      expect(Date.now() - started).toBeLessThan(HOSTILE_BUDGET_MS);
    });

    it.each([
      ['a negative length', '-1 2'],
      ['a negative gap', '2 -1'],
      ['not a number', 'NaN 1'],
      ['a word', 'dashed'],
      ['Infinity', 'Infinity 1'],
      ['a number past the range of a double', '1e999 1'],
      ['a percentage', '5% 5%'],
      ['a relative unit', '2em 1em'],
      ['an absolute unit, which only plain numbers of user units are', '6pt 2pt'],
      ['hexadecimal digits', '0x4 2'],
      ['an empty entry between commas', '4,,2'],
    ])('refuses %s', (_name, list) => {
      expect(refusal(stroked(`stroke-dasharray="${list}"`)), list).toMatch(/^(ConversionFailedError|CadGeometryUnavailableError|UnsupportedOptionError): /);
      expect(refusal(stroked(`stroke-dasharray="${list}"`)), list).not.toBe('converted');
    });

    it('refuses a length that is finite in the file and not on the page', () => {
      expect(refusal(`<g transform="scale(1e300)">${stroked('stroke-dasharray="1e300 1"')}</g>`)).not.toBe('converted');
    });

    it('refuses a pattern whose length is past the numbers a DXF holds, without writing Infinity or an exponent', () => {
      const result = refusal(stroked('stroke-dasharray="1e308 1e308"'));
      expect(result).toMatch(/^CadGeometryUnavailableError: /);
      expect(result).not.toMatch(/Infinity|e\+/);
    });

    it('refuses a coordinate that is not written as a plain decimal', () => {
      const result = refusal(stroked('', 'M 1e22 10 L 1e22 20'));
      expect(result).toMatch(/^CadGeometryUnavailableError: /);
      expect(result).not.toMatch(/e\+/);
    });

    it('writes a pattern too small to see as a solid line', () => {
      expect(dashTypes(dxfOf(stroked('stroke-dasharray="1e-300 1e-300"')))).toHaveLength(0);
      expect(dashTypes(dxfOf(stroked('stroke-dasharray="1e-9 1e-9"')))).toHaveLength(0);
    });

    it(`refuses a document of more than ${MAX_DASH_LINETYPES} distinct patterns, and writes ${MAX_DASH_LINETYPES}`, () => {
      const patterns = (count: number): string => Array.from({ length: count }, (_, k) => stroked(`stroke-dasharray="1 ${k + 1}"`, `M 10 ${(k % 90) + 5} L 110 ${(k % 90) + 5}`)).join('');
      expect(dashTypes(dxfOf(patterns(MAX_DASH_LINETYPES)))).toHaveLength(MAX_DASH_LINETYPES);
      const started = Date.now();
      expect(refusal(patterns(MAX_DASH_LINETYPES + 1))).toMatch(new RegExp(`ConversionFailedError: The page cannot be written as DXF: .*more than ${MAX_DASH_LINETYPES}`));
      expect(Date.now() - started).toBeLessThan(HOSTILE_BUDGET_MS);
    });

    it('writes thirty thousand uses of one dashed shape with one line type', () => {
      const uses = Array.from({ length: 30_000 }, (_, k) => `<use href="#d" x="${k % 100}" y="${Math.floor(k / 1000)}"/>`).join('');
      const started = Date.now();
      const dxf = dxfOf(`<defs>${stroked('id="d" stroke-dasharray="3 1 2 1"', 'M 0 0 L 20 0 L 20 20')}</defs>${uses}`);
      expect(dxf.entities).toHaveLength(30_000);
      expect(dashTypes(dxf)).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(HOSTILE_BUDGET_MS * 2);
    });
  });
});

describe('strokes under a transform with unequal scales or a skew', () => {
  const corner = 'M 0 0 L 10 0 L 10 10';

  it.each([
    ['scale(2 1)', [[0, 100], [20, 100], [20, 90]]],
    ['skewX(45)', [[0, 100], [10, 100], [20, 90]]],
    ['matrix(1 0.5 0 1 0 0)', [[0, 100], [10, 95], [10, 85]]],
  ])('writes the centre line of the stroke at the transformed points (%s)', (transform, expected) => {
    const dxf = dxfOf(stroked(`transform="${transform}"`, corner));
    expect(dxf.entities).toHaveLength(1);
    expect(dxf.entities[0].points.map((point) => [point.x, point.y])).toEqual(expected);
  });

  it('writes the page-wide scale of a viewBox that stretches the drawing', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 100 100" preserveAspectRatio="none">${stroked('', corner)}</svg>`;
    const dxf = readDxf(encodeSvgPageToDxf(Buffer.from(svg)).toString('utf-8'));
    expect(dxf.entities[0].points.map((point) => [point.x, point.y])).toEqual([[0, 100], [20, 100], [20, 90]]);
  });

  it('sizes a dash by the square root of the area scale of the transform, one length for every direction', () => {
    const dxf = dxfOf(`<g transform="scale(4 1)">${stroked('stroke-dasharray="2 2"')}</g>`);
    expect(dashTypes(dxf)[0].elements).toEqual([4, -4]);
  });
});

describe('opacity', () => {
  const plain = dxfOf('<rect x="10" y="10" width="50" height="30" fill="#000" stroke="#f00"/>');

  it.each([
    ['opacity', 'opacity="0.5"'],
    ['fill-opacity', 'fill-opacity="0.2"'],
    ['stroke-opacity', 'stroke-opacity="0"'],
    ['a style declaration', 'style="opacity: 50%; fill-opacity: 0.1; stroke-opacity: 0.3"'],
  ])('is dropped, as the references drop it: %s', (_name, attribute) => {
    const dxf = dxfOf(`<rect x="10" y="10" width="50" height="30" fill="#000" stroke="#f00" ${attribute}/>`);
    expect(dxf.entities).toEqual(plain.entities);
  });

  it('is dropped on a group, which every shape below it inherits', () => {
    const dxf = dxfOf('<g opacity="0.5"><rect x="10" y="10" width="50" height="30" fill="#000" stroke="#f00"/></g>');
    expect(dxf.entities).toEqual(plain.entities);
  });
});

describe('what the DXF writer still refuses', () => {
  it.each([
    ['a picture (policy 42)', '<image x="0" y="0" width="10" height="10" href="data:image/png;base64,iVBORw0KGgo="/>', /SVG element <image> is not supported/],
    ['a clip that is not the page', '<clipPath id="c"><rect x="0" y="0" width="50" height="50"/></clipPath><rect width="100" height="100" clip-path="url(#c)"/>', /clip-path/],
    ['a mask', '<mask id="m"><rect width="10" height="10"/></mask><rect width="100" height="100" mask="url(#m)"/>', /mask/],
    ['paint-order', '<rect width="10" height="10" stroke="#000" paint-order="stroke"/>', /paint-order/],
    ['mix-blend-mode', '<rect width="10" height="10" style="mix-blend-mode: multiply"/>', /mix-blend-mode/],
    ['vector-effect', '<rect width="10" height="10" stroke="#000" vector-effect="non-scaling-stroke"/>', /vector-effect/],
    ['a semi-transparent colour', '<rect width="10" height="10" fill="rgba(0,0,0,0.5)"/>', /Semi-transparent/],
  ])('%s', (_name, body, message) => {
    expect(refusal(body)).toMatch(message);
    expect(refusal(body)).not.toBe('converted');
  });
});
