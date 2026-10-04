import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FORMAT_REGISTRY, getAllFormats } from '../src/lib/registry';

const WITHDRAWN_PAIRS: ReadonlySet<string> = new Set([
  'epub->azw3',
  'epub->lrf',
  'epub->mobi',
  'epub->oeb',
  'epub->pdb',
  'epub->rtf',
  // No EMF/WMF decoder exists, and these sources have no EMF/WMF/CGM encoder path.
  'ai->emf',
  'ai->wmf',
  'cdr->emf',
  'cdr->wmf',
  'dwf->cgm',
  'dwf->wmf',
  'dwg->cgm',
  'dwg->wmf',
  'dxf->cgm',
  'dxf->wmf',
  'emf->avif',
  'emf->bmp',
  'emf->dxf',
  'emf->emf',
  'emf->eps',
  'emf->gif',
  'emf->ico',
  'emf->jpg',
  'emf->odd',
  'emf->pdf',
  'emf->png',
  'emf->ps',
  'emf->psd',
  'emf->svg',
  'emf->tiff',
  'emf->webp',
  'emf->wmf',
  'pdf->emf',
  'pdf->wmf',
  'pot->emf',
  'potx->emf',
  'ppt->emf',
  'pptm->emf',
  'pptx->emf',
  'sk->emf',
  'sk->wmf',
  'sk1->emf',
  'sk1->wmf',
  'vsd->emf',
  'vsd->wmf',
  'wmf->dxf',
  'wmf->emf',
  'wmf->eps',
  'wmf->pdf',
  'wmf->png',
  'wmf->ps',
  'wmf->svg',
  'wmf->wmf',
]);

describe('Universal Format Matrix & Parity Verification', () => {
  it('achieves 100% format coverage across all 2,156 conversion specifications', () => {
    const fixturePath = path.resolve(__dirname, 'fixtures/reference-formats.json');
    const allPairs: Array<{ input_format: string; output_format: string; engine: string; meta?: { group?: string } }> =
      JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

    // Design Decision D8: RAR archive creation is permanently removed across the platform.
    // Pairs without a conversion engine are withdrawn rather than advertised (#369) and must stay
    // unadvertised until an engine produces them.
    const isWithdrawn = (p: { input_format: string; output_format: string }) =>
      WITHDRAWN_PAIRS.has(`${p.input_format.toLowerCase()}->${p.output_format.toLowerCase()}`);
    const pairs = allPairs.filter((p) => p.output_format.toLowerCase() !== 'rar' && !isWithdrawn(p));

    const withdrawnInReference = allPairs.filter(isWithdrawn).map((p) => `${p.input_format}->${p.output_format}`.toLowerCase());
    expect(new Set(withdrawnInReference)).toEqual(WITHDRAWN_PAIRS);
    for (const pair of WITHDRAWN_PAIRS) {
      const [src, tgt] = pair.split('->');
      expect(FORMAT_REGISTRY[src].targetFormats).not.toContain(tgt);
    }

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
