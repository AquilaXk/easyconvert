import { MAX_PAGE_SPEC_CHARS } from '@/lib/conversions/page-range';

/** Pages as the `pages` option writes them: `3`, `2-5`, `4-`, `-3`, comma separated. */
const PAGE_SPEC_PATTERN = String.raw`^[0-9,\-\s]+$`;

/** A page specification option: the grammar of the `pages` option, at most `MAX_PAGE_SPEC_CHARS` characters. */
export function pageSpecSchema(description: string) {
  return { type: 'string', pattern: PAGE_SPEC_PATTERN, maxLength: MAX_PAGE_SPEC_CHARS, description } as const;
}
