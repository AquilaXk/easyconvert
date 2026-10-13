import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { sanitizeSvgDocument, sanitizeSvgString } from '../src/lib/security/svg-sanitizer';
import { convertVectorCad } from '../src/lib/conversions/vector-cad';
import { normalizeSvgForRendering } from '../src/lib/conversions/svg-geometry';

async function pixelAt(pngBuffer: Buffer, x: number, y: number): Promise<[number, number, number, number]> {
  const { data, info } = await sharp(pngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const idx = (y * info.width + x) * info.channels;
  return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
}

describe('SVG embedded <image> sanitization and rendering (#746)', () => {
  it('preserves a safe embedded SVG on <image> and strips dangerous markup inside the embedded SVG', async () => {
    const dirtyInnerSvg =
      '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' +
      '<script>alert(1)</script>' +
      '<rect x="0" y="0" width="40" height="40" fill="#ff8800" onclick="evil()"/>' +
      '<a href="javascript:alert(1)"><circle cx="20" cy="20" r="10" fill="#0044ff"/></a>' +
      '</svg>';
    const outerSvg =
      '<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
      `<image x="10" y="10" width="60" height="60" xlink:href="data:image/svg+xml;base64,\n${Buffer.from(dirtyInnerSvg, 'utf-8').toString('base64')}"/>` +
      '</svg>';

    const sanitized = sanitizeSvgDocument(outerSvg);
    expect(sanitized).toContain('xlink:href="data:image/svg+xml;base64,');
    const match = /data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/.exec(sanitized);
    expect(match).not.toBeNull();
    const decodedInner = Buffer.from(match![1], 'base64').toString('utf-8');
    expect(decodedInner).not.toContain('<script');
    expect(decodedInner).not.toContain('onload');
    expect(decodedInner).not.toContain('onclick');
    expect(decodedInner).not.toContain('javascript:');
    expect(decodedInner).toContain('href="#"');
    expect(decodedInner).toContain('fill="#ff8800"');

    // Idempotent fixed-point check
    expect(sanitizeSvgDocument(sanitized)).toBe(sanitized);

    const rendered = await convertVectorCad(Buffer.from(outerSvg, 'utf-8'), 'svg', 'png', { dpi: 72 }, 'embedded.svg');
    const center = await pixelAt(rendered.buffer, 40, 40);
    expect(center[2]).toBeGreaterThan(200);
    expect(center[3]).toBe(255);
    const corner = await pixelAt(rendered.buffer, 20, 20);
    expect(corner[0]).toBeGreaterThan(200);
    expect(corner[1]).toBeGreaterThan(100);
  });

  it('keeps blocking data:image/svg+xml on non-<image> elements and rejects non-SVG payloads', () => {
    const innerB64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>').toString('base64');
    expect(sanitizeSvgString(`<svg><a href="data:image/svg+xml;base64,${innerB64}"/></svg>`)).toBe('<svg><a href="#"/></svg>');
    expect(sanitizeSvgString(`<svg><use xlink:href="data:image/svg+xml;base64,${innerB64}"/></svg>`)).toBe('<svg><use href="#"/></svg>');
    expect(sanitizeSvgString('<svg><image href="data:image/svg+xml;base64,bm90LWFuLXN2Zw=="/></svg>')).toBe('<svg><image href="#"/></svg>');
  });
});

describe('SVG physical CSS units at 96 px/in (#746)', () => {
  it('renders mm attributes at 96 px/in inside viewBox even when rasterized at 72 dpi', async () => {
    const svg =
      '<svg id="svg1" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">' +
      '<rect id="rect1" x="5mm" y="5mm" width="44mm" height="44mm" rx="6mm" fill="#008000"/>' +
      '</svg>';

    const res = await convertVectorCad(Buffer.from(svg, 'utf-8'), 'svg', 'png', { dpi: 72 }, 'mm-values.svg');
    // 5mm + 44mm = 49mm -> 49 * 96 / 25.4 = 185.197 user units.
    // At 72 px/in (unfixed), the rect ended at 49 * 72 / 25.4 = 138.9 user units, leaving (165, 100) transparent.
    const insideRight = await pixelAt(res.buffer, 165, 100);
    expect(insideRight[1]).toBeGreaterThan(100);
    expect(insideRight[3]).toBe(255);

    const outsideRight = await pixelAt(res.buffer, 192, 100);
    expect(outsideRight[3]).toBe(0);
  });
});

describe('SVG clipPath with clip-path on children (#746)', () => {
  it('renders the union of clipped child shapes inside <clipPath>', async () => {
    const svg = `<svg id="svg1" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
      <clipPath id="clip2">
        <circle id="circle1" cx="100" cy="100" r="60"/>
      </clipPath>
      <clipPath id="clip1">
        <path id="path1" d="M 100 15 l 50 160 l -130 -100 l 160 0 l -130 100 z" clip-rule="evenodd"
              clip-path="url(#clip2)"/>
        <rect id="rect1" x="50" y="50" width="100" height="100" clip-path="url(#clip2)"
              transform="scale(0.25) translate(300 300)"/>
      </clipPath>
      <rect id="rect2" x="0" y="0" width="200" height="200" fill="#008000" clip-path="url(#clip1)"/>
    </svg>`;

    const normalized = normalizeSvgForRendering(svg);
    expect(normalized).toContain('<mask id="clip1"');
    expect(normalized).toContain('mask="url(#clip1)"');

    const res = await convertVectorCad(Buffer.from(svg, 'utf-8'), 'svg', 'png', { dpi: 72 }, 'clip-children.svg');
    // Top lobe of the star path inside clip2 (100, 55): green
    const topStarLobe = await pixelAt(res.buffer, 100, 55);
    expect(topStarLobe[1]).toBeGreaterThan(100);
    expect(topStarLobe[3]).toBe(255);

    // Center of the evenodd star hole covered by the second child rect1 [87.5..112.5, 87.5..112.5] at (95, 95):
    // must be green in the union (librsvg without lowering left the star's evenodd hole empty or dropped path1).
    const rectInStarHole = await pixelAt(res.buffer, 95, 95);
    expect(rectInStarHole[1]).toBeGreaterThan(100);
    expect(rectInStarHole[3]).toBe(255);

    // Upper-left of the star hole not covered by rect1 (82, 95): must remain unclipped/transparent
    const uncoveredHole = await pixelAt(res.buffer, 82, 95);
    expect(uncoveredHole[3]).toBe(0);
  });
});
