import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { assertNotSpoofedFile, assertNotSpoofedFilePath, assertNotSpoofedObject } from '../src/lib/security/file-guard';
import { EncryptedOfficeDocumentError, FileExtensionSpoofError } from '../src/lib/types';
import { buildCompoundFile } from './helpers/cfb-craft';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * A password-protected .docx, .xlsx or .pptx is a compound file that holds the encrypted package ([MS-OFFCRYPTO] 2.1: the streams
 * `EncryptionInfo` and `EncryptedPackage`), not a ZIP. The spoof check called it "initial magic bytes indicate application/x-cfbf,
 * which is incompatible with declared format .xlsx", so five files of the real-world corpus (13 jobs of the nightly run of 2026-10-30)
 * read as forged uploads. They are what their extension says, and the answer is now the one the legacy formats already give: 422,
 * encrypted or password protected.
 */

const OBJECT_HEADER_BYTES = 64 * 1024;
const encryptedPackage = (size: number): Buffer =>
  buildCompoundFile([
    { name: 'EncryptionInfo', data: Buffer.alloc(224, 3) },
    { name: 'EncryptedPackage', data: Buffer.alloc(size, 7) },
  ]);
const wordDocument = (): Buffer => buildCompoundFile([{ name: 'WordDocument', data: Buffer.alloc(600, 1) }]);

describe('an encrypted Office Open XML package under its own extension', () => {
  it.each(['docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'potx'])('is refused as encrypted under .%s, not as a spoof', (ext) => {
    expect(() => assertNotSpoofedFile(encryptedPackage(3000), ext, `locked.${ext}`)).toThrow(EncryptedOfficeDocumentError);
    expect(() => assertNotSpoofedFile(encryptedPackage(3000), ext, `locked.${ext}`)).toThrow(/encrypted or password protected/);
  });

  it('is answered with HTTP 422', () => {
    expect(() => assertNotSpoofedFile(encryptedPackage(3000), 'xlsx')).toThrow(expect.objectContaining({ status: 422 }));
  });

  it('is still a spoof when the compound file is something else, or the extension is not an Office Open XML one', () => {
    expect(() => assertNotSpoofedFile(wordDocument(), 'docx', 'old.docx')).toThrow(FileExtensionSpoofError);
    expect(() => assertNotSpoofedFile(encryptedPackage(3000), 'png', 'locked.png')).toThrow(FileExtensionSpoofError);
    const onlyInfo = buildCompoundFile([{ name: 'EncryptionInfo', data: Buffer.alloc(224, 3) }]);
    expect(() => assertNotSpoofedFile(onlyInfo, 'docx', 'half.docx')).toThrow(FileExtensionSpoofError);
  });

  describe('larger than the first 64 KiB of a file', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'encrypted-ooxml-'));
    afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const large = encryptedPackage(200_000);

    it('is read at the offsets of its directory when it is a file on disk', () => {
      const file = path.join(scratch, 'locked.xlsx');
      fs.writeFileSync(file, large);
      expect(() => assertNotSpoofedFilePath(file, 'xlsx', 'locked.xlsx')).toThrow(EncryptedOfficeDocumentError);
      const word = path.join(scratch, 'old.docx');
      fs.writeFileSync(word, Buffer.concat([wordDocument(), Buffer.alloc(200_000)]));
      expect(() => assertNotSpoofedFilePath(word, 'docx', 'old.docx')).toThrow(FileExtensionSpoofError);
    });

    it('is read by range requests when it is an object in a store', async () => {
      const backend = {
        openReadStream: async (_key: string, range?: { start: number; end: number }) =>
          Readable.from([large.subarray(range?.start ?? 0, (range?.end ?? large.length - 1) + 1)]),
      };
      await expect(assertNotSpoofedObject(backend, 'uploads/locked', large.length, large.subarray(0, OBJECT_HEADER_BYTES), 'xlsx', 'locked.xlsx')).rejects.toBeInstanceOf(
        EncryptedOfficeDocumentError
      );
    });
  });

  for (const id of ['office-spreadsheet-protected_passtika.xlsx', 'office-document-bug53475-password-is-pass.docx', 'office-spreadsheet-58616.xlsx']) {
    it(`is refused as encrypted for the real file ${id}, by buffer and by path`, async (ctx) => {
      const { bytes, path: file } = await requireRealworldSample(ctx, id);
      const ext = id.slice(id.lastIndexOf('.') + 1);
      expect(() => assertNotSpoofedFile(bytes.subarray(0, OBJECT_HEADER_BYTES), ext, id)).toThrow(/encrypted or password protected|spoofing rejected/);
      expect(() => assertNotSpoofedFilePath(file, ext, id)).toThrow(EncryptedOfficeDocumentError);
    });
  }
});
