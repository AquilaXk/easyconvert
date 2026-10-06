import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { oracleTest } from './helpers/oracle-test';
import {
  HTTP_UNPROCESSABLE,
  TASK_EXCEPTION_REPORT,
  convertRoutes,
  createApiKey,
  createValidatorScripts,
  withValidator,
  type RouteCall,
  type ValidatorScripts,
} from './helpers/pdfa-route-harness';
import { verifyPdfA } from '../src/lib/conversions/pdf-postprocess';
import { PdfPostprocessError } from '../src/lib/types';

/**
 * A PDF/A post-processing failure caused by the document (a validator that cannot read the file,
 * a file that is not the requested PDF/A level, a file that is not a PDF) is a typed 422 on every
 * convert route. The problem body never carries a path or a command line.
 */

const SAMPLE_DOCX = fs.readFileSync(path.resolve(__dirname, 'fixtures', 'sample.docx'));
const CONVERT_TIMEOUT_MS = 180_000;
const POSTPROCESS_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/pdf-postprocess-failed';
const NOT_A_PDF = Buffer.from('this is not a pdf document');
/** Exits non-zero after printing the JSON report veraPDF prints for a file it cannot open. */
const VALIDATOR_FAILED_EXIT = 7;

let validators: ValidatorScripts;
let routes: RouteCall[];

beforeAll(async () => {
  validators = createValidatorScripts();
  routes = convertRoutes(await createApiKey());
});

afterAll(() => {
  validators.dispose();
});

describe('verifyPdfA on a file that is not a PDF', () => {
  it('throws a typed post-processing error instead of the parser error', async () => {
    const passing = validators.printing('verapdf-compliant', '{"report":{"jobs":[{"validationResult":[{"compliant":true}]}]}}', 0);
    const run = withValidator(passing, () => verifyPdfA(NOT_A_PDF, 'pdfa-2b'));

    await expect(run).rejects.toBeInstanceOf(PdfPostprocessError);
    await expect(run).rejects.toThrow('The PDF/A output could not be read as a PDF document.');
  });
});

describe.each([0, 1, 2])('PDF/A post-processing failures on convert route %#', (routeIndex) => {
  oracleTest(
    'answers 422 when the validator reports a task exception and no validation result',
    ['soffice'],
    async () => {
      const validator = validators.printing('verapdf-exception', TASK_EXCEPTION_REPORT, VALIDATOR_FAILED_EXIT);
      const route = routes[routeIndex];

      const res = await withValidator(validator, () =>
        route.call(SAMPLE_DOCX, 'sample.docx', 'pdf', { pdfa: { conformance: 'pdfa-2b' } })
      );

      expect(res.status).toBe(HTTP_UNPROCESSABLE);
      const body = await res.text();
      expect(JSON.parse(body)).toMatchObject({
        status: HTTP_UNPROCESSABLE,
        type: POSTPROCESS_PROBLEM_TYPE,
        detail: 'The PDF/A validator could not process the document.',
      });
      expect(body).not.toContain('/tmp');
    },
    CONVERT_TIMEOUT_MS
  );

  oracleTest(
    'answers 422 when the export is not the requested PDF/A level',
    ['soffice'],
    async () => {
      const validator = validators.printing('verapdf-compliant', '{"report":{"jobs":[{"validationResult":[{"compliant":true}]}]}}', 0);
      const route = routes[routeIndex];

      // A custom export filter without a PDF version writes a plain PDF.
      const res = await withValidator(validator, () =>
        route.call(SAMPLE_DOCX, 'sample.docx', 'pdf', {
          pdfa: { conformance: 'pdfa-2b' },
          libreOfficeFilter: 'writer_pdf_Export',
        })
      );

      expect(res.status).toBe(HTTP_UNPROCESSABLE);
      expect(await res.json()).toMatchObject({ type: POSTPROCESS_PROBLEM_TYPE });
    },
    CONVERT_TIMEOUT_MS
  );
});

it('keeps the route test fixtures in step with the supported routes', () => {
  expect(routes.map((route) => route.name)).toEqual([
    'POST /api/v1/convert',
    'POST /api/convert',
    'POST /api/convert/batch',
  ]);
});
