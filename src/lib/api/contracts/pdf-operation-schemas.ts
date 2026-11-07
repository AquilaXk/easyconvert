import { pageSpecSchema } from './page-spec-schema';

/** Options of the PDF page operations of a job graph: split, rotate, reorder and optimize. */

const MAX_SPLIT_RANGES_PARTS = 1000;

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

export const PdfWatermarkOptionsSchema = {
  $id: 'https://easyconvert.local/schemas/pdf-watermark-options.json',
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['text', 'image'] },
    text: { type: 'string', description: 'Watermark text.' },
    fontSize: { type: 'number', minimum: 6, maximum: 200, description: 'Font size in points.' },
    fontColor: {
      type: 'string',
      pattern: '^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})|rgb\\(\\s*[0-9]{1,3}\\s*,\\s*[0-9]{1,3}\\s*,\\s*[0-9]{1,3}\\s*\\))$',
      description: 'Text colour as `#rgb`, `#rrggbb` or `rgb(r,g,b)`. Any other value is a 400.',
    },
    fontFamily: { type: 'string', description: 'Font family name.' },
    image: { type: 'string', description: 'Base64 image data or URI.' },
    imageType: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format type.' },
    opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Watermark opacity (0.0 - 1.0).' },
    rotation: { type: 'number', description: 'Rotation in degrees.' },
    position: {
      type: 'string',
      enum: [
        'tile',
        'top-left',
        'top-center',
        'top-right',
        'center-left',
        'center',
        'center-right',
        'bottom-left',
        'bottom-center',
        'bottom-right',
      ],
      description: 'Position on page or tile across entire page.',
    },
    pages: { type: 'string', description: 'Page ranges to watermark (e.g. 1-3,5).' },
    layer: { type: 'string', enum: ['over', 'under'], description: 'Draw on top of or beneath page content.' },
    scale: { type: 'number', minimum: 0.01, maximum: 10, description: 'Scaling factor.' },
  },
} as const;

/**
 * Longest password the API accepts, in characters. A password is sealed for the queue, and a blob holds 64 KiB: the
 * longest list of passwords (MAX_PASSWORD_LIST_ITEMS of them, each written with six-byte escapes) stays below that.
 */
export const MAX_PASSWORD_LENGTH = 256;
export const MAX_PASSWORD_LIST_ITEMS = 32;

export const PdfProtectOptionsSchema = {
  $id: 'https://easyconvert.local/schemas/pdf-protect-options.json',
  type: 'object',
  properties: {
    userPassword: { type: 'string', maxLength: MAX_PASSWORD_LENGTH, description: 'Password required to open the PDF.' },
    ownerPassword: { type: 'string', maxLength: MAX_PASSWORD_LENGTH, description: 'Master password required to modify permissions.' },
    keyLength: { type: 'integer', enum: [128, 256], description: 'Encryption key bit length (default 256).' },
    permissions: {
      type: 'object',
      properties: {
        print: { type: 'string', enum: ['none', 'low', 'full'], description: 'Allowed printing quality.' },
        modify: { type: 'string', enum: ['none', 'assembly', 'annotate', 'form', 'all'], description: 'Allowed modifications.' },
        extract: { type: 'boolean', description: 'Allow text and graphic extraction.' },
        annotate: { type: 'boolean', description: 'Allow comments and form filling.' },
      },
    },
  },
} as const;

export const PdfAOptionsSchema = {
  $id: 'https://easyconvert.local/schemas/pdfa-options.json',
  type: 'object',
  properties: {
    conformance: { type: 'string', enum: ['pdfa-1b', 'pdfa-2b', 'pdfa-3b'], description: 'PDF/A conformance level. Defaults to pdfa-2b.' },
    recalculate: { type: 'boolean', description: 'Trigger recalculation during conversion.' },
  },
} as const;
