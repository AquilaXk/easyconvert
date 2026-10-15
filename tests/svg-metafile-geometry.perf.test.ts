import { describe, it, expect } from 'vitest';
import { encodeEmf, encodeWmf, encodeCgm } from '../src/lib/conversions/vector-metafile';
import { CadGeometryUnavailableError } from '../src/lib/types';
import { expectLinearOnInputs, expectNoSlowerThanReference, expectSizeIndependentOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS, settle } from './helpers/timing';

/**
 * Timing-ratio checks moved out of svg-metafile-geometry.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in svg-metafile-geometry.test.ts.
 */

function svgDoc(body: string, rootAttrs = 'width="100" height="100" viewBox="0 0 100 100"'): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" ${rootAttrs}>${body}</svg>`, 'utf-8');
}

describe('SVG document model for metafile encoders', () => {
  describe('fill-rule analysis budget', () => {
    it('fails fast with a typed error when a nonzero CGM fill is too complex to verify (300 strips)', async () => {
      // Alternate orientation so overlapping strips cancel (winding 0), forcing a full analysis. Every strip crosses
      // every other, so an unbudgeted analysis grows with the square of the strip count. The budget caps it, leaving
      // only the parse of the path text, which grows with the input: four times the strips must cost at most linear
      // time (tests/helpers/timing.ts), where the uncapped analysis takes about sixteen times as long.
      const stripDoc = (count: number) => svgDoc(`<path fill="#000" d="${strips(count)}"/>`, 'width="300" height="400"');
      const { largeResult } = await expectLinearOnInputs('CGM fill analysis', (svg: Buffer) => settle(() => encodeCgm(svg)), {
        small: stripDoc(STRIPS),
        large: stripDoc(STRIPS * SCALING_FACTOR),
      });
      if (largeResult.ok) throw new Error('the over-complex fill was encoded instead of refused');
      expect(largeResult.error).toBeInstanceOf(CadGeometryUnavailableError);
      expect((largeResult.error as Error).message).toMatch(/too complex/);

      // The refusal costs a bounded multiple of reading the same path under evenodd, which needs no analysis; an
      // uncapped analysis of these strips takes over a thousand times as long.
      const evenodd = svgDoc(`<path fill="#000" fill-rule="evenodd" d="${strips(STRIPS * SCALING_FACTOR)}"/>`, 'width="300" height="400"');
      const nonzero = stripDoc(STRIPS * SCALING_FACTOR);
      await expectNoSlowerThanReference('CGM fill budget', () => encodeCgm(evenodd), () => settle(() => encodeCgm(nonzero)), {
        maxRatio: FILL_BUDGET_OVERHEAD_RATIO_BOUND,
      });
    }, SCALING_TEST_TIMEOUT_MS);

    const STRIPS = 150;

    /** Refusing measured about 8x the evenodd read of the same path; uncapped analysis about 1800x. */
    const FILL_BUDGET_OVERHEAD_RATIO_BOUND = 32;

    const PAST_CAP_POINTS = 500_001;

    const LONGEST_POINT_LIST = 1_200_000;

    /** Below the 2.4x of a reader that parses the whole list, above the 1x of one that stops at the cap. */
    const POINT_LIST_RATIO_BOUND = 1.6;

    function strips(count: number): string {
      const parts: string[] = [];
      for (let k = 0; k < count; k++) {
        const t = 2 * k + 1;
        parts.push(`M0 ${t} L300 ${t + 97.3} V${t + 97.8} L0 ${t + 0.5} Z`, `M${t} 0 V400 H${t + 0.5} V0 Z`);
      }
      return parts.join(' ');
    }

    it('stops flattening a multi-megabyte path of cubics and arcs as soon as the vertex cap is crossed', async () => {
      const SEGMENTS = 250_000;
      const pathDoc = (segments: number) => {
        const parts = ['M0 0'];
        for (let k = 0; k < segments; k++) {
          parts.push(k % 2 === 0 ? 'c 40 -90 -40 90 1 0' : 'a 30 30 0 1 1 1 0');
        }
        const d = parts.join(' ');
        return { d, svg: svgDoc(`<path fill="none" stroke="#000" d="${d}"/>`, 'width="100" height="100" viewBox="0 -100 100000 200"') };
      };
      const modest = pathDoc(SEGMENTS / SCALING_FACTOR);
      const huge = pathDoc(SEGMENTS);
      expect(huge.d.length).toBeGreaterThan(4_000_000);
      const rssBefore = process.memoryUsage().rss;
      // Both paths cross the vertex cap early, so 4x the segments is refused after about the same work.
      const { largeResult } = await expectSizeIndependentOnInputs('vertex cap on a long path', (svg: Buffer) => settle(() => encodeEmf(svg)), {
        modest: modest.svg,
        huge: huge.svg,
      });
      const RSS_GROWTH_LIMIT = 400 * 1024 * 1024;
      expect(process.memoryUsage().rss - rssBefore).toBeLessThan(RSS_GROWTH_LIMIT);
      if (largeResult.ok) throw new Error('the over-complex path was encoded instead of refused');
      expect(largeResult.error).toBeInstanceOf(CadGeometryUnavailableError);
      expect((largeResult.error as Error).message).toMatch(/too complex/);
    }, SCALING_TEST_TIMEOUT_MS);

    it('charges polygon point lists against the vertex cap while parsing', async () => {
      // Single-digit coordinates keep a point at 4 characters, so the largest list the 5 MiB document limit admits
      // (about 1.3 million points) is 2.4x a list one point past the 500,000 vertex cap. A reader that parsed the
      // whole list before charging it would take 2.4x as long for the longer one; one that charges as it reads
      // stops at the cap in both. A list below the cap would be read and encoded whole, which is different work.
      const polygonDoc = (points: number) => {
        const pts = Array.from({ length: points }, (_, k) => `${k % 10},${(k * 7) % 10}`).join(' ');
        return svgDoc(`<polygon fill="#000" points="${pts}"/>`);
      };
      const { largeResult } = await expectSizeIndependentOnInputs('polygon point cap', (svg: Buffer) => settle(() => encodeWmf(svg)), {
        modest: polygonDoc(PAST_CAP_POINTS),
        huge: polygonDoc(LONGEST_POINT_LIST),
        maxRatio: POINT_LIST_RATIO_BOUND,
      });
      if (largeResult.ok) throw new Error('the over-complex polygon was encoded instead of refused');
      expect((largeResult.error as Error).message).toMatch(/too complex/);
    }, SCALING_TEST_TIMEOUT_MS);

    it('rejects documents that expand past the vertex cap fast (2000 copies of a 2230-vertex polygon)', async () => {
      const VERTICES = 2230;
      const COPIES = 2000;
      const pts = Array.from({ length: VERTICES }, (_, k) => {
        const a = (k / VERTICES) * 2 * Math.PI;
        return `${(50 + 40 * Math.cos(a)).toFixed(3)},${(50 + 40 * Math.sin(a)).toFixed(3)}`;
      }).join(' ');
      const copiesDoc = (copies: number) =>
        svgDoc(`<defs><polygon id="p" fill="#000" points="${pts}"/></defs>${Array.from({ length: copies }, () => '<use href="#p"/>').join('')}`);
      // The expansion is charged copy by copy, so 4x the copies is refused after about the same work.
      for (const encode of [encodeEmf, encodeWmf, encodeCgm]) {
        const { largeResult } = await expectSizeIndependentOnInputs(`vertex cap on ${encode.name}`, (svg: Buffer) => settle(() => encode(svg)), {
          modest: copiesDoc(COPIES),
          huge: copiesDoc(COPIES * SCALING_FACTOR),
        });
        if (largeResult.ok) throw new Error('the over-complex document was encoded instead of refused');
        expect(largeResult.error).toBeInstanceOf(CadGeometryUnavailableError);
        expect((largeResult.error as Error).message).toMatch(/too complex/);
      }
    }, SCALING_TEST_TIMEOUT_MS);
  });
});
