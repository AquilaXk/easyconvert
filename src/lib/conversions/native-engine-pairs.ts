import { EngineUnavailableError, UnsupportedTargetError } from '../types';
import { isCalibreEbookTarget } from './calibre-ebook-targets';

/**
 * Pairs that only a native engine converts: the in-process engine has no code path for them.
 * LibreOffice converts between Office formats and, chained with Poppler, renders Office
 * documents to raster images; Poppler renders PDF to SVG; GhostXPS draws XPS documents; ddjvu draws DjVu documents. When the native engine is missing,
 * these pairs fail with EngineUnavailableError instead of falling back to the in-process engine.
 */
const NATIVE_ENGINE_ONLY_PAIRS: ReadonlySet<string> = new Set([
  'doc->jpg', 'doc->png', 'doc->rtf',
  'eps->avif', 'eps->bmp', 'eps->dxf', 'eps->eps', 'eps->gif', 'eps->jpg', 'eps->pdf', 'eps->png', 'eps->ps', 'eps->svg', 'eps->tiff', 'eps->webp',
  'djv->avif', 'djv->bmp', 'djv->eps', 'djv->gif', 'djv->ico', 'djv->jpg', 'djv->pdf', 'djv->png', 'djv->ps', 'djv->psd', 'djv->svg', 'djv->tiff', 'djv->webp',
  'djvu->avif', 'djvu->bmp', 'djvu->eps', 'djvu->gif', 'djvu->ico', 'djvu->jpg', 'djvu->pdf', 'djvu->png', 'djvu->ps', 'djvu->psd', 'djvu->svg', 'djvu->tiff', 'djvu->webp',
  // Macro-enabled documents and Word templates: the office suite writes them as Word 97, RTF and page images, as it writes a Word document.
  'docm->doc', 'docm->jpg', 'docm->png', 'docm->rtf',
  'docx->doc', 'docx->jpg', 'docx->png', 'docx->rtf',
  'dot->doc', 'dot->jpg', 'dot->png', 'dot->rtf',
  'dotx->doc', 'dotx->jpg', 'dotx->png', 'dotx->rtf',
  // Text and markup: the in-process converter writes their DOCX or PDF, and the office suite writes Word 97 and RTF from the DOCX or Poppler draws the PDF pages.
  'html->doc', 'html->jpg', 'html->png', 'html->rtf',
  'md->doc', 'md->jpg', 'md->png', 'md->rtf',
  'txt->doc', 'txt->jpg', 'txt->png', 'txt->rtf',
  'rst->rtf',
  'key->html', 'key->pdf', 'key->pptx',
  'odd->avif', 'odd->bmp', 'odd->eps', 'odd->gif', 'odd->ico', 'odd->jpg', 'odd->odd', 'odd->pdf', 'odd->png', 'odd->ps', 'odd->psd', 'odd->tiff', 'odd->webp',
  'odg->bmp', 'odg->jpg', 'odg->pdf', 'odg->png',
  'odp->jpg', 'odp->png', 'odp->ppt',
  'ods->jpg', 'ods->png',
  'odt->doc', 'odt->jpg', 'odt->png', 'odt->rtf',
  'oxps->avif', 'oxps->bmp', 'oxps->eps', 'oxps->gif', 'oxps->ico', 'oxps->jpg', 'oxps->pdf', 'oxps->png', 'oxps->ps', 'oxps->psd', 'oxps->svg', 'oxps->tiff', 'oxps->webp',
  'pdf->avif', 'pdf->bmp', 'pdf->doc', 'pdf->dxf', 'pdf->eps', 'pdf->gif', 'pdf->ico', 'pdf->odd', 'pdf->ps', 'pdf->psd', 'pdf->svg', 'pdf->webp',
  'ps->avif', 'ps->bmp', 'ps->dxf', 'ps->eps', 'ps->gif', 'ps->jpg', 'ps->pdf', 'ps->png', 'ps->ps', 'ps->svg', 'ps->tiff', 'ps->webp',
  'pps->ppt',
  'ppt->jpg', 'ppt->odp', 'ppt->png',
  'pptx->jpg', 'pptx->png', 'pptx->ppt',
  'rtf->doc', 'rtf->jpg', 'rtf->png',
  'xls->jpg', 'xls->png',
  'xlsx->jpg', 'xlsx->png',
  // A BIFF8 workbook: the office suite writes it, from the XLSX workbook the in-process engine writes or from the source it reads.
  'csv->xls', 'tsv->xls', 'json->xls', 'parquet->xls', 'ndjson->xls', 'jsonl->xls', 'yaml->xls', 'yml->xls', 'xml->xls', 'et->xls', 'pdf->xls', 'xlsx->xls', 'xlsm->xls', 'ods->xls', 'numbers->xls',
  'xps->avif', 'xps->bmp', 'xps->eps', 'xps->gif', 'xps->ico', 'xps->jpg', 'xps->odd', 'xps->pdf', 'xps->png', 'xps->ps', 'xps->psd', 'xps->svg', 'xps->tiff', 'xps->webp',
]);

function normalizeFormat(format: string): string {
  return format.toLowerCase().replace(/^\./, '').trim();
}

/** Whether a pair can only be converted by a native engine: the pairs listed above, and every pair that ends in a format only calibre writes. */
export function requiresNativeEngine(sourceFormat: string, targetFormat: string): boolean {
  return NATIVE_ENGINE_ONLY_PAIRS.has(`${normalizeFormat(sourceFormat)}->${normalizeFormat(targetFormat)}`) || isCalibreEbookTarget(normalizeFormat(targetFormat));
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
