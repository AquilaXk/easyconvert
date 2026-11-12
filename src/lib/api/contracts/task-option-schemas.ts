/**
 * The `capture` and `metadata` options of the `capture.website` and `metadata.write` tasks (docs/policy-decisions.md, entry 270),
 * kept apart from the rest of the conversion options.
 */

export const CaptureOptionsSchema = {
  type: 'object',
  description:
    'How a `capture-website` task loads and draws its page (the page is the `url` of the task). The browser reaches the network only through a gate that refuses every address that is not a public web address, for the page and for each redirect, frame, image, script and request it makes; a hop to a private, loopback or link-local address ends the task with a 422 (`capture_target_blocked`).',
  properties: {
    viewport: {
      type: 'object',
      description: 'The browser window of a PNG or JPEG capture.',
      properties: {
        width: { type: 'integer', minimum: 200, maximum: 3840, description: 'Window width in pixels (1280).' },
        height: { type: 'integer', minimum: 200, maximum: 16384, description: 'Window height in pixels (800).' },
      },
    },
    fullPage: { type: 'boolean', description: 'PNG and JPEG: capture the whole height of the page, up to 16384 pixels, instead of the window.' },
    waitUntil: { type: 'string', enum: ['load', 'idle'], description: '`load` (default) draws when the page has loaded; `idle` also waits until the page has made no request for half a second.' },
    delayMs: { type: 'integer', minimum: 0, maximum: 30000, description: 'Extra time to wait before drawing, in milliseconds.' },
    quality: { type: 'integer', minimum: 1, maximum: 100, description: 'JPEG quality (85).' },
    userAgent: { type: 'string', maxLength: 300, description: 'The User-Agent the browser sends.' },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000, description: 'The time the page has to load and be drawn, in milliseconds (60000). A page that is not done in time ends the task with the code `timeout`.' },
    pdf: {
      type: 'object',
      description: 'PDF output.',
      properties: {
        paper: { type: 'string', enum: ['A3', 'A4', 'A5', 'Letter', 'Legal', 'Tabloid'], description: 'Page size (A4).' },
        width: { type: 'number', minimum: 50, maximum: 2000, description: 'Page width in millimetres; with `height`, it takes the place of `paper`.' },
        height: { type: 'number', minimum: 50, maximum: 2000, description: 'Page height in millimetres.' },
        landscape: { type: 'boolean', description: 'Landscape orientation.' },
        margin: { type: 'number', minimum: 0, maximum: 50, description: 'Margin on every side, in millimetres (10).' },
        printBackground: { type: 'boolean', description: 'Print the backgrounds of the page (true).' },
        scale: { type: 'number', minimum: 0.1, maximum: 2, description: 'Zoom of the page (1).' },
      },
    },
  },
} as const;

export const MetadataWriteOptionsSchema = {
  type: 'object',
  required: ['set'],
  description:
    'Fields a `metadata.write` task writes into its input (a JPEG, a PNG or a PDF) without changing anything else in the file. The names are those of ExifTool and may carry their group (`EXIF:Artist`, `XMP:Title`, `PDF:Title`).',
  properties: {
    set: {
      type: 'object',
      minProperties: 1,
      maxProperties: 64,
      description:
        'The fields to set, by name. A JPEG or a PNG takes the EXIF fields ImageDescription, Make, Model, Orientation, Software, ModifyDate, Artist, Copyright, DateTimeOriginal, CreateDate, UserComment, LensMake, LensModel, SerialNumber, GPSLatitude, GPSLongitude and GPSAltitude (a field set to null is removed; dates are "YYYY:MM:DD HH:MM:SS", positions are signed decimal degrees and meters), and the XMP fields XMP:Title, XMP:Description, XMP:Rights, XMP:Creator, XMP:Subject and XMP:CreatorTool when the picture holds no XMP packet yet. A PDF takes Title, Author, Subject, Keywords, Creator, Producer, CreateDate and ModifyDate. Any other format, field or value is a 422 (`metadata_write_unsupported`, `metadata_field_invalid`).',
      additionalProperties: {
        oneOf: [{ type: 'string', maxLength: 8192 }, { type: 'number' }, { type: 'null' }, { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 8192 } }],
      },
    },
  },
} as const;
