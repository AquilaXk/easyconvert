import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { requireOracleTool } from './differential-oracle';

/**
 * LibreOffice as an independent authoring and reference tool for the legacy Office tests: it builds
 * DOC, RTF, PPT and ODG files from flat OpenDocument text the test writes, and exports its own plain
 * text view of the same source, so the expected text never comes from the module under test.
 */

const SOFFICE_TIMEOUT_MS = 120_000;
const SLIDE_FRAME_X_CM = 1.5;
const SLIDE_FRAME_WIDTH_CM = 22;
const SLIDE_FRAME_HEIGHT_CM = 2;
const SLIDE_FRAME_STEP_CM = 2.5;
const SLIDE_FRAME_Y_START_CM = 1;

const NS_DECLARATIONS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
  'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
].join(' ');

export function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Flat OpenDocument text with one paragraph per entry. */
export function flatOdt(paragraphs: readonly string[]): Buffer {
  const body = paragraphs.map((p) => `<text:p>${xmlEscape(p)}</text:p>`).join('');
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><office:document ${NS_DECLARATIONS} office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.text"><office:body><office:text>${body}</office:text></office:body></office:document>`,
    'utf-8'
  );
}

function textFrames(lines: readonly string[]): string {
  return lines
    .map((line, i) => {
      const y = SLIDE_FRAME_Y_START_CM + i * SLIDE_FRAME_STEP_CM;
      return (
        `<draw:frame svg:x="${SLIDE_FRAME_X_CM}cm" svg:y="${y}cm" svg:width="${SLIDE_FRAME_WIDTH_CM}cm" svg:height="${SLIDE_FRAME_HEIGHT_CM}cm">` +
        `<draw:text-box><text:p>${xmlEscape(line)}</text:p></draw:text-box></draw:frame>`
      );
    })
    .join('');
}

/** Flat OpenDocument presentation: one slide per entry, one text box per line of the entry. */
export function flatOdp(slides: readonly (readonly string[])[]): Buffer {
  const pages = slides.map((lines, i) => `<draw:page draw:name="page${i + 1}" draw:master-page-name="Default">${textFrames(lines)}</draw:page>`).join('');
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><office:document ${NS_DECLARATIONS} office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.presentation"><office:body><office:presentation>${pages}</office:presentation></office:body></office:document>`,
    'utf-8'
  );
}

/** Flat OpenDocument drawing: one page per entry, one text box per line of the entry. */
export function flatOdg(pages: readonly (readonly string[])[]): Buffer {
  const body = pages.map((lines, i) => `<draw:page draw:name="page${i + 1}" draw:master-page-name="Default">${textFrames(lines)}</draw:page>`).join('');
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><office:document ${NS_DECLARATIONS} office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.graphics"><office:body><office:drawing>${body}</office:drawing></office:body></office:document>`,
    'utf-8'
  );
}

/**
 * Converts `input` with the soffice CLI, using a throwaway profile. `filter` is the `--convert-to`
 * argument (for example `doc`, `rtf` or `txt:Text`); `outputExtension` is the extension of the result.
 */
export function sofficeConvert(input: Buffer, inputExtension: string, filter: string, outputExtension: string): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soffice-office-'));
  try {
    const inputPath = path.join(dir, `in.${inputExtension}`);
    fs.writeFileSync(inputPath, input);
    execFileSync(
      requireOracleTool('soffice'),
      ['--headless', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', filter, '--outdir', dir, inputPath],
      { timeout: SOFFICE_TIMEOUT_MS, stdio: 'ignore', env: { ...process.env, HOME: dir } }
    );
    return fs.readFileSync(path.join(dir, `in.${outputExtension}`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Collapses every whitespace run to one space, the comparison form for text from two writers. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
