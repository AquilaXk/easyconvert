import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { requireOracleTool } from './differential-oracle';

const SOFFICE_TIMEOUT_MS = 120_000;
const FONT_FAMILY = 'DejaVu Sans';
const FONT_SIZE_PT = 14;

/** Renders an HTML body with LibreOffice into a PDF (DejaVu Sans, 14 pt) using a throwaway profile. */
export function htmlToPdf(body: string): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soffice-pdf-'));
  try {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:'${FONT_FAMILY}';font-size:${FONT_SIZE_PT}pt}</style></head><body>${body}</body></html>`;
    fs.writeFileSync(path.join(dir, 'in.html'), html, 'utf-8');
    execFileSync(
      requireOracleTool('soffice'),
      ['--headless', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', 'pdf', '--outdir', dir, path.join(dir, 'in.html')],
      { timeout: SOFFICE_TIMEOUT_MS, stdio: 'ignore' }
    );
    return fs.readFileSync(path.join(dir, 'in.pdf'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
