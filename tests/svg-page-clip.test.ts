import { describe, expect, it } from 'vitest';
import { encodeSvgPageToDxf } from '../src/lib/conversions/vector-dxf';
import { parseSvgGeometries } from '../src/lib/conversions/svg-geometry';
import { readDxf } from './helpers/dxf-reader';

/**
 * A clip path that is one axis-aligned rectangle covering the whole page clips nothing, so the geometry readers drop it;
 * every other clip stays refused, because dropping it would draw what the clip hides. Office suites clip every page they
 * export to the page rectangle, and Poppler writes that as `clip-path` in the SVG of the page.
 */

const PAGE_WIDTH = 200;
const PAGE_HEIGHT = 100;
const BOX_PATH = 'M 20 20 L 80 20 L 80 60 L 20 60 Z';

function page(clip: string, drawn: string, body = `<path d="${BOX_PATH}" fill="red"/>`): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" viewBox="0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}">` +
    `<defs>${clip}</defs>${drawn.replace('$BODY', body)}</svg>`
  );
}

const clippedGroup = (id: string): string => `<g clip-path="url(#${id})">$BODY</g>`;
const pathClip = (id: string, d: string): string => `<clipPath id="${id}"><path clip-rule="nonzero" d="${d}"/></clipPath>`;

/** What Poppler writes for a page of an office-suite export: the page rectangle, a little short of the page on each side. */
const PAGE_RECTANGLE = 'M 0 0.1 L 199.7 0.1 L 199.7 99.8 L 0 99.8 Z M 0 0.1';

describe('a clip path that covers the whole page', () => {
  it('is dropped by the geometry reader: the drawing under it is read whole', () => {
    const parsed = parseSvgGeometries(page(pathClip('c', PAGE_RECTANGLE), clippedGroup('c')));
    expect(parsed.elements).toHaveLength(1);
    expect(parsed.elements[0].subpaths[0].map((p) => [p.x, p.y])).toEqual([
      [20, 20],
      [80, 20],
      [80, 60],
      [20, 60],
      [20, 20],
    ]);
  });

  it('is dropped when it is a <rect> element of exactly the page', () => {
    const clip = `<clipPath id="c"><rect x="0" y="0" width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}"/></clipPath>`;
    expect(parseSvgGeometries(page(clip, clippedGroup('c'))).elements).toHaveLength(1);
  });

  it('is dropped when a transform that scales the group makes it cover the page in device space', () => {
    const clip = pathClip('c', 'M 0 0 L 400 0 L 400 200 L 0 200 Z');
    const parsed = parseSvgGeometries(page(clip, '<g transform="scale(0.5)" clip-path="url(#c)">$BODY</g>'));
    expect(parsed.elements).toHaveLength(1);
  });

  it('lets the DXF writer write the page: the box is a closed polyline with its corners flipped to a Y axis pointing up', () => {
    const dxf = readDxf(encodeSvgPageToDxf(Buffer.from(page(pathClip('c', PAGE_RECTANGLE), clippedGroup('c')))).toString('utf-8'));
    expect(dxf.entities).toHaveLength(1);
    expect(dxf.entities[0].closed).toBe(true);
    expect(dxf.entities[0].points.map((p) => [p.x, p.y])).toEqual([
      [20, 80],
      [80, 80],
      [80, 40],
      [20, 40],
    ]);
  });
});

describe('a clip path that clips something stays refused', () => {
  const refused = (clip: string, drawn = clippedGroup('c')): void => {
    expect(() => parseSvgGeometries(page(clip, drawn))).toThrow(/clip-path "url\(#c\)" is not supported/);
  };

  it('a rectangle smaller than the page', () => {
    refused(pathClip('c', 'M 10 10 L 150 10 L 150 90 L 10 90 Z'));
  });

  it('a rectangle that covers the width of the page but not its height', () => {
    refused(pathClip('c', 'M 0 0 L 200 0 L 200 50 L 0 50 Z'));
  });

  it('a rectangle that covers the page in the group it is declared in but not after the group scales it down', () => {
    refused(pathClip('c', `M 0 0 L ${PAGE_WIDTH} 0 L ${PAGE_WIDTH} ${PAGE_HEIGHT} L 0 ${PAGE_HEIGHT} Z`), '<g transform="scale(0.5)" clip-path="url(#c)">$BODY</g>');
  });

  it('a triangle that spans the page', () => {
    refused(pathClip('c', 'M 0 0 L 200 0 L 200 100 Z'));
  });

  it('a path with a curved side', () => {
    refused(pathClip('c', 'M 0 0 L 200 0 C 210 50 210 50 200 100 L 0 100 Z'));
  });

  it('a rectangle with rounded corners', () => {
    refused(`<clipPath id="c"><rect x="0" y="0" width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" rx="20"/></clipPath>`);
  });

  it('two shapes that together cover the page', () => {
    refused(`<clipPath id="c"><rect width="100" height="100"/><rect x="100" width="100" height="100"/></clipPath>`);
  });

  it('a page rectangle that is itself transformed', () => {
    refused(`<clipPath id="c" transform="rotate(10)"><rect width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}"/></clipPath>`);
  });

  it('a clip on the root element, which is not a group the page is drawn in', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" clip-path="url(#c)"><defs>${pathClip('c', PAGE_RECTANGLE)}</defs><path d="${BOX_PATH}"/></svg>`;
    expect(() => parseSvgGeometries(svg)).toThrow(/clip-path "url\(#c\)" is not supported/);
  });

  it('a reference to a clip path that does not exist', () => {
    refused('', clippedGroup('c'));
  });

  it('is refused by the DXF writer with the reason', () => {
    expect(() => encodeSvgPageToDxf(Buffer.from(page(pathClip('c', 'M 10 10 L 150 10 L 150 90 L 10 90 Z'), clippedGroup('c'))))).toThrow(
      /The page cannot be written as DXF: SVG clip-path "url\(#c\)" is not supported\./
    );
  });
});
