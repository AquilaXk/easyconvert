import { OCR_MAX_LANGUAGES_PER_REQUEST } from '@/lib/conversions/ocr-languages';

/** One language code (letters, digits, `-` and `_`), then up to the per-request limit of further ones joined with `+`. */
const OCR_LANGUAGE_PATTERN = `^[A-Za-z0-9_-]+(\\+[A-Za-z0-9_-]+){0,${OCR_MAX_LANGUAGES_PER_REQUEST - 1}}$`;

/** The OCR options of a conversion request, in the order the schema lists them. */
export const OcrOptionProperties = {
  ocrEnabled: {
    type: 'boolean',
    description: 'Enable optical character recognition for raster inputs.',
  },
  ocrLanguage: {
    type: 'string',
    minLength: 1,
    maxLength: 128,
    pattern: OCR_LANGUAGE_PATTERN,
    description:
      `OCR language: \`auto\` (English), or a language by traineddata name, ISO 639-1 code or BCP 47 tag (\`kor\`, \`ko\`, \`zh-Hans\`, \`sr-Latn\`). Join up to ${OCR_MAX_LANGUAGES_PER_REQUEST} with \`+\` (\`eng+kor\`). An unknown code or too many languages is a 400; a known language whose data is not installed is a 503. GET /api/v1/ocr/languages lists the languages and which are installed.`,
  },
  ocrMode: {
    type: 'string',
    enum: ['skip_text', 'skip-text', 'force', 'redo'],
    description: 'OCR multi-page processing strategy: skip digital text pages or force full OCR.',
  },
  ocrDetectOrientation: {
    type: 'boolean',
    description:
      'Detect the page orientation and script of scans that read badly, and read them again turned upright. Omit it to detect when the OCR orientation data is installed; true requires it and fails with 503 when it is missing; false never detects.',
  },
  ocrDeskew: {
    type: 'boolean',
    description:
      'Level skewed pages of a searchable PDF (like `ocrmypdf --deskew`): the page content is turned by the measured skew, up to 20 degrees, without resampling the scan, so that text extractors that regroup words by position read the lines in order. The page grows when a recognised word would leave it, and the corners the turn carries past the page are cut off. Omit it or send false to keep the page as scanned.',
  },
  ocrEngineMarkup: {
    type: 'string',
    enum: ['hocr', 'alto'],
    description:
      'Debug and verification only: also return the OCR engine\'s own hOCR or ALTO of each recognized PDF page in the result metadata, next to the product export. Needs the tesseract command line (503 when missing).',
  },
  ocrDensityThreshold: {
    type: 'number',
    minimum: 0,
    description: 'Minimum characters per page required to consider a digital text layer present.',
  },
} as const;
