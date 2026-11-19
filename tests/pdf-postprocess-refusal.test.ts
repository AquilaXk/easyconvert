import { describe, expect, it } from 'vitest';
import { createPdfPostprocessResponse } from '../src/lib/api/problem-details';
import { classifyJobFailure } from '../src/lib/queue/job-failure';
import { refusalCodeOf } from '../src/lib/refusal-codes';
import { ConversionFailedError, PdfAValidationError, PdfPostprocessError, isTypedRefusal, typedFailureOf } from '../src/lib/types';
import en from '../messages/en.json';
import ko from '../messages/ko.json';

/**
 * A PDF step the document made fail (a page range that names every page, a PDF qpdf cannot open, a PDF/A output that does not validate) is a
 * typed refusal with its own code: the tools API answers 422 with it where it answered 500, the queue does not run the job again, and the
 * convert routes carry the code in the problem they already sent.
 */

const ERRORS: ReadonlyArray<readonly [string, PdfPostprocessError, string]> = [
  ['PdfPostprocessError', new PdfPostprocessError('Deleting the pages failed: the specification names every page, and a PDF needs at least one.'), 'pdf-postprocess-failed'],
  ['PdfAValidationError', new PdfAValidationError('pdfa-2b', ['6.2.11.4.1-1']), 'pdfa-validation-failed'],
];

describe.each(ERRORS)('%s', (_name, error, problem) => {
  it('is a conversion failure with the code, the 422 and no retry that the answers read', () => {
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect(refusalCodeOf(error)).toBe('pdf_postprocess_failed');
    expect(typedFailureOf(error)).toEqual({ status: 422, code: 'pdf_postprocess_failed' });
    expect(isTypedRefusal(error)).toBe(true);
    expect(classifyJobFailure(error)).toEqual({ code: error.name, status: 422, retryable: false });
  });

  it('is answered by the convert routes with the code next to its problem type', async () => {
    const response = createPdfPostprocessResponse(error, '/api/v1/convert');
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'pdf_postprocess_failed', type: `https://api.easyconvert.io/problems/${problem}`, detail: error.message });
  });
});

describe('the sentence of the code', () => {
  it('is worded in English and Korean', () => {
    expect(en.errors.conversion.pdf_postprocess_failed).toMatch(/^The PDF step could not be applied/);
    expect(ko.errors.conversion.pdf_postprocess_failed).toMatch(/^이 파일에는 PDF 처리를 적용할 수 없습니다\./);
  });
});
