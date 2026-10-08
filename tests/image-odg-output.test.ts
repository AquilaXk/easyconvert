import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { convertFile } from '../src/lib/conversions';
import { OracleToolMissingError, getOracleToolPath } from './helpers/differential-oracle';
import { skipUnless } from './helpers/strict-skip';

const STRICT_MODE = process.env.ORACLE_STRICT_MODE === '1';
const PYTHON = getOracleToolPath('python3');
const SOURCE_WIDTH = 64;
const SOURCE_HEIGHT = 48;
const MAX_PAGE_SIDE_CM = 100;
const LARGE_SIDE_PX = 4000;
const ASPECT_TOLERANCE = 0.01;
const GRADIENT_STEP = 4;

/**
 * Reads the package with Python's zipfile and ElementTree, which share no code with the encoder:
 * entry order and compression of `mimetype`, the manifest, and the page/frame/image elements.
 */
const INSPECT_ODG = `
import json, sys, zipfile
import xml.etree.ElementTree as ET
ns = {
  'office': 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  'draw': 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  'svg': 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  'xlink': 'http://www.w3.org/1999/xlink',
  'manifest': 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
}
z = zipfile.ZipFile(sys.argv[1])
first = z.infolist()[0]
content = ET.fromstring(z.read('content.xml'))
manifest = ET.fromstring(z.read('META-INF/manifest.xml'))
frames = content.findall('.//office:body/office:drawing/draw:page/draw:frame', ns)
out = {
  'testzip': z.testzip(),
  'first': first.filename,
  'firstStored': first.compress_type == zipfile.ZIP_STORED,
  'mimetype': z.read('mimetype').decode(),
  'manifest': [e.get('{%s}full-path' % ns['manifest']) for e in manifest],
  'frames': [],
}
for frame in frames:
  image = frame.find('draw:image', ns)
  href = image.get('{%s}href' % ns['xlink'])
  with z.open(href) as f:
    data = f.read()
  open(sys.argv[2], 'wb').write(data)
  out['frames'].append({
    'href': href,
    'width': frame.get('{%s}width' % ns['svg']),
    'height': frame.get('{%s}height' % ns['svg']),
    'inManifest': href in out['manifest'],
  })
print(json.dumps(out))
`;

interface OdgReport {
  testzip: string | null;
  first: string;
  firstStored: boolean;
  mimetype: string;
  manifest: string[];
  frames: { href: string; width: string; height: string; inManifest: boolean }[];
}

function inspectOdg(odg: Buffer): { report: OdgReport; picture: Buffer } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'odg-oracle-'));
  try {
    const odgPath = path.join(dir, 'out.odg');
    const picturePath = path.join(dir, 'picture.bin');
    writeFileSync(odgPath, odg);
    const stdout = execFileSync(PYTHON!, ['-c', INSPECT_ODG, odgPath, picturePath], { encoding: 'utf-8' });
    return { report: JSON.parse(stdout) as OdgReport, picture: readFileSync(picturePath) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function centimetres(value: string): number {
  const match = /^([0-9.]+)cm$/.exec(value);
  if (!match) throw new Error(`unexpected length "${value}"`);
  return Number(match[1]);
}

async function gradientPng(width: number, height: number): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = (x * GRADIENT_STEP) % 256;
      pixels[offset + 1] = (y * GRADIENT_STEP) % 256;
      pixels[offset + 2] = ((x + y) * GRADIENT_STEP) % 256;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe.runIf(STRICT_MODE)('ODG oracle tooling', () => {
  it('has python3 for the package inspection', () => {
    if (!PYTHON) throw new OracleToolMissingError('python3', 'python3 is required to inspect OpenDocument packages');
    expect(path.basename(PYTHON)).toMatch(/^python3/);
  });
});

describe.skipIf(skipUnless('python3', PYTHON !== null))('image -> odd embeds the picture in an OpenDocument drawing', () => {
  it('writes mimetype first and stored, lists every part in the manifest, and embeds a picture of the source size', async () => {
    const source = await gradientPng(SOURCE_WIDTH, SOURCE_HEIGHT);
    const result = await convertFile(source, 'png', 'odd', {}, 'gradient.png');
    const { report, picture } = inspectOdg(result.buffer);

    expect(report.testzip).toBeNull();
    expect(report.first).toBe('mimetype');
    expect(report.firstStored).toBe(true);
    expect(report.mimetype).toBe('application/vnd.oasis.opendocument.graphics');
    expect(report.manifest).toEqual(expect.arrayContaining(['/', 'content.xml', 'styles.xml', 'Pictures/image1.png']));
    expect(report.frames).toHaveLength(1);
    expect(report.frames[0].inManifest).toBe(true);

    const meta = await sharp(picture).metadata();
    expect(meta.format).toBe('png');
    expect({ width: meta.width, height: meta.height }).toEqual({ width: SOURCE_WIDTH, height: SOURCE_HEIGHT });
    // The embedded pixels are the source pixels, not a placeholder.
    const embedded = await sharp(picture).removeAlpha().raw().toBuffer();
    const original = await sharp(source).removeAlpha().raw().toBuffer();
    expect(embedded.equals(original)).toBe(true);

    const frameRatio = centimetres(report.frames[0].width) / centimetres(report.frames[0].height);
    expect(Math.abs(frameRatio - SOURCE_WIDTH / SOURCE_HEIGHT)).toBeLessThan(ASPECT_TOLERANCE);
  });

  it('scales the page of a very large raster to the maximum page side while keeping the pixels', async () => {
    const source = await sharp({
      create: { width: LARGE_SIDE_PX, height: LARGE_SIDE_PX / 2, channels: 3, background: { r: 200, g: 30, b: 90 } },
    })
      .png()
      .toBuffer();
    const result = await convertFile(source, 'png', 'odd', {}, 'large.png');
    const { report, picture } = inspectOdg(result.buffer);
    const meta = await sharp(picture).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual({ width: LARGE_SIDE_PX, height: LARGE_SIDE_PX / 2 });
    expect(centimetres(report.frames[0].width)).toBeCloseTo(MAX_PAGE_SIDE_CM, 1);
    expect(centimetres(report.frames[0].height)).toBeCloseTo(MAX_PAGE_SIDE_CM / 2, 1);
  });
});
