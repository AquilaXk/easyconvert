import { describe, expect, it } from 'vitest';
import { knownRefusal, readKnownRefusals } from '../bench/realworld/report';
import { crashDetail } from '../bench/realworld/verdict';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { LegacyOfficeFormatError } from '../src/lib/conversions/office/legacy-office-errors';
import { CompoundFileStructureError } from '../src/lib/types';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * govdocs1-001630.ppt is a compound file whose FAT chain for the directory returns to an earlier sector (the chain from sector
 * 213, the first directory sector, reaches sector 0 again). Apache POI's POIFSFileSystem refuses it ("Potential loop detected - Block 0 was already claimed but
 * was just requested again"), LibreOffice 24.2.7 does not load it ("source file could not be loaded"), and LibreOffice 26.8
 * opens its bytes as a text document, so no reader reads it as a presentation. The answer is a typed 400 that names the loop, and the
 * office suite is not asked to read it.
 */
const SAMPLE = 'govdocs1-001630.ppt';
const HTTP_BAD_REQUEST = 400;

describe('a PowerPoint file whose sector chain loops', () => {
  for (const target of ['txt', 'html']) {
    it(`is refused for ${target} with the loop named, and the refusal is a known one`, async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, SAMPLE);
      const failure = await dispatchConversion(bytes, 'ppt', target, {}, SAMPLE).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(LegacyOfficeFormatError);
      const refusal = failure as LegacyOfficeFormatError;
      expect(refusal.cause).toBeInstanceOf(CompoundFileStructureError);
      expect(refusal.status).toBe(HTTP_BAD_REQUEST);
      expect(refusal.message).toContain('the sector chain starting at sector 213 returns to sector 0');
      const job = { file: SAMPLE, source: 'ppt', target, verdict: 'refused', ms: 0, detail: crashDetail(refusal.name, refusal.message, null) } as const;
      expect(knownRefusal(job, readKnownRefusals()), refusal.message).not.toBeNull();
    }, 60_000);
  }
});
