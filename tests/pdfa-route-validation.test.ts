import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { oracleTest } from './helpers/oracle-test';
import {
  HTTP_UNPROCESSABLE,
  NON_COMPLIANT_REPORT,
  NON_COMPLIANT_RULES,
  convertRoutes,
  createApiKey,
  createValidatorScripts,
  withValidator,
  type RouteCall,
  type ValidatorScripts,
} from './helpers/pdfa-route-harness';

/**
 * A PDF/A request whose output the validator rejects is answered with a 422 problem that names
 * the requested profile and the failed rule IDs, on every synchronous convert route. The
 * validator is a script that prints the report veraPDF prints for a file that breaks two rules of
 * ISO 19005-2; the conversion and the routes are the real ones.
 */

const SAMPLE_DOCX = fs.readFileSync(path.resolve(__dirname, 'fixtures', 'sample.docx'));
const CONVERT_TIMEOUT_MS = 180_000;
const PDFA_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/pdfa-validation-failed';
/** veraPDF exits with 1 when a file is not compliant. */
const NON_COMPLIANT_EXIT = 1;

let validators: ValidatorScripts;
let routes: RouteCall[];

beforeAll(async () => {
  validators = createValidatorScripts();
  routes = convertRoutes(await createApiKey());
});

afterAll(() => {
  validators.dispose();
});

describe.each([0, 1, 2])('a non-compliant PDF/A output on convert route %#', (routeIndex) => {
  oracleTest(
    'answers 422 with the PDF/A problem type, the profile and the failed rule IDs',
    ['soffice'],
    async () => {
      const validator = validators.printing('verapdf-noncompliant', NON_COMPLIANT_REPORT, NON_COMPLIANT_EXIT);

      const res = await withValidator(validator, () =>
        routes[routeIndex].call(SAMPLE_DOCX, 'sample.docx', 'pdf', { pdfa: { conformance: 'pdfa-2b' } })
      );

      expect(res.status).toBe(HTTP_UNPROCESSABLE);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      const problem = await res.json();
      expect(problem).toMatchObject({
        status: HTTP_UNPROCESSABLE,
        type: PDFA_PROBLEM_TYPE,
        profile: 'pdfa-2b',
        failedRules: NON_COMPLIANT_RULES,
      });
      expect(problem.detail).toContain(NON_COMPLIANT_RULES.join(', '));
    },
    CONVERT_TIMEOUT_MS
  );
});

it('names the route under test for each index', () => {
  expect(routes.map((route) => route.name)).toEqual([
    'POST /api/v1/convert',
    'POST /api/convert',
    'POST /api/convert/batch',
  ]);
});
