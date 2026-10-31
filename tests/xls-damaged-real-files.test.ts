import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readKnownRefusals } from '../bench/realworld/report';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * Three real government workbooks (#783: govdocs1-007750, -007751, -008063) were refused with "Workbook stream not found in
 * CFBF container", and since the directory chain of the compound file parser must end inside the file they are refused for the
 * sector chain that runs to a sector the file does not hold (as a ConversionFailedError, which the office suite is not asked to
 * retry: it would write these bytes as text). The reader looks for both stream names (BIFF8 `Workbook`, BIFF5/7 `Book`, as xlrd and the other
 * established readers do); these files have neither because their compound file structure is destroyed:
 *
 * - 007750 and 007751 went through a text-mode transfer: every LF byte is preceded by an inserted CR, which shifts all that
 *   follows, so the sector tables and the directory sit at the wrong offsets. Taking the CRs back out of the LF pairs gives a
 *   valid compound file (a BIFF8 and a BIFF7 `Book` workbook) that converts to the cells xlrd 2.0.2 reads from it.
 * - 008063 stops at 1.5 MiB while its header places the first FAT sector at sector 7953, past the end of the file.
 *
 * xlrd 2.0.2 refuses the original bytes; LibreOffice falls back to importing them as text and writes the
 * binary as CSV. A refusal is the right answer, and the nightly run lists it as an explained one.
 */

const TEXT_MODE_DAMAGED = ['govdocs1-007750.xls', 'govdocs1-007751.xls'] as const;
const TRUNCATED = 'govdocs1-008063.xls';
const CHAIN_PAST_THE_FILE = /Corrupt CFBF container: the sector chain starting at sector \d+ reaches sector \d+, which the file does not hold\./;
const CHAIN_PAST_THE_FILE_DETAIL = 'ConversionFailedError: Corrupt CFBF container: the sector chain starting at sector 4078 reaches sector 1419968535, which the file does not hold.';

/**
 * SHA-256 of the first sheet as xlrd 2.0.2 reads it (`str(cell.value)` per cell, Python csv.writer with LF line ends, final
 * line end removed because the converter writes none), for the file with its CR LF pairs turned back into LF.
 */
const XLRD_CSV_SHA256: Record<(typeof TEXT_MODE_DAMAGED)[number], string> = {
  'govdocs1-007750.xls': '2d550fed38178e9775223c05766b162923bef2e84273f61756caf9ca104b31eb',
  'govdocs1-007751.xls': '86f44ce53569591396b9f6da7842d3afa7cbe1492b64dbc0bfb495628d221db4',
};

const CR = 0x0d;
const LF = 0x0a;
const HEADER_FIRST_FAT_SECTOR_OFFSET = 0x4c;
const SECTOR_BYTES = 512;
const HEADER_BYTES = 512;

/** Every LF of the bytes comes after a CR: the signature of a binary file sent in text mode. */
function everyLineFeedFollowsCarriageReturn(bytes: Buffer): boolean {
  let lineFeeds = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== LF) continue;
    lineFeeds++;
    if (i === 0 || bytes[i - 1] !== CR) return false;
  }
  return lineFeeds > 0;
}

function withoutInsertedCarriageReturns(bytes: Buffer): Buffer {
  const kept: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === CR && bytes[i + 1] === LF) continue;
    kept.push(bytes[i]);
  }
  return Buffer.from(kept);
}

describe('the real workbooks whose compound file is destroyed', () => {
  describe.each(TEXT_MODE_DAMAGED)('%s (sent in text mode)', (id) => {
    it('has a line feed behind every carriage return, so the sector tables are shifted', async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      expect(everyLineFeedFollowsCarriageReturn(bytes)).toBe(true);
    });

    it('is refused for csv as a compound file whose directory runs past the file', async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      await expect(dispatchConversion(bytes, 'xls', 'csv', {}, id)).rejects.toThrow(CHAIN_PAST_THE_FILE);
    });

    it('converts, once the inserted carriage returns are taken out, to the cells xlrd reads', { timeout: 60_000 }, async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      const repaired = withoutInsertedCarriageReturns(bytes);
      expect((repaired.length - HEADER_BYTES) % SECTOR_BYTES).toBe(0);
      const csv = (await dispatchConversion(repaired, 'xls', 'csv', {}, id)).buffer;
      expect(createHash('sha256').update(csv).digest('hex')).toBe(XLRD_CSV_SHA256[id]);
    });
  });

  describe(TRUNCATED, () => {
    it('is cut off before the first FAT sector its header names', async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, TRUNCATED);
      const firstFatSector = bytes.readUInt32LE(HEADER_FIRST_FAT_SECTOR_OFFSET);
      expect(HEADER_BYTES + firstFatSector * SECTOR_BYTES).toBeGreaterThan(bytes.length);
    });

    it('is refused for csv as a compound file whose directory runs past the file', async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, TRUNCATED);
      await expect(dispatchConversion(bytes, 'xls', 'csv', {}, TRUNCATED)).rejects.toThrow(CHAIN_PAST_THE_FILE);
    });
  });

  it('are explained refusals of the nightly corpus run, which the nightly gate lists instead of leaving them unexplained', () => {
    const explained = readKnownRefusals();
    for (const file of [...TEXT_MODE_DAMAGED, TRUNCATED]) {
      const entry = explained.find((candidate) => candidate.file === file);
      expect(entry, `${file} has a known refusal`).toBeDefined();
      expect(new RegExp(entry!.detail).test(CHAIN_PAST_THE_FILE_DETAIL)).toBe(true);
    }
  });
});
