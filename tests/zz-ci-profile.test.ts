import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { decodePlainPngOnce } from '../src/lib/conversions/image-decoded-source';
import { classifyRaster } from '../src/lib/conversions/image-content';
import { encodeAvifWithCli, findAvifenc } from '../src/lib/conversions/avif-cli';

const CORPUS = path.join(__dirname, '..', 'bench', 'corpus');
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function time(label: string, run: () => unknown, count = 25): Promise<void> {
  for (let i = 0; i < 3; i += 1) await run();
  const spent: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = process.hrtime.bigint();
    await run();
    spent.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  console.log(`PROFILE ${label.padEnd(58)} min ${Math.min(...spent).toFixed(2)}  med ${median(spent).toFixed(2)} ms`);
}

it('profiles the image rows on the CI machine', async () => {
  console.log(`PROFILE cpus ${os.cpus().length} ${os.cpus()[0]?.model} node ${process.version} sharp ${JSON.stringify(sharp.versions.vips)} webp ${sharp.versions.webp}`);
  console.log(`PROFILE cwebp ${spawnSync('cwebp', ['-version'], { encoding: 'utf8' }).stdout.trim()}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));
  for (const name of ['screenshot.png', 'lineart.png', 'photo-b.png']) {
    console.log(`PROFILE ---- ${name}`);
    const source = fs.readFileSync(path.join(CORPUS, name));
    const ff = path.join(work, `ff-${name}`);
    execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', path.join(CORPUS, name), '-frames:v', '1', ff]);
    const deep = name !== 'photo-b.png';
    await time('spawn /bin/true', () => spawnSync('/bin/true'));
    await time('cwebp -q70 -m4 (ffmpeg png)', () => spawnSync('cwebp', ['-quiet', '-q', '70', '-m', '4', ff, '-o', path.join(work, 'o.webp')]));
    await time('convert -quality 70 (ffmpeg png)', () => spawnSync('convert', [ff, '-quality', '70', path.join(work, 'o.jpg')]));
    await time('avifenc ref cmd', () => spawnSync('avifenc', [...(deep ? ['-d', '10'] : []), '-q', '70', '-s', '6', '-j', 'all', ff, path.join(work, 'o.avif')]), 5);
    await time('sharp decode -> raw (as stored)', () => sharp(source).raw().toBuffer());
    await time('decodePlainPngOnce', () => decodePlainPngOnce(sharp(source)));
    const decoded = await decodePlainPngOnce(sharp(source));
    if (decoded) await time('classifyRaster', () => classifyRaster(decoded.raster));
    await time('sharp png -> webp q70 e4 direct', () => sharp(source).webp({ quality: 70, effort: 4, smartSubsample: false }).toBuffer());
    await time('sharp png -> removeAlpha -> webp', () => sharp(source).removeAlpha().webp({ quality: 70, effort: 4, smartSubsample: false }).toBuffer());
    await time('sharp png -> jpeg direct (graphic opts)', () => sharp(source).removeAlpha().jpeg({ quality: 70, chromaSubsampling: '4:2:0', optimiseCoding: true, trellisQuantisation: false, quantisationTable: 2, overshootDeringing: true }).toBuffer());
    const narrow = await decodePlainPngOnce(sharp(source), undefined, true);
    await time('decodePlainPngOnce eight-bit', () => decodePlainPngOnce(sharp(source), undefined, true));
    if (narrow) await time('jpeg from the eight-bit raster', () => narrow.pipeline.removeAlpha().jpeg({ quality: 70, chromaSubsampling: '4:2:0', optimiseCoding: true, trellisQuantisation: false, quantisationTable: 2, overshootDeringing: true }).toBuffer());
    const avifenc = await findAvifenc();
    if (avifenc && decoded) {
      const grey = name === 'lineart.png';
      const png1 = await decoded.pipeline.removeAlpha().toColourspace(grey ? 'grey16' : deep ? 'rgb16' : 'srgb').png({ compressionLevel: 1 }).toBuffer();
      const request = (png: Buffer) => ({ png, width: decoded.raster.width, height: decoded.raster.height, quality: 70, effort: 3, bitdepth: (deep ? 10 : 8) as 8 | 10, layout: (grey ? '4:0:0' : '4:4:4') as '4:0:0' | '4:4:4' });
      await time('avif: raster -> png level 1', () => decoded.pipeline.removeAlpha().toColourspace(grey ? 'grey16' : deep ? 'rgb16' : 'srgb').png({ compressionLevel: 1 }).toBuffer());
      await time('avif: cli on the re-encoded png', () => encodeAvifWithCli(avifenc, request(png1)), 5);
      await time('avif: cli on the original png', () => encodeAvifWithCli(avifenc, request(source)), 5);
    }
    await time('convertImage png->webp', () => convertImage(source, 'webp', { quality: 70 }, name, 'png'));
    await time('convertImage png->jpg', () => convertImage(source, 'jpg', { quality: 70 }, name, 'png'));
    await time('convertImage png->avif', () => convertImage(source, 'avif', { quality: 70 }, name, 'png'), 5);
  }
}, 600_000);
