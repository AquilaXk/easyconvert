import { describe, expect, it } from 'vitest';
import { POSTSCRIPT_PAGES_MAX_BYTES, assertPostScriptPagesWithinLimit } from '../src/worker/postscript-page-limit';
import { PayloadLimitError } from '../src/lib/types';

describe('the bytes of the EPS pages written for one request', () => {
  it('lets pages up to the limit through', () => {
    expect(assertPostScriptPagesWithinLimit(POSTSCRIPT_PAGES_MAX_BYTES)).toBeUndefined();
  });

  it('refuses a request past the limit with the way to narrow it, before the pages are bundled', () => {
    expect(() => assertPostScriptPagesWithinLimit(POSTSCRIPT_PAGES_MAX_BYTES + 1)).toThrow(PayloadLimitError);
    expect(() => assertPostScriptPagesWithinLimit(POSTSCRIPT_PAGES_MAX_BYTES + 1)).toThrow(/"pages".*"multiPageOutput"/);
  });
});
