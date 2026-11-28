import { EngineUnavailableError, UnsupportedTargetError } from '../types';
import { isCalibreOnlyPair } from './calibre-ebook-targets';
import { isPandocPair } from './pandoc-pairs';

/**
 * Pairs that only a native engine converts: the in-process engine has no code path for them.
 * LibreOffice converts between Office formats and, chained with Poppler, renders Office
 * documents to raster images; Poppler renders PDF to SVG; GhostXPS draws XPS documents; ddjvu draws DjVu documents. When the native engine is missing,
 * these pairs fail with EngineUnavailableError instead of falling back to the in-process engine.
 */
const NATIVE_ENGINE_ONLY_PAIRS: ReadonlySet<string> = new Set([
  // An Illustrator file is a PDF (or a PostScript program) that Poppler draws as SVG and the DXF writer reads.
  'ai->dxf', 'ai->emf', 'ai->svg', 'ai->wmf',
  'doc->jpg', 'doc->png', 'doc->rtf',
  'eps->avif', 'eps->bmp', 'eps->dxf', 'eps->emf', 'eps->eps', 'eps->gif', 'eps->ico', 'eps->jpg', 'eps->odd', 'eps->pdf', 'eps->png', 'eps->ps', 'eps->psd', 'eps->svg', 'eps->tiff', 'eps->webp', 'eps->wmf',
  'djv->avif', 'djv->bmp', 'djv->eps', 'djv->gif', 'djv->ico', 'djv->jpg', 'djv->pdf', 'djv->png', 'djv->ps', 'djv->psd', 'djv->svg', 'djv->tiff', 'djv->webp',
  'djvu->avif', 'djvu->bmp', 'djvu->eps', 'djvu->gif', 'djvu->ico', 'djvu->jpg', 'djvu->pdf', 'djvu->png', 'djvu->ps', 'djvu->psd', 'djvu->svg', 'djvu->tiff', 'djvu->webp',
  // A CSV table's page images: Poppler draws the pages of the PDF the in-process engine writes of it.
  'csv->jpg', 'csv->png',
  // A DXF or DWG drawing written as WMF: Poppler draws the page of the PDF the in-process engine writes of it (entry 466).
  'dwg->wmf', 'dxf->wmf',
  // A PDF and a presentation written as EMF or WMF: Poppler draws the page as SVG for the in-process writer, and the office suite writes the pages it refuses (entry 454).
  // Presentations written as PostScript pictures (Poppler draws the suite's PDF) or as Markdown (the PDF text reader reads the suite's PDF).
  'dps->eps', 'dps->md',
  // Macro-enabled documents and Word templates: the office suite writes them as Word 97, RTF and page images, as it writes a Word document.
  'docm->doc', 'docm->jpg', 'docm->png', 'docm->rtf',
  'docx->doc', 'docx->jpg', 'docx->png', 'docx->rtf',
  'dot->doc', 'dot->jpg', 'dot->png', 'dot->rtf',
  'dotx->doc', 'dotx->jpg', 'dotx->png', 'dotx->rtf',
  // Text and markup: the in-process converter writes their DOCX or PDF, and the office suite writes Word 97 and RTF from the DOCX or Poppler draws the PDF pages.
  'html->doc', 'html->jpg', 'html->png', 'html->rtf',
  'htm->doc', 'htm->jpg', 'htm->png', 'htm->rtf',
  'md->doc', 'md->jpg', 'md->png', 'md->rtf',
  'txt->doc', 'txt->jpg', 'txt->png', 'txt->rtf',
  'rst->rtf',
  'key->html', 'key->jpg', 'key->pdf', 'key->png', 'key->ppt', 'key->pptx',
  'odd->avif', 'odd->bmp', 'odd->eps', 'odd->gif', 'odd->ico', 'odd->jpg', 'odd->odd', 'odd->pdf', 'odd->png', 'odd->ps', 'odd->psd', 'odd->tiff', 'odd->webp',
  'odg->bmp', 'odg->jpg', 'odg->pdf', 'odg->png',
  'odp->eps', 'odp->jpg', 'odp->md', 'odp->png', 'odp->ppt',
  'ods->jpg', 'ods->png',
  'odt->doc', 'odt->jpg', 'odt->png', 'odt->rtf',
  'oxps->avif', 'oxps->bmp', 'oxps->eps', 'oxps->gif', 'oxps->ico', 'oxps->jpg', 'oxps->pdf', 'oxps->png', 'oxps->ps', 'oxps->psd', 'oxps->svg', 'oxps->tiff', 'oxps->webp',
  'pdf->avif', 'pdf->bmp', 'pdf->doc', 'pdf->dxf', 'pdf->emf', 'pdf->eps', 'pdf->gif', 'pdf->ico', 'pdf->odd', 'pdf->ppt', 'pdf->ps', 'pdf->psd', 'pdf->svg', 'pdf->webp', 'pdf->wmf',
  'ps->avif', 'ps->bmp', 'ps->dxf', 'ps->emf', 'ps->eps', 'ps->gif', 'ps->ico', 'ps->jpg', 'ps->odd', 'ps->pdf', 'ps->png', 'ps->ps', 'ps->psd', 'ps->svg', 'ps->tiff', 'ps->webp', 'ps->wmf',
  'pot->emf', 'pot->jpg', 'pot->png', 'pot->ppt',
  'potx->emf', 'potx->jpg', 'potx->odp', 'potx->png', 'potx->ppt',
  'pps->eps', 'pps->md', 'pps->ppt',
  'ppsx->eps', 'ppsx->jpg', 'ppsx->md', 'ppsx->png', 'ppsx->ppt',
  'ppt->emf', 'ppt->eps', 'ppt->jpg', 'ppt->md', 'ppt->odp', 'ppt->png',
  'pptm->emf', 'pptm->eps', 'pptm->jpg', 'pptm->md', 'pptm->png', 'pptm->ppt',
  'pptx->emf', 'pptx->eps', 'pptx->jpg', 'pptx->md', 'pptx->png', 'pptx->ppt',
  'rtf->doc', 'rtf->jpg', 'rtf->png',
  'xls->jpg', 'xls->png',
  'xlsm->jpg', 'xlsm->png',
  'xlsx->jpg', 'xlsx->png',
  // A BIFF8 workbook: the office suite writes it, from the XLSX workbook the in-process engine writes or from the source it reads.
  'csv->xls', 'tsv->xls', 'json->xls', 'parquet->xls', 'ndjson->xls', 'jsonl->xls', 'yaml->xls', 'yml->xls', 'xml->xls', 'et->xls', 'pdf->xls', 'xlsx->xls', 'xlsm->xls', 'ods->xls', 'numbers->xls',
  // Subtitles: FFmpeg reads SubRip, WebVTT, ASS, SSA and MicroDVD and writes SubRip, WebVTT and ASS; no other engine does.
  'srt->vtt', 'srt->ass', 'vtt->srt', 'vtt->ass', 'ass->srt', 'ass->vtt', 'ssa->srt', 'ssa->vtt', 'sub->srt', 'sub->vtt', 'sub->ass',
  'xps->avif', 'xps->bmp', 'xps->eps', 'xps->gif', 'xps->ico', 'xps->jpg', 'xps->odd', 'xps->pdf', 'xps->png', 'xps->ps', 'xps->psd', 'xps->svg', 'xps->tiff', 'xps->webp',
]);

function normalizeFormat(format: string): string {
  return format.toLowerCase().replace(/^\./, '').trim();
}

/** Whether a pair can only be converted by a native engine: the pairs listed above, every pair that ends in a format only calibre writes, and every pair of a book only calibre reads, and the text pairs pandoc writes (LaTeX and reStructuredText). */
export function requiresNativeEngine(sourceFormat: string, targetFormat: string): boolean {
  return NATIVE_ENGINE_ONLY_PAIRS.has(`${normalizeFormat(sourceFormat)}->${normalizeFormat(targetFormat)}`) || isCalibreOnlyPair(normalizeFormat(sourceFormat), normalizeFormat(targetFormat)) || isPandocPair(normalizeFormat(sourceFormat), normalizeFormat(targetFormat));
}

/**
 * The typed error for a target a source's in-process converter has no code for: a missing LibreOffice engine (503)
 * when LibreOffice writes that target, otherwise an unsupported target (400).
 */
export function unconvertibleOfficeTarget(source: string, target: string): EngineUnavailableError | UnsupportedTargetError {
  const label = source.toUpperCase();
  if (requiresNativeEngine(source, target)) {
    return new EngineUnavailableError(
      'soffice',
      `Converting ${label} to .${target} needs the native LibreOffice engine; the in-process engine has no writer or renderer for it.`
    );
  }
  return new UnsupportedTargetError(`Cannot convert ${label} documents to '.${target}'.`);
}
