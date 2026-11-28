import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FORMAT_REGISTRY, getAllFormats } from '../src/lib/registry';

const WITHDRAWN_PAIRS: ReadonlySet<string> = new Set([
  // Entry 183 leaves out the XPS of a Word document (the XPS writer holds text only).
  'docx->pages', 'docx->xps',
  // Entry 183: a Pages document has no export to a presentation.
  'pages->ppt',
  'key->doc', 'key->xls',
  // Entry 455: the office suite has no XPS filter and Ghostscript's xpswrite writes a drawing with no Glyphs (bitmap rows by default, outlines with -dNOCACHE), so these eight stay withdrawn.
  'pot->xps',
  'potx->xps',
  'ppt->xps',
  'pptm->xps',
  'pptx->key', 'pptx->xps',
  'numbers->doc', 'numbers->ppt',
  'xls->xps',
  'xlsx->numbers', 'xlsx->xps',
  // Entry 187: pairs the reference offers that the product leaves out, each with the reason measured on real files. Entry 454 offers the PDF,
  // presentation, CorelDRAW, CGM, EMF and WMF sources as EMF and WMF, entry 458 the PostScript files, and entry 460 the Illustrator and EPS files
  // (entry 459 draws what the writers cannot as bitmap records); what stays withdrawn: a page that is only a picture or has a curved clip is not
  // written as DXF from EMF (1 of 3), and no reader of DWF, Sketch or sK1 files (entry 42). The SVG a DXF is drawn as holds text and round line
  // caps that the metafile writers refuse; entries 466 and 468 write WMF and CGM from the drawing's PDF instead, and entry 471 writes DWG from a DXF
  // and from a DWG with a separate program of the pinned LibreDWG release.
  'dwf->cgm', 'dwf->dwg', 'dwf->wmf',
  'emf->dxf',
  'sk->emf', 'sk->wmf',
  'sk1->emf', 'sk1->wmf',
  // Entry 455: the office suite of the image has no Flash export; a raster slide show by FFmpeg is an option that waits for QA.
  'dps->swf',
  // Entry 455: a GIF or WebP holds no audio stream, so every real file would be refused.
  'gif->aac', 'gif->aiff', 'gif->flac', 'gif->m4a', 'gif->mp3', 'gif->wav', 'gif->wma',
  'odp->swf',
  'pps->swf',
  'ppsx->swf',
  'ppt->swf',
  'pptm->swf',
  'pptx->swf',
  'webp->aac', 'webp->aiff', 'webp->flac', 'webp->m4a', 'webp->mp3', 'webp->wav', 'webp->wma',
  // A Pages document has no spreadsheet export in the office suite; the engine wrote the file's bytes as CSV rows (policy 113).
  'pages->xls',
  // Entry 345: FFmpeg reads Digital Speech Standard recordings but has no encoder or muxer for them, so the pair cannot be written.
  'dss->dss',
]);

describe('Universal Format Matrix & Parity Verification', () => {
  it('advertises every reference conversion pair that has not been withdrawn', () => {
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

    // Verify every remaining reference pair is advertised by the registry
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
