import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from 'next/constants.js';
import config from '../next.config.mjs';

const SERVER_OCR_POOL = path.join(__dirname, '..', 'src', 'lib', 'conversions', 'ocr-worker-pool.ts');

describe('packages the server must load from node_modules, not from the bundle', () => {
  // tesseract.js starts its worker from src/worker-script/node beside its own files. Bundled into .next, that path pointed
  // into .next, the worker never started, and every OCR conversion of the web server answered 503 after 60 s.
  it.each([PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER])('keeps tesseract.js external in the %s phase while the server OCR pool imports it', async (phase) => {
    expect(fs.readFileSync(SERVER_OCR_POOL, 'utf8')).toContain("import('tesseract.js')");
    const nextConfig = await config(phase);
    expect(nextConfig.serverExternalPackages).toEqual(expect.arrayContaining(['tesseract.js', 'harfbuzzjs', 'sharp']));
  });
});
