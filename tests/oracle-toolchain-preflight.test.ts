import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getOracleToolPath, type ExternalOracleTool } from './helpers/differential-oracle';
import { MAGICK_BINARY } from './helpers/imagemagick';

/**
 * Every external tool and language pack a suite uses as an oracle or as an engine. Under ORACLE_STRICT_MODE=1 (CI)
 * a missing one fails here by name, instead of a suite silently skipping or failing later with an unrelated error.
 * The CI image installs them from .github/actions/ci-setup/apt-packages.txt; a tool added to a suite is added there and here.
 */

interface RequiredTool {
  name: string;
  /** The location or version it was found at, or null when it is missing. */
  resolve: () => string | null;
}

const ORACLE_BINARIES: { name: string; tool: ExternalOracleTool }[] = [
  { name: 'ffmpeg', tool: 'ffmpeg' },
  { name: 'ffprobe', tool: 'ffprobe' },
  { name: 'flac', tool: 'flac' },
  { name: 'metaflac', tool: 'metaflac' },
  { name: '7z', tool: '7z' },
  { name: 'tar', tool: 'tar' },
  { name: 'zstd', tool: 'zstd' },
  { name: 'bzip2', tool: 'bzip2' },
  { name: 'xz', tool: 'xz' },
  { name: 'unrar', tool: 'unrar' },
  { name: 'poppler-utils (pdfinfo)', tool: 'pdfinfo' },
  { name: 'poppler-utils (pdftotext)', tool: 'pdftotext' },
  { name: 'poppler-utils (pdftoppm)', tool: 'pdftoppm' },
  { name: 'poppler-utils (pdftocairo)', tool: 'pdftocairo' },
  { name: 'poppler-utils (pdffonts)', tool: 'pdffonts' },
  { name: 'poppler-utils (pdfimages)', tool: 'pdfimages' },
  { name: 'poppler-utils (pdftops)', tool: 'pdftops' },
  { name: 'qpdf', tool: 'qpdf' },
  { name: 'ghostscript (ps2pdf)', tool: 'ps2pdf' },
  { name: 'veraPDF', tool: 'verapdf' },
  { name: 'libreoffice (soffice)', tool: 'soffice' },
  { name: 'tesseract-ocr (tesseract)', tool: 'tesseract' },
  { name: 'libxml2-utils (xmllint)', tool: 'xmllint' },
  { name: 'libraw-bin (dcraw_emu)', tool: 'dcraw_emu' },
  { name: 'libraw-bin (raw-identify)', tool: 'raw-identify' },
  { name: 'woff2 (woff2_decompress)', tool: 'woff2_decompress' },
  { name: 'woff2 (woff2_info)', tool: 'woff2_info' },
  { name: 'python3', tool: 'python3' },
  { name: 'util-linux (unshare)', tool: 'unshare' },
];

const PYTHON_MODULES = ['pyarrow', 'duckdb', 'fitz', 'fontTools', 'brotli'];
/** English for the reference pages, Korean and Japanese for the CJK suites, the orientation model for rotated scans. */
const TESSERACT_LANGUAGES = ['eng', 'kor', 'jpn', 'osd'];

function binary(name: string, tool: ExternalOracleTool): RequiredTool {
  return { name, resolve: () => getOracleToolPath(tool) };
}

function fontconfigScanner(): string | null {
  const probe = spawnSync('fc-scan', ['--version'], { encoding: 'utf-8' });
  return probe.status === 0 ? `fc-scan ${probe.stdout.trim()}` : null;
}

function pythonModule(module: string): RequiredTool {
  return {
    name: `python3 module ${module}`,
    resolve: () => {
      const python = getOracleToolPath('python3');
      if (!python) return null;
      const probe = spawnSync(python, ['-I', '-c', `import ${module}`], { encoding: 'utf-8' });
      return probe.status === 0 ? `import ${module}` : null;
    },
  };
}

function tesseractLanguage(language: string): RequiredTool {
  return {
    name: `tesseract language data ${language}`,
    resolve: () => {
      const tesseract = getOracleToolPath('tesseract');
      if (!tesseract) return null;
      const listing = spawnSync(tesseract, ['--list-langs'], { encoding: 'utf-8' });
      const languages = `${listing.stdout}\n${listing.stderr}`.split(/\r?\n/).map((line) => line.trim());
      return listing.status === 0 && languages.includes(language) ? language : null;
    },
  };
}

export const CI_REQUIRED_ORACLE_TOOLS: RequiredTool[] = [
  ...ORACLE_BINARIES.map(({ name, tool }) => binary(name, tool)),
  // ImageMagick 7 installs `magick`; version 6, which Debian-based images carry, installs `convert`, `compare` and `identify`.
  { name: 'imagemagick (magick or convert)', resolve: () => MAGICK_BINARY },
  { name: 'fontconfig (fc-scan)', resolve: fontconfigScanner },
  ...PYTHON_MODULES.map(pythonModule),
  ...TESSERACT_LANGUAGES.map(tesseractLanguage),
];

describe('Oracle Toolchain Preflight Integrity Gate', () => {
  it('lists every tool the suites depend on, with no duplicates', () => {
    const names = CI_REQUIRED_ORACLE_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const required of ['bzip2', 'xz', 'poppler-utils (pdftocairo)', 'poppler-utils (pdffonts)', 'fontconfig (fc-scan)', 'libraw-bin (dcraw_emu)', 'libraw-bin (raw-identify)', 'veraPDF', 'tesseract language data kor']) {
      expect(names, required).toContain(required);
    }
  });

  it('validates all required CI oracle tools exist when ORACLE_STRICT_MODE=1', (ctx) => {
    if (process.env.ORACLE_STRICT_MODE !== '1') {
      // The gate exists for CI; a developer machine need not carry every tool.
      ctx.skip();
      return;
    }

    const missing: string[] = [];
    const found: Array<{ name: string; path: string }> = [];

    for (const tool of CI_REQUIRED_ORACLE_TOOLS) {
      const resolved = tool.resolve();
      if (!resolved) {
        missing.push(tool.name);
      } else {
        found.push({ name: tool.name, path: resolved });
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

    expect(found.map((tool) => tool.name)).toEqual(CI_REQUIRED_ORACLE_TOOLS.map((tool) => tool.name));
  });
});
