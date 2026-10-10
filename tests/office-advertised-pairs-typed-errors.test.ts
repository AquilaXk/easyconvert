import { describe, expect } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { classifyJobFailure } from '../src/lib/queue/job-failure';
import { ConversionFailedError, EngineUnavailableError, UnsupportedTargetError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { withMissingBinary } from './helpers/native-tools';
import { authorWithReferenceSuite, type OfficeSource } from './helpers/office-pair-fixtures';

/**
 * No conversion path of the advertised legacy Office pairs throws a plain Error, which the API answers with 500.
 * A pair only LibreOffice converts fails with EngineUnavailableError (503) where the engine is missing; a target
 * nothing converts fails with UnsupportedTargetError (400).
 */

const TEST_TIMEOUT_MS = 180_000;
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_BAD_REQUEST = 400;

/** The pairs of issue 631, then the pairs of the same sources that share the same code path. */
const ADVERTISED_NATIVE_PAIRS: ReadonlyArray<readonly [OfficeSource, string]> = [
  ['ppt', 'odp'],
  ['ppt', 'png'],
  ['ppt', 'jpg'],
  ['xls', 'png'],
  ['xls', 'jpg'],
  ['doc', 'jpg'],
  ['doc', 'png'],
  ['rtf', 'doc'],
  ['doc', 'rtf'],
  ['rtf', 'png'],
  ['rtf', 'jpg'],
  ['odp', 'ppt'],
  ['odp', 'png'],
  ['odp', 'jpg'],
  ['odt', 'doc'],
  ['odt', 'rtf'],
  ['odt', 'png'],
  ['odt', 'jpg'],
  ['ods', 'png'],
  ['ods', 'jpg'],
  ['pptx', 'ppt'],
  ['pptx', 'png'],
  ['pptx', 'jpg'],
  ['xlsx', 'png'],
  ['xlsx', 'jpg'],
];

const SOURCES: readonly OfficeSource[] = ['ppt', 'xls', 'doc', 'rtf', 'odp', 'odt', 'ods', 'pptx', 'xlsx', 'docx'];

const fixtures = new Map<OfficeSource, Buffer>();
function fixture(source: OfficeSource): Buffer {
  let bytes = fixtures.get(source);
  if (!bytes) {
    bytes = authorWithReferenceSuite(source);
    fixtures.set(source, bytes);
  }
  return bytes;
}

describe('in-process engine', () => {
  for (const [source, target] of ADVERTISED_NATIVE_PAIRS) {
    oracleTest(
      `${source} -> ${target} names the missing LibreOffice engine`,
      ['soffice'],
      async () => {
        const run = convertFile(fixture(source), source, target, {}, `fixture.${source}`);
        await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
        const error = await run.catch((caught: unknown) => caught);
        expect(error).toMatchObject({ engineName: 'soffice' });
        expect(classifyJobFailure(error)).toEqual({ code: 'EngineUnavailableError', status: HTTP_SERVICE_UNAVAILABLE, retryable: true });
      },
      TEST_TIMEOUT_MS
    );
  }

  for (const source of SOURCES) {
    oracleTest(
      `every target advertised for ${source} converts or fails with a typed conversion error`,
      ['soffice'],
      async () => {
        const untyped: string[] = [];
        for (const target of FORMAT_REGISTRY[source].targetFormats) {
          try {
            await convertFile(fixture(source), source, target, {}, `fixture.${source}`);
          } catch (error) {
            if (!(error instanceof ConversionFailedError)) {
              untyped.push(`${source} -> ${target}: ${error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error)}`);
            }
          }
        }
        expect(untyped).toEqual([]);
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'a target the registry does not list for the source is an UnsupportedTargetError',
    ['soffice'],
    async () => {
      for (const source of ['ppt', 'xls', 'doc', 'rtf'] as const) {
        const run = convertFile(fixture(source), source, 'mp3', {}, `fixture.${source}`);
        await expect(run).rejects.toBeInstanceOf(UnsupportedTargetError);
        expect(classifyJobFailure(await run.catch((caught: unknown) => caught))).toMatchObject({ status: HTTP_BAD_REQUEST, retryable: false });
        await expect(run).rejects.toThrow(new RegExp(`^Cannot convert from .+ \\(\\.${source}\\) to target format \\.mp3\\. Available targets: `));
      }
    },
    TEST_TIMEOUT_MS
  );
});

describe('dispatcher without LibreOffice', () => {
  for (const [source, target] of ADVERTISED_NATIVE_PAIRS) {
    oracleTest(
      `${source} -> ${target} fails with EngineUnavailableError and never runs in-process`,
      ['soffice'],
      async () => {
        const input = fixture(source);
        const run = withMissingBinary('SOFFICE_PATH', () => dispatchConversion(input, source, target, {}, `fixture.${source}`));
        await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
        const error = await run.catch((caught: unknown) => caught);
        expect(error).toMatchObject({ engineName: 'soffice' });
        expect(classifyJobFailure(error)).toEqual({ code: 'EngineUnavailableError', status: HTTP_SERVICE_UNAVAILABLE, retryable: true });
      },
      TEST_TIMEOUT_MS
    );
  }
});
