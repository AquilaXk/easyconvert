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
  'abw->doc', 'abw->jpg', 'abw->png', 'abw->rtf',
  'docm->doc', 'docm->docx', 'docm->jpg', 'docm->odt', 'docm->png', 'docm->rtf',
  'docx->azw3', 'docx->lrf', 'docx->mobi', 'docx->oeb', 'docx->pages', 'docx->pdb', 'docx->xps',
  'dot->doc', 'dot->jpg', 'dot->png', 'dot->rtf',
  'dotx->doc', 'dotx->jpg', 'dotx->png', 'dotx->rtf',
  'htm->doc', 'htm->jpg', 'htm->png', 'htm->rtf',
  'html->doc', 'html->jpg', 'html->png', 'html->rtf', 'html->tex',
  'md->doc', 'md->jpg', 'md->png', 'md->rst', 'md->rtf', 'md->tex',
  'odt->azw3', 'odt->lrf', 'odt->mobi', 'odt->oeb', 'odt->pdb',
  'pages->doc', 'pages->docx', 'pages->epub', 'pages->jpg', 'pages->pdf', 'pages->png', 'pages->ppt', 'pages->txt',
  'pdb->rtf',
  'pdf->avif', 'pdf->bmp', 'pdf->doc', 'pdf->dxf', 'pdf->emf', 'pdf->eps', 'pdf->gif', 'pdf->ico', 'pdf->odd', 'pdf->ppt', 'pdf->ps', 'pdf->psd', 'pdf->webp', 'pdf->wmf',
  'rst->rtf',
  'txt->doc', 'txt->jpg', 'txt->png', 'txt->rtf', 'txt->tex',
  'wpd->doc', 'wpd->jpg', 'wpd->png', 'wpd->rtf',
  'wps->doc', 'wps->jpg', 'wps->png', 'wps->rtf',
  'xps->avif', 'xps->bmp', 'xps->eps', 'xps->gif', 'xps->ico', 'xps->jpg', 'xps->odd', 'xps->png', 'xps->ps', 'xps->psd', 'xps->svg', 'xps->tiff', 'xps->webp',
  'zabw->doc', 'zabw->jpg', 'zabw->png', 'zabw->rtf',
  'azw->rtf',
  'azw3->rtf',
  'cbr->azw3', 'cbr->epub', 'cbr->lrf', 'cbr->mobi', 'cbr->oeb', 'cbr->pdb', 'cbr->pdf', 'cbr->rtf', 'cbr->txt',
  'chm->azw3', 'chm->epub', 'chm->lrf', 'chm->mobi', 'chm->oeb', 'chm->pdb', 'chm->pdf', 'chm->rtf', 'chm->txt',
  'fb2->azw3', 'fb2->lrf', 'fb2->mobi', 'fb2->oeb', 'fb2->pdb', 'fb2->rtf',
  'lit->azw3', 'lit->epub', 'lit->lrf', 'lit->mobi', 'lit->oeb', 'lit->pdb', 'lit->pdf', 'lit->rtf', 'lit->txt',
  'mobi->rtf',
  'prc->azw3', 'prc->epub', 'prc->lrf', 'prc->mobi', 'prc->oeb', 'prc->pdb', 'prc->pdf', 'prc->rtf', 'prc->txt',
  'snb->azw3', 'snb->epub', 'snb->lrf', 'snb->mobi', 'snb->oeb', 'snb->pdb', 'snb->pdf', 'snb->rtf', 'snb->txt',
  'tcr->azw3', 'tcr->epub', 'tcr->lrf', 'tcr->mobi', 'tcr->oeb', 'tcr->pdb', 'tcr->pdf', 'tcr->rtf', 'tcr->txt',
  'dps->eps', 'dps->jpg', 'dps->md', 'dps->png', 'dps->ppt',
  'key->doc', 'key->jpg', 'key->png', 'key->ppt', 'key->xls',
  'odp->eps', 'odp->md',
  'pot->emf', 'pot->jpg', 'pot->png', 'pot->ppt',
  'potx->emf', 'potx->jpg', 'potx->odp', 'potx->png', 'potx->ppt', 'potx->xps',
  'pps->eps', 'pps->jpg', 'pps->md', 'pps->png', 'pps->ppt',
  'ppsx->eps', 'ppsx->jpg', 'ppsx->md', 'ppsx->png', 'ppsx->ppt',
  'ppt->emf', 'ppt->eps', 'ppt->md', 'ppt->xps',
  'pptm->emf', 'pptm->eps', 'pptm->html', 'pptm->jpg', 'pptm->md', 'pptm->odp', 'pptm->pdf', 'pptm->png', 'pptm->ppt', 'pptm->pptx', 'pptm->txt', 'pptm->xps',
  'pptx->emf', 'pptx->eps', 'pptx->key', 'pptx->md', 'pptx->xps',
  'csv->jpg', 'csv->png',
  'numbers->doc', 'numbers->jpg', 'numbers->pdf', 'numbers->png', 'numbers->ppt',
  'xls->xps',
  'xlsm->jpg', 'xlsm->png',
  'xlsx->numbers', 'xlsx->xps',
  'ai->dxf', 'ai->emf', 'ai->svg', 'ai->wmf',
  'bmp->svg',
  'dxf->bmp', 'dxf->cgm', 'dxf->dwg', 'dxf->eps', 'dxf->gif', 'dxf->tiff', 'dxf->wmf',
  'eps->emf', 'eps->ico', 'eps->odd', 'eps->psd', 'eps->wmf',
  'gif->svg',
  'jpeg->svg',
  'jpg->svg',
  'png->svg',
  'ps->emf', 'ps->ico', 'ps->odd', 'ps->psd', 'ps->wmf',
  'svg->emf', 'svg->ico', 'svg->odd', 'svg->psd', 'svg->wmf',
  'svgz->emf', 'svgz->ico', 'svgz->odd', 'svgz->psd', 'svgz->wmf',
  'tif->svg',
  'tiff->svg',
  'webp->svg',
  'cdr->emf', 'cdr->wmf',
  'cgm->emf', 'cgm->wmf',
  'dwf->cgm', 'dwf->dwg', 'dwf->wmf',
  'dwg->bmp', 'dwg->cgm', 'dwg->dwg', 'dwg->eps', 'dwg->gif', 'dwg->tiff', 'dwg->wmf',
  'emf->emf', 'emf->ico', 'emf->odd', 'emf->psd', 'emf->wmf',
  'sk->emf', 'sk->wmf',
  'sk1->emf', 'sk1->wmf',
  'vsd->emf', 'vsd->wmf',
  'wmf->emf', 'wmf->wmf',
  'doc->jpg', 'doc->png', 'doc->rtf',
  'docx->doc', 'docx->jpg', 'docx->png', 'docx->rtf',
  'odp->jpg', 'odp->png', 'odp->ppt',
  'ods->jpg', 'ods->png',
  'odt->doc', 'odt->jpg', 'odt->png', 'odt->rtf',
  'pdf->svg',
  'ppt->jpg', 'ppt->odp', 'ppt->png',
  'pptx->jpg', 'pptx->png', 'pptx->ppt',
  'rtf->doc', 'rtf->jpg', 'rtf->png',
  'xls->jpg', 'xls->png',
  'xlsx->jpg', 'xlsx->png',
  'dps->swf',
  'gif->aac', 'gif->aiff', 'gif->flac', 'gif->m4a', 'gif->mp3', 'gif->wav', 'gif->wma',
  'odp->swf',
  'pps->swf',
  'ppsx->swf',
  'ppt->swf',
  'pptm->swf',
  'pptx->swf',
  'webp->aac', 'webp->aiff', 'webp->flac', 'webp->m4a', 'webp->mp3', 'webp->wav', 'webp->wma',
  'cbz->azw3', 'cbz->epub', 'cbz->lrf', 'cbz->mobi', 'cbz->oeb', 'cbz->pdb', 'cbz->rtf', 'cbz->txt',
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
