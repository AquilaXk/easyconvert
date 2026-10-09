import { describe, it, expect } from 'vitest';
import { expectLinearScaling, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';
import { safeExtractXmlElements } from '../src/lib/conversions/office';

/**
 * Timing-ratio checks moved out of phase-5-ocr-and-security.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in phase-5-ocr-and-security.test.ts.
 */

/** Opening tags in the small run of the unclosed-tag growth check, and the filler after each one. */
const UNCLOSED_OPENINGS = 5000;
const UNCLOSED_FILLER_PER_OPENING = 10;

describe('Phase 5: OCR Sandwich PDF Typography Parity & Security Hardening', () => {
  describe('4. SAX Token Scanning & ReDoS Immunity on Untrusted XML', () => {
    it('neutralizes hostile ReDoS payloads designed to freeze backtracking regex engines', async () => {
      // Classic ReDoS trigger for /<p:grpSp[\s\S]*?<\/p:grpSp>/:
      // A huge repeating sequence of opening tags with no closing tag
      const { largeResult } = await expectLinearScaling(
        'unclosed group shapes',
        (openings: number) => safeExtractXmlElements('<p:grpSp>'.repeat(openings) + 'A'.repeat(openings * UNCLOSED_FILLER_PER_OPENING), 'p:grpSp'),
        { baseSize: UNCLOSED_OPENINGS }
      );

      // Because there are no matching closing tags, it must abort gracefully, and in time linear in the input
      expect(largeResult.length).toBe(0);
    }, SCALING_TEST_TIMEOUT_MS);
  });
});
