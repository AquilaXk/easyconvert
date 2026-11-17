import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { encodeIcns, encodeIco } from '../src/lib/conversions/image';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';
import { cleanAlphaEdgesInPlace } from '../src/lib/conversions/raster-vectorize-alpha';
import {
  sanitizeVectorizeOptions,
  vectorizeArgs,
  vectorizeOptionsProblem,
} from '../src/lib/conversions/raster-vectorize-options';
import {
  compactHexColor,
  compactSplinePathData,
  compactTracedSvg,
} from '../src/lib/conversions/raster-vectorize-svg';
import { captureError } from './helpers/capture-error';
import { runWithoutFileConfinement } from './helpers/unconfined-files';

runWithoutFileConfinement();

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function standInTracer(): { program: string; stagedCopy: string; ran: () => boolean } {
  const dir = tmpDir('vec-opt-standin-');
  const marker = path.join(dir, 'ran');
  const stagedCopy = path.join(dir, 'staged.rgba');
  const program = path.join(dir, 'vtracer-pixels');
  const parse = 'in=""; out=""; for a in "$@"; do case "$prev" in --input) in="$a";; --output) out="$a";; esac; prev="$a"; done';
  const body = [
    '#!/bin/sh',
    parse,
    `touch '${marker}'`,
    `cp "$in" '${stagedCopy}'`,
    `printf '%s\\n' '<?xml version="1.0" encoding="UTF-8"?>' '<!-- Generator: visioncortex VTracer 1.0.0-alpha.4 -->' '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="16" height="16">' '<path d="M0,0C5,0,11,0,16,0c0,5,0,11,0,16c-5,0-11,0-16,0C0,11,0,5,0,0Z" fill="#FF0000"/>' '</svg>' > "$out"`,
  ].join('\n');
  fs.writeFileSync(program, `${body}\n`, { mode: 0o755 });
  return { program, stagedCopy, ran: () => fs.existsSync(marker) };
}

async function withPixelsTracer<T>(program: string, fn: () => Promise<T>): Promise<T> {
  const prevPixels = process.env.VTRACER_PIXELS_PATH;
  const prevTracer = process.env.VTRACER_PATH;
  process.env.VTRACER_PIXELS_PATH = program;
  process.env.VTRACER_PATH = '';
  try {
    return await fn();
  } finally {
    if (prevPixels === undefined) delete process.env.VTRACER_PIXELS_PATH;
    else process.env.VTRACER_PIXELS_PATH = prevPixels;
    if (prevTracer === undefined) delete process.env.VTRACER_PATH;
    else process.env.VTRACER_PATH = prevTracer;
  }
}

describe('cleanAlphaEdgesInPlace (32-bit word fast-path + 3-4 Chamfer edge decontamination)', () => {
  it('leaves opaque and uniform semi-transparent overlays untouched in one pass', () => {
    const opaque = Uint8Array.from([200, 40, 40, 255, 10, 20, 30, 255]);
    cleanAlphaEdgesInPlace(opaque, 2, 1);
    expect([...opaque]).toEqual([200, 40, 40, 255, 10, 20, 30, 255]);

    const overlay = Uint8Array.from([200, 40, 40, 128, 90, 90, 90, 180]);
    cleanAlphaEdgesInPlace(overlay, 2, 1);
    expect([...overlay]).toEqual([200, 40, 40, 128, 90, 90, 90, 180]);
  });

  it('snaps near-zero alpha dust (< 20) to zero and restores premultiplied-black anti-aliased fringes', () => {
    // 4x1 row: [transparent dust a=12, premultiplied white fringe (128,128,128,128), opaque white (255,255,255,255), colored shadow (0,0,180,100)]
    const raw = Buffer.alloc(1 + 4 * 4);
    // Use unaligned byteOffset = 1 to also verify unaligned subarray handling.
    const sub = raw.subarray(1);
    sub.set([5, 5, 5, 12], 0);
    sub.set([128, 128, 128, 128], 4);
    sub.set([255, 255, 255, 255], 8);
    sub.set([0, 0, 180, 100], 12);

    // Make a 4x2 image where row 1 has transparent background under pixel 3 so pixel 3 is also adjacent to transparency.
    const twoRows = Buffer.alloc(1 + 4 * 2 * 4);
    const view = twoRows.subarray(1);
    view.set(sub, 0);
    view.set([0, 0, 0, 0, 0, 0, 0, 0, 220, 20, 20, 255, 0, 0, 0, 0], 16);

    cleanAlphaEdgesInPlace(view, 4, 2);

    // Dust pixel snapped to (0,0,0,0)
    expect([...view.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    // Premultiplied-black white fringe restored to opaque neighbour's RGB (255,255,255) while keeping alpha 128
    expect([...view.subarray(4, 8)]).toEqual([255, 255, 255, 128]);
    // Opaque white untouched
    expect([...view.subarray(8, 12)]).toEqual([255, 255, 255, 255]);
    // Deliberate blue shadow next to red pixel NOT overwritten (180 > 20 + 4)
    expect([...view.subarray(12, 16)]).toEqual([0, 0, 180, 100]);
  });
});

describe('compactTracedSvg (SVGO colour/path compaction + responsive viewBox)', () => {
  it('shortens hex colours via SVGO keyword and 3-digit rules', () => {
    expect(compactHexColor('#000000')).toBe('#000');
    expect(compactHexColor('#FFFFFF')).toBe('#fff');
    expect(compactHexColor('#FF0000')).toBe('red');
    expect(compactHexColor('#000080')).toBe('navy');
    expect(compactHexColor('#808080')).toBe('gray');
    expect(compactHexColor('#123456')).toBe('#123456');
  });

  it('collapses collinear cubic rectangle borders into H/V/Z with zero rendered pixel difference', async () => {
    const upstreamD = 'M0,0C16,0,32,0,48,0c0,16,0,32,0,48c-16,0-32,0-48,0C0,32,0,16,0,0Z';
    const compactD = compactSplinePathData(upstreamD, 2);
    expect(compactD).toBe('M0,0H48V48H0Z');

    const beforeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><path d="${upstreamD}" fill="#C83C3C"/></svg>`;
    const afterSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><path d="${compactD}" fill="#c83c3c"/></svg>`;
    const renderedBefore = await sharp(Buffer.from(beforeSvg)).raw().toBuffer();
    const renderedAfter = await sharp(Buffer.from(afterSvg)).raw().toBuffer();
    expect(Buffer.compare(renderedBefore, renderedAfter)).toBe(0);
  });

  it('preserves folded hairpin cubics and genuine curved arcs untouched', () => {
    const hairpin = 'M0,0C-20,0,60,0,10,0Z';
    expect(compactSplinePathData(hairpin, 2)).toBe(hairpin);
    const arc = 'M35.31,12.06c3.79,4.14,5.85,8.38,5.6,14.09Z';
    expect(compactSplinePathData(arc, 2)).toBe(arc);
  });

  it('strips XML/comment prologue, injects viewBox, and compacts groups and paths in one pass', () => {
    const raw = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!-- Generator: visioncortex VTracer 1.0.0-alpha.4 -->',
      '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="48" height="32">',
      '<g fill="#000000">',
      '<path d="M0,0C16,0,32,0,48,0c0,10,0,22,0,32c-16,0-32,0-48,0C0,22,0,10,0,0Z"/>',
      '</g>',
      '</svg>',
      '',
    ].join('\n');
    const out = compactTracedSvg(raw, 2, 2);
    expect(out).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="32" viewBox="0 0 48 32"><g fill="#000"><path d="M0,0H48V32H0Z"/></g></svg>');
  });
});

describe('expanded vectorize options and 22-format staging + header bomb defences', () => {
  it('validates, filters, and serializes the full vtracer 1.0 option set', () => {
    expect(
      vectorizeArgs({
        preset: 'bw',
        hierarchical: 'cutout',
        adaptive: true,
        pathPrecision: 3,
      })
    ).toEqual(['--preset', 'bw', '--hierarchical', 'cutout', '--path-precision', '3', '--adaptive', '--optimize', '2']);

    expect(
      vectorizeArgs({
        clustering: 'watershed',
        watershedDetail: 96,
        palette: ['#112233', '#AABBCC'],
        optimize: 1,
      })
    ).toEqual(['--clustering', 'watershed', '--watershed-detail', '96', '--palette', '#112233,#AABBCC', '--optimize', '1']);

    // Queue sanitization drops options ignored by the active clustering/palette state.
    expect(
      sanitizeVectorizeOptions({
        preset: 'bw',
        adaptive: true,
        threshold: 100,
        colorPrecision: 5,
        gradientStep: 20,
        maxColors: 8,
      })
    ).toEqual({ preset: 'bw', adaptive: true });

    expect(
      sanitizeVectorizeOptions({
        palette: ['#ff0000', '#00ff00'],
        maxColors: 4,
      })
    ).toEqual({ palette: ['#ff0000', '#00ff00'] });

    expect(vectorizeOptionsProblem({ palette: ['#112233'] })).toBeNull();
    expect(vectorizeOptionsProblem({ palette: ['#123'] })).toContain('#RRGGBB');
  });

  it('stages ICO, ICNS, AVIF, and JFIF inputs to upright RGBA and emits compacted responsive SVG', async () => {
    const png16 = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 220, g: 30, b: 30, alpha: 1 } } })
      .png()
      .toBuffer();
    const avif16 = await sharp(png16).avif({ quality: 80 }).toBuffer();
    const jfif16 = await sharp(png16).jpeg({ quality: 90 }).toBuffer();
    const ico16 = encodeIco(png16, 16, 16);
    const icns16 = encodeIcns(png16);

    const { program, stagedCopy } = standInTracer();
    for (const [fmt, buf] of [
      ['ico', ico16],
      ['icns', icns16],
      ['avif', avif16],
      ['jfif', jfif16],
    ] as const) {
      const res = await withPixelsTracer(program, () => convertFile(buf, fmt, 'svg', {}, `icon.${fmt}`));
      const text = res.buffer.toString('utf8');
      expect(text, fmt).toContain('viewBox="0 0 16 16"');
      expect(text, fmt).toContain('fill="red"');
      expect(text, fmt).toContain('d="M0,0H16V16H0Z"');
      const staged = fs.readFileSync(stagedCopy);
      expect([staged.readUInt32LE(0), staged.readUInt32LE(4)], fmt).toEqual([16, 16]);
    }
  });

  it('refuses a 26-byte PSD header declaring > 16 MP (413) before spawning any decoder or tracer', async () => {
    const psdBomb = Buffer.alloc(32);
    psdBomb.write('8BPS', 0, 'ascii');
    psdBomb.writeUInt16BE(1, 4); // version 1
    psdBomb.writeUInt16BE(3, 12); // channels
    psdBomb.writeUInt32BE(4000, 14); // height = 4000
    psdBomb.writeUInt32BE(5000, 18); // width = 5000 => 20 MP > 16 MP
    psdBomb.writeUInt16BE(8, 22); // depth
    psdBomb.writeUInt16BE(3, 24); // RGB mode

    const { program, ran } = standInTracer();
    const err = await withPixelsTracer(program, () => captureError(() => convertFile(psdBomb, 'psd', 'svg', {}, 'huge.psd')));
    expect(err).toBeInstanceOf(InputPixelLimitError);
    expect((err as InputPixelLimitError).status).toBe(413);
    expect(ran()).toBe(false);
  });

  it('refuses an ICO whose DIB header declares > 16 MP (413) before allocating a canvas', async () => {
    // 6-byte ICO header + 16-byte entry + 40-byte BITMAPINFOHEADER declaring 5000 x 8000 (4000px image + 4000px AND mask = 20 MP)
    const dib = Buffer.alloc(64);
    dib.writeUInt32LE(40, 0); // biSize
    dib.writeInt32LE(5000, 4); // biWidth
    dib.writeInt32LE(8000, 8); // biHeight (doubled in ICO DIB => 4000 rows => 20 MP > 16 MP)
    dib.writeUInt16LE(1, 12); // biPlanes
    dib.writeUInt16LE(32, 14); // biBitCount
    const ico = Buffer.alloc(22 + dib.length);
    ico.writeUInt16LE(0, 0);
    ico.writeUInt16LE(1, 2);
    ico.writeUInt16LE(1, 4);
    ico.writeUInt32LE(dib.length, 6 + 8);
    ico.writeUInt32LE(22, 6 + 12);
    dib.copy(ico, 22);

    const { program, ran } = standInTracer();
    const err = await withPixelsTracer(program, () => captureError(() => convertFile(ico, 'ico', 'svg', {}, 'bomb.ico')));
    expect(err).toBeInstanceOf(InputPixelLimitError);
    expect((err as InputPixelLimitError).status).toBe(413);
    expect(ran()).toBe(false);
  });
});
