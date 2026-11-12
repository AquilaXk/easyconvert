import sharp, { type Sharp } from 'sharp';
import { AVIF_EFFORT, AVIF_TUNE, encodeBmp, encodePostscript } from '../image';
import { buildTiffOptions } from '../image-tiff-options';
import { checkedRasterCanvas } from '../image-input-limits';
import { escapeXmlQuoted } from '../../text/escape';

async function rasterizePipeline(
  pipeline: Sharp,
  tgt: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  switch (tgt) {
    case 'jpg':
    case 'jpeg': {
      const buffer = await pipeline.jpeg({ quality: 90 }).toBuffer();
      return { buffer, mimeType: 'image/jpeg' };
    }
    case 'webp': {
      const buffer = await pipeline.webp().toBuffer();
      return { buffer, mimeType: 'image/webp' };
    }
    case 'avif': {
      const buffer = await pipeline.avif({ tune: AVIF_TUNE, effort: AVIF_EFFORT }).toBuffer();
      return { buffer, mimeType: 'image/avif' };
    }
    case 'tiff': {
      const buffer = await pipeline.tiff(buildTiffOptions({})).toBuffer();
      return { buffer, mimeType: 'image/tiff' };
    }
    case 'gif': {
      const buffer = await pipeline.gif().toBuffer();
      return { buffer, mimeType: 'image/gif' };
    }
    case 'bmp': {
      const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const buffer = encodeBmp(data, info.width, info.height, info.channels);
      return { buffer, mimeType: 'image/bmp' };
    }
    case 'eps':
    case 'ps': {
      const { data, info } = await pipeline.removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const buffer = await encodePostscript(data, info.width, info.height, tgt === 'eps');
      return { buffer, mimeType: 'application/postscript' };
    }
    case 'png':
    default: {
      const buffer = await pipeline.png().toBuffer();
      return { buffer, mimeType: 'image/png' };
    }
  }
}

export async function renderTableToRaster(
  rows: string[][],
  tgt: string,
  baseName: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const rowHeight = 26;
  const colWidth = 140;
  const numCols = rows.reduce((widest, row) => Math.max(widest, row.length), 1);
  const { width, height } = checkedRasterCanvas(Math.max(640, numCols * colWidth + 40), Math.max(200, rows.length * rowHeight + 80), 'table');

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#ffffff" />
    <text x="20" y="32" font-family="sans-serif" font-size="16" font-weight="bold" fill="#1e293b">${escapeXmlQuoted(baseName)}</text>
  `;

  rows.forEach((row, rIdx) => {
    const y = 50 + rIdx * rowHeight;
    const isHeader = rIdx === 0;
    const stripeFill = rIdx % 2 === 0 ? '#ffffff' : '#f8fafc';
    const bgFill = isHeader ? '#f1f5f9' : stripeFill;
    svg += `<rect x="20" y="${y}" width="${width - 40}" height="${rowHeight}" fill="${bgFill}" stroke="#e2e8f0" />`;
    row.forEach((cell, cIdx) => {
      const x = 25 + cIdx * colWidth;
      const fontWeight = isHeader ? 'bold' : 'normal';
      svg += `<text x="${x}" y="${y + 18}" font-family="sans-serif" font-size="12" font-weight="${fontWeight}" fill="#334155">${escapeXmlQuoted(cell)}</text>`;
    });
  });

  svg += `</svg>`;

  const pipeline = sharp(Buffer.from(svg, 'utf-8'));
  return rasterizePipeline(pipeline, tgt);
}

export async function renderTextToRaster(
  text: string,
  tgt: string,
  baseName: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const lines = text.split(/\r?\n/);
  const { width, height } = checkedRasterCanvas(800, Math.max(240, lines.length * 24 + 80), 'text');

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#ffffff" />
    <text x="30" y="36" font-family="sans-serif" font-size="18" font-weight="bold" fill="#0f172a">${escapeXmlQuoted(baseName)}</text>
  `;

  lines.forEach((line, idx) => {
    const y = 68 + idx * 24;
    svg += `<text x="30" y="${y}" font-family="sans-serif" font-size="13" fill="#334155">${escapeXmlQuoted(line)}</text>`;
  });

  svg += `</svg>`;

  const pipeline = sharp(Buffer.from(svg, 'utf-8'));
  return rasterizePipeline(pipeline, tgt);
}
