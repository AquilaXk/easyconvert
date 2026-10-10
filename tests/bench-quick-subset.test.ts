import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUICK_SUBSET } from '../bench/config';

/**
 * The per-push quality gate measures `--quick` cases only, so a target format or encoder path that no quick case reaches
 * is merged with no quality row. These checks tie the subset to the cases the baseline records for each family.
 */

const baseline = JSON.parse(readFileSync(path.join(__dirname, '..', 'bench', 'baseline.json'), 'utf8')) as { entries: Record<string, unknown> };
const casesOf = (family: string): string[] => [...new Set(Object.keys(baseline.entries).filter((id) => id.startsWith(`${family}/`)).map((id) => id.split('/')[1]))];
const targetOf = (caseName: string): string => caseName.split('->')[1];

/** A target that differs from a covered one only in the encoder binary the quick run does not need to repeat. */
const EXEMPT_TARGETS: Readonly<Record<string, readonly string[]>> = { video: ['hevc'] };

describe('the quick subsets', () => {
  it.each(['image', 'video', 'audio'])('reach every target format of the %s family', (family) => {
    const quick = new Set((QUICK_SUBSET[family] ?? []).map(targetOf));
    const all = new Set(casesOf(family).map(targetOf));
    for (const target of all) {
      if (EXEMPT_TARGETS[family]?.includes(target)) continue;
      expect(quick.has(target), `${family} target ${target}`).toBe(true);
    }
  });

  it('reach each AVIF chroma path of the image family: photographs (4:2:0), graphics (4:4:4) and grey line art (4:0:0)', () => {
    const avif = (QUICK_SUBSET.image ?? []).filter((caseName) => targetOf(caseName) === 'avif');
    expect([...avif].sort()).toEqual(['lineart.png->avif', 'photo-b.png->avif', 'screenshot.png->avif']);
  });

  it('include a JPEG target of a graphic source, the case the graphic JPEG path is measured on', () => {
    const jpeg = (QUICK_SUBSET.image ?? []).filter((caseName) => targetOf(caseName) === 'jpg');
    expect(jpeg).toEqual(['lineart.png->jpg']);
  });

  it('name only cases that exist, and measure the whole of a family without a subset', () => {
    for (const [family, subset] of Object.entries(QUICK_SUBSET)) {
      const cases = new Set(casesOf(family));
      for (const caseName of subset ?? []) expect(cases.has(caseName), `${family}/${caseName}`).toBe(true);
    }
    expect(QUICK_SUBSET.ocr).toBeNull();
    expect(QUICK_SUBSET.document).toBeNull();
    expect(QUICK_SUBSET.compression).toBeNull();
  });
});
