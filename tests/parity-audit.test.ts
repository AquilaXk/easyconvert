import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FORMAT_REGISTRY, getAllFormats } from '../src/lib/registry';

const WITHDRAWN_PAIRS: ReadonlySet<string> = new Set([
  // Entry 183 leaves out the XPS of a Word document (the XPS writer holds text only).
  'docx->pages', 'docx->xps',
  'htm->doc', 'htm->jpg', 'htm->png', 'htm->rtf',
  'html->tex',
  'md->rst', 'md->tex',
  // Entry 183: a Pages document has no export to a presentation, and the metafile writers refuse the pictures that real PDF pages hold.
  'pages->ppt',
  'pdf->emf', 'pdf->ppt', 'pdf->wmf',
  'txt->tex',
  'chm->azw3', 'chm->epub', 'chm->lrf', 'chm->mobi', 'chm->oeb', 'chm->pdb', 'chm->pdf', 'chm->rtf', 'chm->txt',
  'lit->azw3', 'lit->epub', 'lit->lrf', 'lit->mobi', 'lit->oeb', 'lit->pdb', 'lit->pdf', 'lit->rtf', 'lit->txt',
  'snb->azw3', 'snb->epub', 'snb->lrf', 'snb->mobi', 'snb->oeb', 'snb->pdb', 'snb->pdf', 'snb->rtf', 'snb->txt',
  'tcr->azw3', 'tcr->epub', 'tcr->lrf', 'tcr->mobi', 'tcr->oeb', 'tcr->pdb', 'tcr->pdf', 'tcr->rtf', 'tcr->txt',
  'key->doc', 'key->xls',
  'pot->emf', 'pot->xps',
  'potx->emf', 'potx->xps',
  'ppt->emf', 'ppt->xps',
  'pptm->emf', 'pptm->xps',
  'pptx->emf', 'pptx->key', 'pptx->xps',
  'numbers->doc', 'numbers->ppt',
  'xls->xps',
  'xlsx->numbers', 'xlsx->xps',
  // Entry 187: pairs the reference offers that the product leaves out, each with the reason measured on real files. The metafile writers refuse a
  // picture, a mask, a dash and a clip that is not one convex polygon (entries 42 and 99), so EMF and WMF are not written from PostScript pages (19 of 82 real files
  // convert), CorelDRAW, CGM and metafile pages, or Illustrator files; a page that is only a picture or has a curved clip is not written as DXF from EMF (1 of 3);
  // the SVG a DXF is drawn as holds text and round line caps that the CGM and WMF writers refuse (WMF 7 of 14 public drawings, CGM 0 of 14); and no reader of DWF,
  // Sketch or sK1 files is included (entry 42).
  'ai->emf', 'ai->wmf',
  'dxf->cgm', 'dxf->dwg', 'dxf->wmf',
  'eps->emf', 'eps->wmf',
  'ps->emf', 'ps->wmf',
  'cdr->emf', 'cdr->wmf',
  'cgm->emf', 'cgm->wmf',
  'dwf->cgm', 'dwf->dwg', 'dwf->wmf',
  'dwg->cgm', 'dwg->dwg', 'dwg->wmf',
  'emf->dxf', 'emf->emf', 'emf->wmf',
  'sk->emf', 'sk->wmf',
  'sk1->emf', 'sk1->wmf',
  'wmf->emf', 'wmf->wmf',
  'dps->swf',
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
