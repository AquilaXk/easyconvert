import { EngineUnavailableError, UnsupportedTargetError } from '../types';

/**
 * Pairs that only a native engine converts: the in-process engine has no code path for them.
 * LibreOffice converts between Office formats and, chained with Poppler, renders Office
 * documents to raster images; Poppler renders PDF to SVG. When the native engine is missing,
 * these pairs fail with EngineUnavailableError instead of falling back to the in-process engine.
 */
const NATIVE_ENGINE_ONLY_PAIRS: ReadonlySet<string> = new Set([
  'doc->jpg', 'doc->png', 'doc->rtf',
  'eps->avif', 'eps->bmp', 'eps->dxf', 'eps->eps', 'eps->gif', 'eps->jpg', 'eps->pdf', 'eps->png', 'eps->ps', 'eps->svg', 'eps->tiff', 'eps->webp',
  'docx->doc', 'docx->jpg', 'docx->png', 'docx->rtf',
  'key->html', 'key->pdf', 'key->pptx',
  'odd->avif', 'odd->bmp', 'odd->eps', 'odd->gif', 'odd->ico', 'odd->jpg', 'odd->odd', 'odd->pdf', 'odd->png', 'odd->ps', 'odd->psd', 'odd->tiff', 'odd->webp',
  'odg->bmp', 'odg->jpg', 'odg->pdf', 'odg->png',
  'odp->jpg', 'odp->png', 'odp->ppt',
  'ods->jpg', 'ods->png',
  'odt->doc', 'odt->jpg', 'odt->png', 'odt->rtf',
  'pdf->svg',
  'ps->avif', 'ps->bmp', 'ps->dxf', 'ps->eps', 'ps->gif', 'ps->jpg', 'ps->pdf', 'ps->png', 'ps->ps', 'ps->svg', 'ps->tiff', 'ps->webp',
  'ppt->jpg', 'ppt->odp', 'ppt->png',
  'pptx->jpg', 'pptx->png', 'pptx->ppt',
  'rtf->doc', 'rtf->jpg', 'rtf->png',
  'xls->jpg', 'xls->png',
  'xlsx->jpg', 'xlsx->png',
]);

function normalizeFormat(format: string): string {
  return format.toLowerCase().replace(/^\./, '').trim();
}

/** Whether a pair can only be converted by a native engine. */
export function requiresNativeEngine(sourceFormat: string, targetFormat: string): boolean {
  return NATIVE_ENGINE_ONLY_PAIRS.has(`${normalizeFormat(sourceFormat)}->${normalizeFormat(targetFormat)}`);
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
