import { describe, expect, it } from 'vitest';
import { requiresNativeEngine, unconvertibleOfficeTarget } from '../src/lib/conversions/native-engine-pairs';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { classifyJobFailure } from '../src/lib/queue/job-failure';
import { EngineUnavailableError, UnsupportedTargetError } from '../src/lib/types';

const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_BAD_REQUEST = 400;

const OFFICE_PAIRS_NEEDING_LIBREOFFICE: Readonly<Record<string, readonly string[]>> = {
  doc: ['jpg', 'png', 'rtf'],
  ods: ['jpg', 'png'],
  odp: ['jpg', 'png', 'ppt'],
  odt: ['doc', 'jpg', 'png', 'rtf'],
  ppt: ['jpg', 'odp', 'png'],
  pptx: ['jpg', 'png', 'ppt'],
  rtf: ['doc', 'jpg', 'png'],
  xls: ['jpg', 'png'],
  xlsx: ['jpg', 'png'],
};

const OFFICE_SOURCES = ['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp'];

describe('targets only LibreOffice writes', () => {
  it('answers each hand-listed Office pair with a 503 and never withdraws it from the registry', () => {
    let count = 0;
    for (const [source, targets] of Object.entries(OFFICE_PAIRS_NEEDING_LIBREOFFICE)) {
      for (const target of targets) {
        count += 1;
        expect(FORMAT_REGISTRY[source].targetFormats, `${source} -> ${target}`).toContain(target);
        expect(requiresNativeEngine(source, target), `${source} -> ${target}`).toBe(true);
        expect(unconvertibleOfficeTarget(source, target), `${source} -> ${target}`).toBeInstanceOf(EngineUnavailableError);
      }
    }
    expect(count).toBe(25);
  });

  it('answers every Office pair the dispatcher routes to a native engine with the same 503 in-process', () => {
    const routed: string[] = [];
    for (const source of OFFICE_SOURCES) {
      for (const target of FORMAT_REGISTRY[source].targetFormats) {
        if (!requiresNativeEngine(source, target)) continue;
        routed.push(`${source}->${target}`);
        expect(unconvertibleOfficeTarget(source, target), `${source} -> ${target}`).toBeInstanceOf(EngineUnavailableError);
      }
    }
    expect(routed.length).toBeGreaterThanOrEqual(25);
  });

  it('answers advertised Office pairs that LibreOffice does not need with a 400', () => {
    for (const [source, target] of [['xlsx', 'pdf'], ['ppt', 'mp3'], ['doc', 'docx'], ['odt', 'pdf']]) {
      expect(unconvertibleOfficeTarget(source, target).message, `${source} -> ${target}`).toBe(
        `Cannot convert ${source.toUpperCase()} documents to '.${target}'.`
      );
    }
  });

  it('answers a listed pair with a retryable 503 that names the engine and the pair', () => {
    const error = unconvertibleOfficeTarget('ppt', 'odp');
    expect(error).toBeInstanceOf(EngineUnavailableError);
    expect(error).toMatchObject({ engineName: 'soffice' });
    expect(classifyJobFailure(error)).toEqual({ code: 'EngineUnavailableError', status: HTTP_SERVICE_UNAVAILABLE, retryable: true });
    expect(error.message).toBe(
      "Engine 'soffice' is unavailable: Converting PPT to .odp needs the native LibreOffice engine; the in-process engine has no writer or renderer for it."
    );
  });

  it('answers a target nothing writes with a 400 UnsupportedTargetError', () => {
    const error = unconvertibleOfficeTarget('ppt', 'mp3');
    expect(error).toBeInstanceOf(UnsupportedTargetError);
    expect(classifyJobFailure(error)).toMatchObject({ status: HTTP_BAD_REQUEST, retryable: false });
    expect(error.message).toBe("Cannot convert PPT documents to '.mp3'.");
  });

  it('treats a source outside the table like any other unsupported target', () => {
    const error = unconvertibleOfficeTarget('tex', 'png');
    expect(error).toBeInstanceOf(UnsupportedTargetError);
    expect(error.message).toBe("Cannot convert TEX documents to '.png'.");
  });
});
