import { MAX_PAGE_SPEC_CHARS } from '@/lib/conversions/page-range';

/** Options of the PDF page operations of a job graph: split, rotate, reorder and optimize. */

/** Pages as the `pages` option writes them: `3`, `2-5`, `4-`, `-3`, comma separated. */
const PAGE_SPEC_PATTERN = String.raw`^[0-9,\-\s]+$`;
const MAX_SPLIT_RANGES_PARTS = 1000;

/** A page specification option: the grammar of the `pages` option, at most `MAX_PAGE_SPEC_CHARS` characters. */
export function pageSpecSchema(description: string) {
  return { type: 'string', pattern: PAGE_SPEC_PATTERN, maxLength: MAX_PAGE_SPEC_CHARS, description } as const;
}

export const PdfSplitOptionsSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'pdf.split-pages node: cuts the PDF into parts and returns one ZIP of PDFs. Give `ranges` or `everyNPages`; with neither, every page becomes a file of its own.',
  properties: {
    ranges: pageSpecSchema(`One part per comma separated range, in the order written (for example "1-3,4-6,7-"). At most ${MAX_SPLIT_RANGES_PARTS} parts.`),
    everyNPages: {
      type: 'integer',
      minimum: 1,
      description: 'One part per this many pages; the last part holds the remainder.',
    },
  },
} as const;

const PdfRotationDegreesSchema = {
  type: 'integer',
  enum: [90, 180, 270],
  description: 'Degrees clockwise, added to the rotation the page already has.',
} as const;

export const PdfRotateOptionsSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'pdf.rotate-pages node. Give `rotation` (for `pages`, every page when omitted), or `rotations` to turn several groups of pages by different amounts; not both.',
  properties: {
    rotation: PdfRotationDegreesSchema,
    pages: pageSpecSchema('Pages to turn (for example "1-3,5" or "2-"). Every page when omitted.'),
    rotations: {
      type: 'array',
      minItems: 1,
      description: 'One entry per group of pages; a page in two groups turns by both.',
      items: {
        type: 'object',
        required: ['rotation'],
        additionalProperties: false,
        properties: {
          rotation: PdfRotationDegreesSchema,
          pages: pageSpecSchema('Pages of this group. Every page when omitted.'),
        },
      },
    },
  },
} as const;

export const PdfReorderOptionsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['order'],
  description: 'pdf.reorder-pages node.',
  properties: {
    order: pageSpecSchema('The pages to put first, in the new order (for example "3,1,2" or "4-6,1-3"); a full order lists every page once. Pages not listed follow in their original order, so no page is lost. A page listed twice answers 400.'),
  },
} as const;

export const PdfOptimizeOptionsSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'optimize node on a PDF. The result is never larger than the input: when the profile gains nothing the input is returned and the node reports `optimized: false`.',
  properties: {
    profile: {
      type: 'string',
      enum: ['web', 'print', 'archive', 'max'],
      default: 'web',
      description:
        '`web`: images downsampled to 150 dpi and recompressed. `print`: 300 dpi. `archive`: lossless, only streams and structure are repacked. `max`: 72 dpi and strong JPEG compression.',
    },
  },
} as const;
