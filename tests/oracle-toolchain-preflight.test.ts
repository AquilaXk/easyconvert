import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { getOracleToolPath } from './helpers/differential-oracle';

// Tools installed in CI via apt-get (.github/workflows/ci.yml L42-55)
export const CI_REQUIRED_ORACLE_TOOLS: Array<{ name: string; resolve: () => string | null }> = [
  { name: 'ffmpeg', resolve: () => getOracleToolPath('ffmpeg') },
  { name: 'ffprobe', resolve: () => getOracleToolPath('ffprobe') },
  { name: '7z', resolve: () => getOracleToolPath('7z') },
  { name: 'poppler-utils (pdfinfo)', resolve: () => getOracleToolPath('pdfinfo') },
  { name: 'poppler-utils (pdftotext)', resolve: () => getOracleToolPath('pdftotext') },
  { name: 'poppler-utils (pdftoppm)', resolve: () => getOracleToolPath('pdftoppm') },
  { name: 'zstd', resolve: () => getOracleToolPath('zstd') },
  { name: 'tar', resolve: () => getOracleToolPath('tar') },
  { name: 'libreoffice (soffice)', resolve: () => getOracleToolPath('soffice') },
  { name: 'imagemagick (identify/magick)', resolve: () => getOracleToolPath('identify') || getOracleToolPath('magick') },
  { name: 'tesseract-ocr (tesseract)', resolve: () => getOracleToolPath('tesseract') },
  { name: 'unrar', resolve: () => getOracleToolPath('unrar') },
];

describe('Oracle Toolchain Preflight Integrity Gate', () => {
  it('validates all required CI oracle tools exist when ORACLE_STRICT_MODE=1', (ctx) => {
    if (process.env.ORACLE_STRICT_MODE !== '1') {
      ctx.skip();
      return;
    }

    const missing: string[] = [];
    const found: Array<{ name: string; path: string }> = [];

    for (const tool of CI_REQUIRED_ORACLE_TOOLS) {
      const resolvedPath = tool.resolve();
      if (!resolvedPath) {
        missing.push(tool.name);
      } else {
        found.push({ name: tool.name, path: resolvedPath });
      }
    }

    if (missing.length > 0) {
      const searchPaths = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
      throw new Error(
        `Preflight check FAILED: ${missing.length} required CI oracle tool(s) missing under ORACLE_STRICT_MODE=1:\n` +
          `  Missing tools:\n${missing.map((m) => `    - ${m}`).join('\n')}\n\n` +
          `  Candidate PATH search directories:\n${searchPaths.map((p) => `    - ${p}`).join('\n')}\n\n` +
          `  Installed tools found (${found.length}):\n${found.map((f) => `    + ${f.name} -> ${f.path}`).join('\n')}`
      );
    }

    expect(missing).toHaveLength(0);
    expect(found.length).toBe(CI_REQUIRED_ORACLE_TOOLS.length);
  });
});
