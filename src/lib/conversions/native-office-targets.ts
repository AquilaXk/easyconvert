import { EngineUnavailableError, UnsupportedTargetError } from '../types';

/**
 * Targets of the legacy and OpenDocument Office sources that only LibreOffice writes or renders: the in-process
 * engine has no writer for the binary Word, PowerPoint and RTF formats and no page renderer for the image targets.
 * The registry advertises every one of these pairs and the dispatcher routes them to LibreOffice (page images through
 * Poppler); the in-process engine reports the missing engine instead of failing with an untyped error.
 */
export const NATIVE_OFFICE_TARGETS: Readonly<Record<string, ReadonlySet<string>>> = {
  doc: new Set(['jpg', 'png', 'rtf']),
  ods: new Set(['jpg', 'png']),
  odp: new Set(['jpg', 'png', 'ppt']),
  odt: new Set(['doc', 'jpg', 'png', 'rtf']),
  ppt: new Set(['jpg', 'odp', 'png']),
  pptx: new Set(['jpg', 'png', 'ppt']),
  rtf: new Set(['doc', 'jpg', 'png']),
  xls: new Set(['jpg', 'png']),
  xlsx: new Set(['jpg', 'png']),
};

/**
 * The typed error for a target a source's in-process converter has no code for: a missing LibreOffice engine (503)
 * when LibreOffice writes that target, otherwise an unsupported target (400).
 */
export function unconvertibleOfficeTarget(source: string, target: string): EngineUnavailableError | UnsupportedTargetError {
  const label = source.toUpperCase();
  if (NATIVE_OFFICE_TARGETS[source]?.has(target)) {
    return new EngineUnavailableError(
      'soffice',
      `Converting ${label} to .${target} needs the native LibreOffice engine; the in-process engine has no writer or renderer for it.`
    );
  }
  return new UnsupportedTargetError(`Cannot convert ${label} documents to '.${target}'.`);
}
