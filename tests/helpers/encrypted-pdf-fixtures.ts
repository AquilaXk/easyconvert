import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { requireOracleTool } from './differential-oracle';

/**
 * Encrypted PDF fixtures for the encryption policy (#571). Every encrypted file is written by the qpdf CLI, never by
 * the code under test, and the expected values (encryption parameters, permissions, text) are read back with qpdf
 * --json, qpdf --check and pdftotext.
 */

export interface EncryptionVariant {
  name: string;
  /** Arguments of `qpdf --encrypt <user> <owner> <bits> ... --`, after the bit length. */
  bits: string;
  extra: string[];
  /** Encryption revision (R) qpdf writes for it. */
  revision: number;
  /** Encryption version (V). */
  version: number;
}

export const ENCRYPTION_VARIANTS: readonly EncryptionVariant[] = [
  { name: 'RC4-40', bits: '40', extra: [], revision: 2, version: 1 },
  { name: 'RC4-128', bits: '128', extra: ['--use-aes=n'], revision: 3, version: 2 },
  { name: 'AES-128', bits: '128', extra: ['--use-aes=y'], revision: 4, version: 4 },
  { name: 'AES-256', bits: '256', extra: [], revision: 6, version: 5 },
];

export const AES_256 = ENCRYPTION_VARIANTS[3];
export const RC4_128 = ENCRYPTION_VARIANTS[1];

export type ObjectStreamMode = 'classic' | 'objstm';

export interface EncryptOptions {
  variant: EncryptionVariant;
  userPassword?: string;
  ownerPassword?: string;
  /** qpdf --modify level; omitted keeps every permission. */
  modify?: 'none' | 'assembly' | 'annotate' | 'form' | 'all';
  /** classic: cross-reference table; objstm: cross-reference stream and object streams. */
  structure?: ObjectStreamMode;
  linearize?: boolean;
}

export function qpdfPath(): string {
  return requireOracleTool('qpdf');
}

export async function plainPdf(texts: readonly string[] = ['Plain body text']): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of texts) {
    doc.addPage([300, 300]).drawText(text, { x: 20, y: 200, size: 14, font });
  }
  return Buffer.from(await doc.save());
}

export function withTempDir<T>(operation: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-pdf-fixture-'));
  try {
    return operation(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** qpdf spells the permission options of 40-bit RC4 (revision 2) as y/n flags; the other revisions take a level. */
function modifyArgs(variant: EncryptionVariant, modify: EncryptOptions['modify']): string[] {
  if (!modify) return [];
  if (variant.revision > 2) return [`--modify=${modify}`];
  return modify === 'all' ? [] : ['--modify=n', '--annotate=n'];
}

/** Encrypts `plain` with the qpdf CLI. */
export function qpdfEncrypt(plain: Buffer, options: EncryptOptions): Buffer {
  const { variant, userPassword = '', ownerPassword = 'owner-secret-1', modify, structure = 'classic', linearize = false } = options;
  return withTempDir((dir) => {
    const input = path.join(dir, 'in.pdf');
    const output = path.join(dir, 'out.pdf');
    fs.writeFileSync(input, plain);
    const args = [
      '--allow-weak-crypto',
      `--object-streams=${structure === 'objstm' ? 'generate' : 'disable'}`,
      ...(linearize ? ['--linearize'] : []),
      '--encrypt',
      userPassword,
      ownerPassword,
      variant.bits,
      ...variant.extra,
      ...modifyArgs(variant, modify),
      '--',
      input,
      output,
    ];
    execFileSync(qpdfPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    return fs.readFileSync(output);
  });
}

export interface QpdfEncryptionReport {
  encrypted: boolean;
  P: number;
  R: number;
  V: number;
  userPasswordMatched: boolean;
  ownerPasswordMatched: boolean;
  capabilities: Record<string, boolean>;
}

/** What qpdf itself reports about the encryption of `pdf` when opened with `password`. */
export function qpdfEncryptionReport(pdf: Buffer, password = ''): QpdfEncryptionReport {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    const json = execFileSync(qpdfPath(), [`--password=${password}`, '--json', '--json-key=encrypt', file], {
      encoding: 'utf-8',
    });
    const encrypt = JSON.parse(json).encrypt;
    return {
      encrypted: encrypt.encrypted,
      P: encrypt.parameters.P,
      R: encrypt.parameters.R,
      V: encrypt.parameters.V,
      userPasswordMatched: encrypt.userpasswordmatched,
      ownerPasswordMatched: encrypt.ownerpasswordmatched,
      capabilities: encrypt.capabilities,
    };
  });
}

/** `qpdf --check` on `pdf` (opened with `password`): true when qpdf finds no error. */
export function qpdfCheckPasses(pdf: Buffer, password?: string): boolean {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    try {
      execFileSync(qpdfPath(), [...(password === undefined ? [] : [`--password=${password}`]), '--check', file], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  });
}

/** Text of `pdf` as Poppler's pdftotext reads it. */
export function pdftotext(pdf: Buffer, password?: string): string {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    return execFileSync(
      requireOracleTool('pdftotext'),
      [...(password === undefined ? [] : ['-upw', password]), file, '-'],
      { encoding: 'utf-8' }
    );
  });
}

/** Page count as Poppler's pdfinfo reads it. */
export function pdfinfoPages(pdf: Buffer, password?: string): number {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    const info = execFileSync(
      requireOracleTool('pdfinfo'),
      [...(password === undefined ? [] : ['-upw', password]), file],
      { encoding: 'utf-8' }
    );
    return Number.parseInt(/Pages:\s+(\d+)/.exec(info)?.[1] ?? '0', 10);
  });
}

/** True when the bytes carry an `/Encrypt` entry anywhere (a cheap oracle that the output is not encrypted). */
export function containsEncryptKey(pdf: Buffer): boolean {
  return pdf.includes('/Encrypt');
}
