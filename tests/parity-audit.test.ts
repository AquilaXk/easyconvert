import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { FORMAT_REGISTRY, getAllFormats } from '../src/lib/registry';

describe('Universal Format Matrix & Parity Verification', () => {
  it('achieves 100% format coverage across all 2,156 conversion specifications', () => {
    const fixturePath = path.resolve(__dirname, 'fixtures/reference-formats.json');
    const pairs: Array<{ input_format: string; output_format: string; engine: string; meta?: { group?: string } }> =
      JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

    const ourFormats = new Set(Object.keys(FORMAT_REGISTRY).map((k) => k.toLowerCase()));

    const missingInputsMap = new Map<string, { group: string; targets: Set<string> }>();
    for (const p of pairs) {
      const src = p.input_format.toLowerCase();
      if (!ourFormats.has(src)) {
        if (!missingInputsMap.has(src)) {
          missingInputsMap.set(src, { group: p.meta?.group || 'unknown', targets: new Set() });
        }
        missingInputsMap.get(src)!.targets.add(p.output_format.toLowerCase());
      }
    }

    const missingOutputsMap = new Map<string, { sources: Set<string> }>();
    for (const p of pairs) {
      const tgt = p.output_format.toLowerCase();
      if (!ourFormats.has(tgt)) {
        if (!missingOutputsMap.has(tgt)) {
          missingOutputsMap.set(tgt, { sources: new Set() });
        }
        missingOutputsMap.get(tgt)!.sources.add(p.input_format.toLowerCase());
      }
    }

    // Check pairs where both src and tgt exist in our registry, but tgt is not in targetFormats
    const existingFmtMissingTargets: Record<string, string[]> = {};
    for (const p of pairs) {
      const src = p.input_format.toLowerCase();
      const tgt = p.output_format.toLowerCase();
      if (ourFormats.has(src) && ourFormats.has(tgt)) {
        const def = FORMAT_REGISTRY[src];
        if (def && !def.targetFormats.map((t) => t.toLowerCase()).includes(tgt)) {
          existingFmtMissingTargets[src] = existingFmtMissingTargets[src] || [];
          existingFmtMissingTargets[src].push(tgt);
        }
      }
    }

    // Deterministic strict verification
    expect(missingInputsMap.size).toBe(0);
    expect(missingOutputsMap.size).toBe(0);
    expect(Object.keys(existingFmtMissingTargets).length).toBe(0);

    // Total unique formats in EasyConvert
    const allDefs = getAllFormats();
    expect(allDefs.length).toBeGreaterThanOrEqual(292);

    // Verify all 2,156 transformation pairs are valid in registry
    let verifiedPairsCount = 0;
    for (const p of pairs) {
      const src = p.input_format.toLowerCase();
      const tgt = p.output_format.toLowerCase();
      const def = FORMAT_REGISTRY[src];
      expect(def).toBeDefined();
      expect(def.targetFormats.map((t) => t.toLowerCase())).toContain(tgt);
      verifiedPairsCount++;
    }
    expect(verifiedPairsCount).toBe(pairs.length);
  });
});
