import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { requireOracleTool } from './helpers/differential-oracle';
import { svgPng } from './helpers/graphic-parity';
import { decodeRgba, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * The alpha plane of an AVIF is written losslessly, as the reference encoder writes it when only a colour quality is
 * given. A graphic with transparency is flat colour with anti-aliased edges: lossy alpha moves the edge pixels and
 * the picture flattened on a background differs from the source (57 dB PSNR against an exact 100 dB on the benchmark's
 * flat chart), for a saving of a few percent of the file. Oracles: the source alpha is drawn here (an SVG with
 * known shapes and soft edges), the output alpha is decoded by `avifdec` and read by ImageMagick.
 */

const SIDE = 160;
const RGBA_CHANNELS = 4;
const ALPHA_AT = 3;

let workDir: string;
beforeAll(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'avif-alpha-'));
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

async function transparentGraphic(): Promise<Buffer> {
  const body =
    '<circle cx="80" cy="80" r="62" fill="#c0392b" fill-opacity="0.85"/><rect x="30" y="100" width="100" height="26" rx="9" fill="#2980b9"/>' +
    '<path d="M10 20L150 140" stroke="#222" stroke-width="2.3" stroke-opacity="0.6"/><circle cx="118" cy="44" r="18" fill="#f1c40f" fill-opacity="0.4"/>';
  return svgPng(body, SIDE, SIDE);
}

function alphaPlane(rgba: Buffer): number[] {
  const out: number[] = [];
  for (let at = ALPHA_AT; at < rgba.length; at += RGBA_CHANNELS) out.push(rgba[at]);
  return out;
}

describe.skipIf(skipWithoutTools('avifenc', 'avifdec') || SKIP_WITHOUT_MAGICK)('AVIF with transparency', () => {
  it.each([40, 70, 85])('keeps every alpha sample of a graphic exactly at quality %i', async (quality) => {
    const source = await transparentGraphic();
    const sourceAlpha = alphaPlane(Buffer.from(decodeRgba(source, 'png').data));
    expect(new Set(sourceAlpha).size, 'the fixture has soft edges').toBeGreaterThan(8);
    const avif = path.join(workDir, `g${quality}.avif`);
    writeFileSync(avif, (await convertImage(source, 'avif', { quality }, 'g.png', 'png')).buffer);
    const decoded = path.join(workDir, `g${quality}.png`);
    execFileSync(requireOracleTool('avifdec'), [avif, decoded]);
    const outputAlpha = alphaPlane(Buffer.from(decodeRgba(readFileSync(decoded), 'png').data));
    expect(outputAlpha).toEqual(sourceAlpha);
  });
});
