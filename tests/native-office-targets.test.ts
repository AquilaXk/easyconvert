import { describe, expect, it } from 'vitest';
import { NATIVE_OFFICE_TARGETS, unconvertibleOfficeTarget } from '../src/lib/conversions/native-office-targets';
import { requiresNativeEngine } from '../src/lib/conversions/dispatch';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { classifyJobFailure } from '../src/lib/queue/job-failure';
import { EngineUnavailableError, UnsupportedTargetError } from '../src/lib/types';

const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_BAD_REQUEST = 400;

describe('targets only LibreOffice writes', () => {
  it('lists exactly the advertised pairs of these sources that the dispatcher refuses to run in-process', () => {
    const fromDispatcher: string[] = [];
    for (const source of Object.keys(NATIVE_OFFICE_TARGETS)) {
      for (const target of FORMAT_REGISTRY[source].targetFormats) {
        if (requiresNativeEngine(source, target)) fromDispatcher.push(`${source}->${target}`);
      }
    }
    const fromTable = Object.entries(NATIVE_OFFICE_TARGETS).flatMap(([source, targets]) => [...targets].map((target) => `${source}->${target}`));
    expect(fromTable.sort()).toEqual(fromDispatcher.sort());
  });

  it('never withdraws a pair: every listed target is still advertised for its source', () => {
    for (const [source, targets] of Object.entries(NATIVE_OFFICE_TARGETS)) {
      for (const target of targets) {
        expect(FORMAT_REGISTRY[source].targetFormats, `${source} -> ${target}`).toContain(target);
      }
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
