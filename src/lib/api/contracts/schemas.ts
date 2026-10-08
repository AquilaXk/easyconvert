import { GRAPH_OPERATIONS } from '@/lib/jobs/graph-operations';
import { MAX_OUTPUT_DIMENSION } from '@/lib/conversions/image-limits';
import { OCR_MAX_LANGUAGES_PER_REQUEST } from '@/lib/conversions/ocr-languages';

import { DROPPED_STREAM_KINDS, DROPPED_STREAM_REASONS, MAX_DROPPED_STREAMS, MAX_DROPPED_TEXT_CHARS } from '../dropped-streams';
import { MAX_FALLBACK_REASON_CHARS } from '../engine-trace';
import { PIPELINE_OPERATIONS } from './enums';

/** One language code (letters, digits, `-` and `_`), then up to the per-request limit of further ones joined with `+`. */
const OCR_LANGUAGE_PATTERN = `^[A-Za-z0-9_-]+(\\+[A-Za-z0-9_-]+){0,${OCR_MAX_LANGUAGES_PER_REQUEST - 1}}$`;

export const PdfWatermarkOptionsSchema = {
  $id: 'https://easyconvert.local/schemas/pdf-watermark-options.json',
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['text', 'image'] },
    text: { type: 'string', description: 'Watermark text.' },
    fontSize: { type: 'number', minimum: 6, maximum: 200, description: 'Font size in points.' },
    fontColor: { type: 'string', description: 'Hex or RGB color string.' },
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

export const PdfProtectOptionsSchema = {
  $id: 'https://easyconvert.local/schemas/pdf-protect-options.json',
  type: 'object',
  properties: {
    userPassword: { type: 'string', description: 'Password required to open the PDF.' },
    ownerPassword: { type: 'string', description: 'Master password required to modify permissions.' },
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

export const ConversionOptionsSchema = {
  $id: 'https://easyconvert.local/schemas/conversion-options.json',
  type: 'object',
  properties: {
    // Image & visual options
    quality: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Image/lossy output quality factor (1-100).',
    },
    width: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_OUTPUT_DIMENSION,
      description: 'Target image width in pixels.',
    },
    height: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_OUTPUT_DIMENSION,
      description: 'Target image height in pixels.',
    },
    dimensions: {
      type: 'string',
      pattern: '^\\d+x\\d+$',
      description: 'Dimension string in WxH format (e.g. 800x600).',
    },
    fit: {
      type: 'string',
      enum: ['cover', 'contain', 'fill', 'inside', 'outside'],
      description: 'Image resize fit strategy.',
    },
    stripMetadata: {
      type: 'boolean',
      description: 'Remove EXIF, XMP, and color profile metadata.',
    },
    background: {
      type: 'string',
      pattern: '^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$',
      description:
        'Background colour as #rgb or #rrggbb. Fills transparency for outputs without alpha (JPEG, BMP, EPS/PS, EXR, Ultra HDR) and the bars of fit "contain"; defaults to white for outputs without alpha.',
    },
    dpi: {
      type: 'integer',
      minimum: 72,
      maximum: 600,
      description: 'Dots per inch resolution (72-600).',
    },
    layout: {
      type: 'boolean',
      description:
        'PDF to TXT: keep the physical page layout so table rows stay on one line. Defaults to false, which reads text in reading order (column after column).',
    },
    colorDepth: {
      type: 'integer',
      minimum: 1,
      maximum: 32,
      description: 'Color bit depth per channel or pixel.',
    },
    colors: {
      type: 'integer',
      minimum: 2,
      maximum: 256,
      description: 'Maximum palette color count for quantized outputs.',
    },
    palette: {
      type: 'boolean',
      description: 'Enable custom indexed palette generation.',
    },
    dither: {
      type: 'boolean',
      description: 'Enable dithering during color quantization.',
    },
    quantizer: {
      type: 'string',
      description: 'Color quantization algorithm identifier.',
    },
    ditherMethod: {
      type: 'string',
      description: 'Dithering algorithm identifier.',
    },
    useWebGpu: {
      type: 'boolean',
      description: 'Utilize WebGPU hardware compute pipelines when available.',
    },
    gpuAcceleration: {
      type: 'boolean',
      description: 'Enable GPU acceleration for transforms.',
    },
    falseColorSuppression: {
      oneOf: [
        { type: 'boolean' },
        { type: 'number', minimum: 0, maximum: 10 },
      ],
      description: 'Suppression intensity for Bayer demosaicing artifacts.',
    },
    allowEmbeddedPreview: {
      type: 'boolean',
      description: 'Extract or include embedded thumbnail preview.',
    },

    // RAW & HDR pipeline options
    demosaicMethod: {
      type: 'string',
      enum: ['amaze', 'rcd', 'ahd'],
      description: 'Bayer demosaicing algorithm.',
    },
    kelvin: {
      type: 'number',
      minimum: 1000,
      maximum: 25000,
      description: 'Correlated Color Temperature (CCT) in Kelvin.',
    },
    tint: {
      type: 'number',
      minimum: -150,
      maximum: 150,
      description: 'Green-Magenta tint offset along the Planckian locus.',
    },
    highlightReconstruction: {
      oneOf: [
        { type: 'boolean' },
        { type: 'string', enum: ['clip', 'blend', 'reconstruct'] },
      ],
      description: 'Recover clipped highlights using adjacent channel ratios.',
    },
    targetColorSpace: {
      type: 'string',
      enum: ['sRGB', 'display-p3', 'rec2020', 'linear'],
      description: 'Target output color space.',
    },
    outputDepth: {
      type: 'integer',
      enum: [8, 16, 32],
      description: 'Output bit depth per channel (8, 16, or 32-bit float).',
    },
    gainMap: {
      type: 'boolean',
      description: 'Embed ISO 21496-1 HDR gain map metadata.',
    },

    // CAD & NURBS options
    uSamples: {
      type: 'integer',
      minimum: 1,
      description: 'Evaluation sample grid density along U parametric coordinate.',
    },
    vSamples: {
      type: 'integer',
      minimum: 1,
      description: 'Evaluation sample grid density along V parametric coordinate.',
    },
    allowOpenMesh: {
      type: 'boolean',
      description: 'Allow non-watertight or open surface mesh generation from CAD solids without throwing CadTopologyError.',
    },
    smoothingAngleDeg: {
      type: 'number',
      minimum: 0,
      maximum: 180,
      description: 'Crease angle threshold in degrees for facet normal splitting.',
    },
    outputUnit: {
      type: 'string',
      enum: ['mm', 'cm', 'm', 'in'],
      description: 'Target dimensional unit scale for exported CAD geometry.',
    },

    // Document & PDF options
    page: {
      type: 'integer',
      minimum: 1,
      description:
        'Single target page or frame index (1-indexed): the PDF page to rasterize, or the frame of a multi-frame image (animated GIF/WebP, multi-page TIFF or HEIF) to convert to a single-image output.',
    },
    pages: {
      type: 'string',
      pattern: '^[0-9,\\-\\s]+$',
      description: 'Page range expression for multi-page documents (e.g. "1-3,5", "2-", "-4").',
    },
    multiPageOutput: {
      type: 'string',
      enum: ['zip', 'first'],
      description: 'Packaging strategy for multi-page raster output: "zip" archive (default) or "first" page only.',
    },
    pageCount: {
      type: 'integer',
      minimum: 1,
      description: 'Expected total page count.',
    },
    password: {
      type: 'string',
      description: 'Decryption or protection password.',
    },
    orientation: {
      type: 'string',
      enum: ['portrait', 'landscape'],
      description: 'Page rendering orientation.',
    },
    preserveTables: {
      type: 'boolean',
      description: 'Maintain table structures during text or markup extraction.',
    },
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
    clientEdgeMode: {
      type: 'boolean',
      description: 'Execute processing within client WebAssembly/WebGPU edge sandbox.',
    },
    margin: {
      type: 'string',
      enum: ['normal', 'narrow', 'wide'],
      description: 'Document page margin preset.',
    },
    validateMagicBytes: {
      type: 'boolean',
      description: 'Enforce fail-closed file header validation.',
    },

    // Data & Spreadsheet options
    delimiter: {
      type: 'string',
      maxLength: 5,
      description: 'Delimiter character for delimited text tables.',
    },
    encoding: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      description:
        'WHATWG encoding label of delimited-text input (e.g. "euc-kr", "shift_jis", "windows-1252"). Detected from the BOM, the UTF-16 NUL pattern and the content when omitted.',
    },
    bom: {
      type: 'boolean',
      description: 'Prefix CSV/TSV output with a UTF-8 byte-order mark. Defaults to true for CSV and false for TSV.',
    },
    escapeFormulas: {
      type: 'boolean',
      default: true,
      description:
        'Prefix CSV/TSV cells that start with = + - @ TAB or CR (except plain numbers) with an apostrophe so spreadsheets do not evaluate them.',
    },
    hasHeaders: {
      type: 'boolean',
      description: 'Treat first row of table data as column header names.',
    },
    sheetMode: {
      type: 'string',
      enum: ['merged', 'split', 'index'],
      default: 'merged',
      description: 'Spreadsheet sheet output mode: merged multi-sheet table, split individual CSV files in ZIP, or single sheet by index.',
    },
    sheetIndex: {
      type: 'integer',
      minimum: 0,
      description: 'Zero-based worksheet index to extract in index mode.',
    },
    range: {
      type: 'string',
      enum: ['used', 'printArea'],
      default: 'used',
      description: 'Spreadsheet cell range to extract: all used cells or defined print area (_xlnm.Print_Area).',
    },
    lineEnding: {
      type: 'string',
      enum: ['lf', 'crlf'],
      default: 'lf',
      description: 'CSV row delimiter line ending format (LF vs CRLF).',
    },
    recalculate: {
      type: 'boolean',
      default: false,
      description: 'Recalculate spreadsheet formulas before export using headless office.',
    },

    // Archive options
    compressionLevel: {
      type: 'integer',
      minimum: 0,
      maximum: 9,
      description: 'Archive compression level (0-9).',
    },
    archiveCoder: {
      type: 'string',
      enum: ['lzma', 'lzma2', 'deflate', 'copy'],
      description: 'Archive compression algorithm.',
    },
    splitVolumeBytes: {
      type: 'integer',
      minimum: 1,
      description: 'Maximum volume part size in bytes for split multi-part archives.',
    },
    zstdDict: {
      oneOf: [
        { type: 'boolean' },
        { type: 'string', enum: ['data', 'office'] },
      ],
      description: 'Zstandard pre-trained dictionary identifier or toggle.',
    },
    useNative7z: {
      type: 'boolean',
      description: 'Use native 7-Zip CLI engine when available.',
    },
    solid: {
      type: 'boolean',
      description: 'Enable solid archive mode for multi-file packaging.',
    },
    collisionPolicy: {
      type: 'string',
      enum: ['rename', 'error', 'overwrite'],
      default: 'rename',
      description: 'Resolution strategy for archive entry name collisions.',
    },
    entries: {
      type: 'array',
      items: { type: 'string' },
      description: 'Glob patterns for selective extraction from archives.',
    },
    skipLinks: {
      type: 'boolean',
      default: false,
      description:
        'Extract archives that contain symbolic or hard links by leaving those entries out. By default such archives are rejected. The skipped entry names are reported in the result as skippedLinks.',
    },
    repair: {
      type: 'boolean',
      description: 'Attempt archive repair mode (supported for ZIP via zip -FF).',
    },

    // Audio options
    audioBitrate: {
      type: 'string',
      pattern: '^\\d+[kK]?$',
      description: 'Audio bitrate string (e.g. 128k, 192k, 320k).',
    },
    audioChannels: {
      type: 'string',
      enum: ['mono', 'stereo', '5.1', '7.1'],
      description: 'Audio channel layout.',
    },
    audioSampleRate: {
      type: 'integer',
      enum: [16000, 22050, 32000, 44100, 48000],
      description: 'Audio sample frequency in Hz.',
    },
    audioVolume: {
      type: 'number',
      minimum: 0,
      maximum: 200,
      description: 'Audio volume percentage adjustment (0-200).',
    },
    audio: {
      type: 'object',
      description: 'Structured audio encoding, downmixing, and channel options.',
      properties: {
        codec: {
          type: 'string',
          enum: ['aac', 'mp3', 'opus', 'flac', 'vorbis', 'pcm_s16le'],
          description: 'Audio compression or uncompressed PCM codec.',
        },
        bitrateK: {
          type: 'integer',
          minimum: 8,
          maximum: 1024,
          description: 'Audio bitrate target in kilobits per second (kbps).',
        },
        channels: {
          type: 'integer',
          enum: [1, 2, 6, 8],
          description: 'Audio channel layout count (1=mono, 2=stereo, 6=5.1, 8=7.1).',
        },
        sampleRate: {
          type: 'integer',
          minimum: 8000,
          maximum: 192000,
          description: 'Audio sampling rate in Hertz.',
        },
        volume: {
          type: 'number',
          minimum: 0,
          maximum: 200,
          description: 'Audio volume percentage adjustment (0-200).',
        },
        downmix: {
          type: 'string',
          enum: ['itu-r-bs775'],
          description: 'ITU-R BS.775 surround-to-stereo downmixing matrix.',
        },
        loudness: {
          type: 'object',
          description:
            'Opt-in EBU R128 / ITU-R BS.1770-4 loudness normalisation in two passes: a measuring pass, then a linear gain. Needs a single audio track. Without values it normalises to -23 LUFS with a -1 dBTP ceiling.',
          properties: {
            preset: {
              type: 'string',
              enum: ['ebu-r128', 'streaming', 'podcast'],
              default: 'ebu-r128',
              description: 'Starting target: ebu-r128 = -23 LUFS / -1 dBTP / 7 LU, streaming = -14 LUFS / -1 dBTP / 11 LU, podcast = -16 LUFS / -1.5 dBTP / 11 LU.',
            },
            integrated: { type: 'number', minimum: -70, maximum: -5, description: 'Integrated loudness target in LUFS.' },
            truePeak: { type: 'number', minimum: -9, maximum: 0, description: 'True-peak ceiling in dBTP.' },
            lra: { type: 'number', minimum: 1, maximum: 50, description: 'Loudness range target in LU.' },
          },
          additionalProperties: false,
        },
        resampler: {
          type: 'string',
          enum: ['soxr', 'swr'],
          description:
            'Resampler for sample-rate changes. Unset uses soxr (precision 28) when the ffmpeg build has it and the default swresample otherwise, reported in the result metadata; an explicit soxr on a build without it answers 503.',
        },
        dither: {
          type: 'string',
          enum: ['none', 'rectangular', 'triangular', 'triangular_hp'],
          description: 'Dither for the reduction to 16-bit PCM output. Defaults to triangular_hp (high-pass shaped TPDF). Other codecs reject it.',
        },
        track: {
          oneOf: [
            { type: 'integer', minimum: 0 },
            { const: 'all' },
          ],
          description: 'Specific audio stream index to encode, or "all" streams.',
        },
      },
    },

    // Video options
    video: {
      type: 'object',
      description: 'Structured video encoding and filter graph options.',
      properties: {
        codec: {
          type: 'string',
          enum: ['h264', 'hevc', 'vp9', 'av1', 'prores'],
          description: 'Video compression codec standard.',
        },
        profile: {
          type: 'string',
          description: 'Codec conformance profile (e.g. baseline, main, high).',
        },
        level: {
          type: 'string',
          description: 'Codec conformance level (e.g. 3.0, 4.1, 5.1).',
        },
        rateControl: {
          oneOf: [
            {
              type: 'object',
              required: ['mode', 'crf'],
              properties: {
                mode: { const: 'crf' },
                crf: { type: 'number', minimum: 0, maximum: 63 },
                maxBitrateK: {
                  type: 'number',
                  minimum: 1,
                  description: 'Optional peak-bitrate cap in kbit/s (capped CRF): -maxrate with a buffer of twice that. Unset leaves the rate to quality alone.',
                },
              },
            },
            {
              type: 'object',
              required: ['mode', 'bitrateK'],
              properties: {
                mode: { const: 'vbr' },
                bitrateK: { type: 'number', minimum: 1 },
                maxrateK: { type: 'number', minimum: 1 },
                bufsizeK: { type: 'number', minimum: 1 },
                twoPass: {
                  type: 'boolean',
                  description:
                    'Encode in two passes (h264, hevc, vp9; software encoders) so the video bitrate lands closer to bitrateK. Costs about twice the encode time and counts both passes against the job timeout. Other codecs answer 400.',
                },
              },
            },
            {
              type: 'object',
              required: ['mode', 'bitrateK'],
              properties: {
                mode: { const: 'cbr' },
                bitrateK: { type: 'number', minimum: 1 },
              },
            },
          ],
          description: 'Video bitrate and quality rate control mode.',
        },
        preset: {
          type: 'string',
          description:
            'Encoding speed-to-compression preset. h264 and hevc: ultrafast, superfast, veryfast, faster, fast, medium (default), slow, slower or veryslow. av1: an integer from 0 (slowest) to 13, default 8. Other values answer an error.',
        },
        fps: {
          type: 'number',
          minimum: 1,
          maximum: 240,
          description: 'Output video frame rate in frames per second.',
        },
        crop: {
          type: 'object',
          required: ['w', 'h', 'x', 'y'],
          properties: {
            w: { type: 'integer', minimum: 1, description: 'Cropped width in pixels.' },
            h: { type: 'integer', minimum: 1, description: 'Cropped height in pixels.' },
            x: { type: 'integer', minimum: 0, description: 'Horizontal coordinate offset.' },
            y: { type: 'integer', minimum: 0, description: 'Vertical coordinate offset.' },
          },
          description: 'Rectangular region crop bounding box.',
        },
        rotate: {
          type: 'integer',
          enum: [0, 90, 180, 270],
          description: 'Clockwise rotation angle in degrees.',
        },
        deinterlace: {
          type: 'boolean',
          description:
            'Deinterlace interlaced frames with bwdif in send_field mode: one progressive frame per field, so the output frame rate is twice the field-pair rate of the source.',
        },
        scale: {
          type: 'object',
          properties: {
            width: { type: 'integer', minimum: 1 },
            height: { type: 'integer', minimum: 1 },
            fit: { type: 'string', enum: ['contain', 'cover', 'stretch'] },
          },
          description: 'Scaling dimension and aspect fit behavior.',
        },
      },
    },
    trim: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'Start time offset (HH:MM:SS.mmm or seconds).' },
        end: { type: 'string', description: 'End time offset (HH:MM:SS.mmm or seconds).' },
      },
      description: 'Temporal clipping boundaries.',
    },
    subtitles: {
      type: 'object',
      required: ['mode'],
      description: 'Subtitle rendering and stream management options.',
      properties: {
        mode: {
          type: 'string',
          enum: ['burn', 'soft', 'extract'],
          description: 'Subtitle operation mode: burn into video filter, soft embed in container, or extract stream.',
        },
        input: {
          type: 'string',
          description: 'External subtitle source file path or identifier.',
        },
        streamIndex: {
          type: 'integer',
          minimum: 0,
          description: 'Subtitle stream index within source or external file.',
        },
        format: {
          type: 'string',
          enum: ['srt', 'vtt', 'ass'],
          description: 'Target subtitle format when extracting or soft embedding.',
        },
      },
    },
    thumbnail: {
      type: 'object',
      description: 'Video frame thumbnail extraction options.',
      properties: {
        at: {
          type: 'array',
          items: { type: 'string' },
          description: 'Timestamp strings or second offsets where thumbnails should be sampled.',
        },
        format: {
          type: 'string',
          enum: ['jpg', 'png'],
          description: 'Output thumbnail image format.',
        },
        width: {
          type: 'integer',
          minimum: 16,
          maximum: 7680,
          description: 'Target thumbnail width in pixels.',
        },
        accurate: {
          type: 'boolean',
          description: 'Whether to use sample-accurate seek instead of fast keyframe seek.',
        },
      },
    },
    packaging: {
      type: 'object',
      required: ['format'],
      description: 'Adaptive bitrate (ABR) packaging options for HLS and MPEG-DASH.',
      properties: {
        format: {
          type: 'string',
          enum: ['hls', 'dash'],
          description: 'Streaming delivery packaging format standard.',
        },
        segmentSeconds: {
          type: 'integer',
          minimum: 2,
          maximum: 10,
          default: 4,
          description: 'Segment duration target in seconds (2..10).',
        },
        segmentType: {
          type: 'string',
          enum: ['ts', 'fmp4'],
          default: 'ts',
          description:
            'HLS segment container: MPEG-2 transport stream (ts) or fragmented MP4 / CMAF (fmp4, ISO/IEC 23000-19, with an EXT-X-MAP init section). MPEG-DASH always uses fmp4.',
        },
        ladder: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'object',
            required: ['height', 'bitrateK'],
            properties: {
              height: { type: 'integer', minimum: 144, maximum: 4320, description: 'Rung vertical resolution in pixels.' },
              bitrateK: { type: 'integer', minimum: 50, maximum: 50000, description: 'Video bitrate target in kbps.' },
              fps: { type: 'number', minimum: 1, maximum: 240, description: 'Video frame rate for this rung.' },
              audioBitrateK: { type: 'integer', minimum: 16, maximum: 1024, description: 'Audio bitrate target in kbps.' },
            },
          },
          description:
            'Multi-bitrate encoding ladder rungs. Defaults to 1080p, 720p, 480p if omitted. Rungs taller than the source are dropped, a rung never asks for more bitrate than the source carries, and each rung peaks at 1.07x its bitrate.',
        },
        masterPlaylistName: {
          type: 'string',
          description: 'Custom master playlist filename (e.g. master.m3u8 or manifest.mpd).',
        },
        audioCodec: {
          type: 'string',
          enum: ['aac', 'opus'],
          description: 'Audio codec for packaged streams.',
        },
        videoCodec: {
          type: 'string',
          enum: ['h264', 'hevc', 'vp9', 'av1'],
          description: 'Video codec for packaged streams.',
        },
      },
    },
    videoResolution: {
      type: 'string',
      enum: ['original', '4k', '1080p', '720p', '480p', '360p'],
      description: 'Target video resolution preset.',
    },
    videoFps: {
      type: 'integer',
      enum: [24, 30, 60],
      description: 'Video frame rate in frames per second.',
    },
    videoCodec: {
      type: 'string',
      enum: ['h264', 'hevc', 'vp9', 'av1'],
      description: 'Target video encoding codec.',
    },
    videoBitrate: {
      type: 'integer',
      minimum: 1,
      description: 'Target video bitrate in bits per second.',
    },
    duration: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 86400,
      description:
        'Longest output in seconds, applied as an output-side limit (-t). Must be more than 0 and not longer than the input; a longer value answers 400.',
    },
    useFfmpeg: {
      type: 'boolean',
      description: 'Force FFmpeg processing pipeline.',
    },
    fastStart: {
      type: 'boolean',
      description:
        'Place the moov atom before the media data of mp4, mov and m4a output for progressive playback. Defaults to true for those containers; false leaves it at the end. true for any other container answers 400.',
    },
    aspectRatio: {
      description:
        'Display aspect ratio. A "W:H" string sets the display ratio without touching the pixels (setdar). The object form adds a mode: "pad" adds black bars and "crop" removes picture, both reshaping the frame to the ratio with even sizes. Terms are whole numbers up to 10000 and the ratio at most 10:1; anything else answers 400.',
      oneOf: [
        { type: 'string', pattern: '^[0-9]{1,5}:[0-9]{1,5}$' },
        {
          type: 'object',
          required: ['ratio'],
          properties: {
            ratio: { type: 'string', pattern: '^[0-9]{1,5}:[0-9]{1,5}$' },
            mode: { type: 'string', enum: ['dar', 'pad', 'crop'], default: 'dar' },
          },
          additionalProperties: false,
        },
      ],
    },
    disableHwaccel: {
      type: 'boolean',
      description: 'Disable GPU hardware acceleration.',
    },
    disableNativeEngine: {
      type: 'boolean',
      description: 'Bypass native system engine binaries.',
    },

    // Office & PDF export options
    pdfStandard: {
      type: 'string',
      enum: ['pdfa', 'pdfa-1b', 'pdfa-2b', 'pdfa-3b'],
      description: "PDF archival standard conformance level. The bare value 'pdfa' means pdfa-2b.",
    },
    pdfVersion: {
      type: 'string',
      description: 'Target PDF specification version.',
    },
    libreOfficeFilter: {
      type: 'string',
      description: 'Explicit LibreOffice export filter name.',
    },
    losslessImageCompression: {
      type: 'boolean',
      description: 'Preserve lossless pixel compression during document export.',
    },
    imageDpi: {
      type: 'integer',
      minimum: 72,
      maximum: 1200,
      description:
        'Office to PDF: downsample embedded images to this resolution (72-1200). Defaults to keeping images at their source resolution.',
    },
    jpegQuality: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description:
        'Office to PDF: re-encode embedded JPEG images at this quality (1-100). Defaults to keeping the source JPEG stream byte for byte.',
    },
    watermark: {
      type: 'object',
      description: 'PDF text or image watermarking options.',
      properties: PdfWatermarkOptionsSchema.properties,
    },
    protect: {
      type: 'object',
      description: 'PDF AES-256 encryption and permission restriction options.',
      properties: PdfProtectOptionsSchema.properties,
    },
    pdfa: {
      type: 'object',
      description: 'PDF/A archival conversion options.',
      properties: PdfAOptionsSchema.properties,
    },
  },
} as const;

export const PipelineTaskSchema = {
  $id: 'https://easyconvert.local/schemas/pipeline-task.json',
  type: 'object',
  required: ['operation'],
  properties: {
    name: {
      type: 'string',
      description: 'Task stage identifier or label.',
    },
    operation: {
      type: 'string',
      enum: PIPELINE_OPERATIONS,
      description: 'Pipeline stage operation.',
    },
    targetFormat: {
      type: 'string',
      description: 'Target format extension for this stage.',
    },
    options: {
      $ref: 'https://easyconvert.local/schemas/conversion-options.json',
      description: 'Stage-specific transformation or conversion options.',
    },
    credentialRef: {
      type: 'string',
      pattern: '^cred_[a-f0-9]{32}$',
      description: 'Opaque identifier reference to customer BYOS credentials stored in encrypted vault.',
    },
    remotePath: {
      type: 'string',
      description: 'Target remote object path or bucket prefix for import or export operations.',
    },
    url: {
      type: 'string',
      format: 'uri',
      description: 'Source or destination URL for import/url or export/url operations.',
    },
  },
} as const;

export const JobGraphSchema = {
  $id: 'https://easyconvert.local/schemas/job-graph.json',
  type: 'object',
  required: ['nodes'],
  properties: {
    failurePolicy: {
      type: 'string',
      enum: ['fail_fast', 'continue'],
      default: 'fail_fast',
      description: 'Failure handling policy across parallel execution branches.',
    },
    nodes: {
      type: 'object',
      minProperties: 1,
      propertyNames: {
        pattern: '^[a-z][a-z0-9_-]{0,63}$',
      },
      additionalProperties: {
        type: 'object',
        required: ['op'],
        properties: {
          op: {
            type: 'string',
            enum: [...GRAPH_OPERATIONS],
            description: 'Operation type for this graph node.',
          },
          input: {
            description: 'Single upstream NodeId or array of upstream NodeIds. A merge node needs at least 2 distinct inputs.',
            oneOf: [
              {
                type: 'string',
                pattern: '^[a-z][a-z0-9_-]{0,63}$',
              },
              {
                type: 'array',
                items: {
                  type: 'string',
                  pattern: '^[a-z][a-z0-9_-]{0,63}$',
                },
                minItems: 1,
              },
            ],
          },
          storageKey: {
            type: 'string',
            description: 'Storage key for import.upload node.',
          },
          url: {
            type: 'string',
            format: 'uri',
            description: 'URL for import.url or export.url node.',
          },
          headers: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Optional HTTP headers for URL operations.',
          },
          method: {
            type: 'string',
            enum: ['PUT', 'POST'],
            description: 'HTTP method for export.url node.',
          },
          targetFormat: {
            type: 'string',
            description: 'Target format extension for convert or archive.create.',
          },
          options: {
            $ref: 'https://easyconvert.local/schemas/conversion-options.json',
            description: 'Transformation options for convert, ocr, optimize, or archive.create.',
          },
          entries: {
            type: 'array',
            items: { type: 'string' },
            description: 'Glob patterns for archive.extract entries.',
          },
        },
      },
    },
  },
} as const;

export const JobCreateRequestSchema = {
  $id: 'https://easyconvert.local/schemas/job-create-request.json',
  type: 'object',
  properties: {
    filename: {
      type: 'string',
      description: 'Original filename.',
    },
    originalFilename: {
      type: 'string',
      description: 'Original filename alias.',
    },
    targetFormat: {
      type: 'string',
      description: 'Target format extension. With `tasks`, the final task determines the output format.',
    },
    sourceFormat: {
      type: 'string',
      description: 'Source format extension override.',
    },
    storageKey: {
      type: 'string',
      description: 'Key of an object from the multipart upload API or an output owned by the caller.',
    },
    uploadId: {
      type: 'string',
      description: 'Upload identifier from completed direct multipart or TUS resumable upload session.',
    },
    inputBufferBase64: {
      type: 'string',
      description: 'Base64-encoded source payload.',
    },
    fileSize: {
      type: 'number',
      minimum: 0,
      description: 'File size in bytes.',
    },
    options: {
      $ref: 'https://easyconvert.local/schemas/conversion-options.json',
      description: 'Conversion configuration options.',
    },
    tasks: {
      type: 'array',
      description: 'Array of sequential pipeline tasks for multi-stage conversion execution.',
      items: {
        $ref: 'https://easyconvert.local/schemas/pipeline-task.json',
      },
    },
    graph: {
      $ref: 'https://easyconvert.local/schemas/job-graph.json',
      description: 'Directed acyclic graph (DAG) specifying multi-stage fan-out and fan-in conversion workflow.',
    },
    webhookUrl: {
      type: 'string',
      format: 'uri',
      description: 'Destination URL for job lifecycle webhooks.',
    },
    webhookSecret: {
      type: 'string',
      description: 'Secret used for HMAC-SHA256 signature verification.',
    },
  },
} as const;

export const ProblemDetailsSchema = {
  $id: 'https://easyconvert.local/schemas/problem-details.json',
  type: 'object',
  required: ['type', 'title', 'status', 'detail', 'instance'],
  properties: {
    type: {
      type: 'string',
      format: 'uri',
      description: 'A URI reference identifying the problem type.',
    },
    title: {
      type: 'string',
      description: 'A short, human-readable summary of the problem type.',
    },
    status: {
      type: 'integer',
      description: 'The HTTP status code generated for this occurrence.',
    },
    detail: {
      type: 'string',
      description: 'A human-readable explanation specific to this occurrence.',
    },
    instance: {
      type: 'string',
      description: 'A URI reference identifying the specific occurrence.',
    },
    invalidParams: {
      type: 'array',
      description: 'List of invalid parameters for validation failures.',
      items: {
        type: 'object',
        required: ['name', 'reason'],
        properties: {
          name: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
    success: {
      type: 'boolean',
      description: 'Legacy compatibility flag (always false).',
    },
    error: {
      type: 'string',
      description: 'Legacy compatibility error message mirroring detail.',
    },
  },
} as const;

/** Members a PDF/A validation problem (HTTP 422) adds to the problem details. */
export const PdfaValidationProblemSchema = {
  $id: 'https://easyconvert.local/schemas/pdfa-validation-problem.json',
  type: 'object',
  required: ['profile', 'failedRules'],
  properties: {
    profile: {
      type: 'string',
      enum: ['pdfa-1b', 'pdfa-2b', 'pdfa-3b'],
      description: 'The PDF/A level the request asked for and the output was validated against.',
    },
    failedRules: {
      type: 'array',
      items: { type: 'string' },
      description: 'veraPDF rule IDs the output failed, as `<clause>-<test number>` (for example `6.2.11.4.1-1`).',
    },
  },
} as const;

/** Which engine ran and, only after a fallback, why; shared by every response that reports a conversion. */
export const EngineTraceProperties = {
  engineUsed: {
    type: 'string',
    description: 'Engine that produced the output, for example `native-ffmpeg`, `native-soffice` or `internal-fallback`.',
  },
  fallbackReason: {
    type: 'string',
    maxLength: MAX_FALLBACK_REASON_CHARS,
    description:
      'Why a first-choice engine did not produce the output. Present only when a fallback happened; redacted, one line, without file paths.',
  },
} as const;

/** Input streams a media conversion left out because the target container cannot carry them; absent when none. */
export const DroppedStreamsProperties = {
  droppedStreams: {
    type: 'array',
    maxItems: MAX_DROPPED_STREAMS,
    description:
      'Streams of the input that the output does not contain, for example the subtitle tracks of an mkv converted to avi. The conversion succeeded; this lists what it could not carry. Present only when something was left out. Audio tracks `audio.track` did not choose and subtitles burned into the picture are not listed.',
    items: {
      type: 'object',
      required: ['kind', 'reason'],
      additionalProperties: false,
      properties: {
        index: {
          type: 'integer',
          minimum: 0,
          description: 'Stream index in the input; absent for the chapter list.',
        },
        kind: { type: 'string', enum: [...DROPPED_STREAM_KINDS] },
        codec: { type: 'string', maxLength: MAX_DROPPED_TEXT_CHARS, description: 'Codec name of the stream, when known.' },
        language: { type: 'string', maxLength: MAX_DROPPED_TEXT_CHARS, description: 'Language tag of the stream, when it has one.' },
        title: { type: 'string', maxLength: MAX_DROPPED_TEXT_CHARS, description: 'Title of the stream, when it has one.' },
        reason: {
          type: 'string',
          enum: [...DROPPED_STREAM_REASONS],
          description:
            '`container_unsupported`: the target container cannot carry this stream. `stream_type_unsupported`: no video-container output carries this kind of stream (data, cover art). `additional_video_track`: only the first video track is kept.',
        },
      },
    },
  },
} as const;

export const JobResourceSchema = {
  $id: 'https://easyconvert.local/schemas/job-resource.json',
  type: 'object',
  properties: {
    success: {
      type: 'boolean',
      description: 'Job execution success indicator.',
    },
    jobId: {
      type: 'string',
      description: 'Unique job identifier.',
    },
    status: {
      type: 'string',
      enum: ['waiting', 'active', 'completed', 'failed', 'delayed', 'cancelled'],
      description: 'Current lifecycle state of the job.',
    },
    progress: {
      type: 'number',
      minimum: 0,
      maximum: 100,
      description: 'Percentage completion (0-100).',
    },
    sourceFormat: {
      type: 'string',
      description: 'Source format identifier.',
    },
    targetFormat: {
      type: 'string',
      description: 'Target format identifier.',
    },
    originalFilename: {
      type: 'string',
      description: 'Original uploaded filename.',
    },
    fileSize: {
      type: 'number',
      minimum: 0,
      description: 'File size in bytes.',
    },
    createdAt: {
      type: 'number',
      description: 'Timestamp of job creation in epoch milliseconds.',
    },
    processedOn: {
      type: 'number',
      description: 'Timestamp when processing started in epoch milliseconds.',
    },
    finishedOn: {
      type: 'number',
      description: 'Timestamp when processing completed or failed in epoch milliseconds.',
    },
    attemptsMade: {
      type: 'integer',
      minimum: 0,
      description: 'Number of execution attempts made.',
    },
    failedReason: {
      type: 'string',
      description: 'Reason for job failure if status is failed.',
    },
    failedCode: {
      type: 'string',
      description: 'Error class of a typed failure, for example InputPixelLimitError.',
    },
    failedStatus: {
      type: 'integer',
      description: 'HTTP status the same failure answers on the synchronous API, for example 413 when the input exceeds the pixel limit.',
    },
    ...EngineTraceProperties,
    ...DroppedStreamsProperties,
    result: {
      type: 'object',
      description: 'Job execution result metadata.',
      properties: {
        ...EngineTraceProperties,
        ...DroppedStreamsProperties,
        sourceFrameCount: {
          type: 'integer',
          minimum: 2,
          description: 'Frames or pages the source image holds; present only for multi-frame sources.',
        },
        frameUsed: {
          type: 'integer',
          minimum: 1,
          description: '1-based frame or page a single-image output was taken from; present only when one was chosen.',
        },
      },
    },
    tasks: {
      type: 'array',
      description: 'Pipeline task stages.',
      items: {
        $ref: 'https://easyconvert.local/schemas/pipeline-task.json',
      },
    },
    logs: {
      type: 'array',
      description: 'Execution logs.',
      items: {
        type: 'string',
      },
    },
  },
} as const;

export const IdempotencyKeyHeaderSchema = {
  $id: 'https://easyconvert.local/schemas/idempotency-key-header.json',
  type: 'string',
  minLength: 1,
  maxLength: 255,
  pattern: String.raw`^[\x21-\x7E]{1,255}$`,
  description: 'Unique 1-255 character printable ASCII idempotency key for safe client retries.',
} as const;

export const WebhookSecretRotateRequestSchema = {
  $id: 'https://easyconvert.local/schemas/webhook-secret-rotate-request.json',
  type: 'object',
  additionalProperties: false,
  properties: {
    endpointId: {
      type: 'string',
      maxLength: 255,
      description: 'Webhook endpoint identifier to rotate. Either endpointId or apiKeyId is required.',
    },
    apiKeyId: {
      type: 'string',
      maxLength: 255,
      description: 'API key identifier whose webhook secret to rotate. Either endpointId or apiKeyId is required.',
    },
    graceSeconds: {
      type: 'integer',
      minimum: 60,
      maximum: 604800,
      description:
        'Grace period in seconds (60-604800, default 86400) during which both old and new signatures are valid.',
    },
  },
} as const;

export const WebhookSecretRotateResponseSchema = {
  $id: 'https://easyconvert.local/schemas/webhook-secret-rotate-response.json',
  type: 'object',
  required: ['success', 'secret', 'expiresAt', 'graceSeconds'],
  additionalProperties: false,
  properties: {
    success: {
      type: 'boolean',
      const: true,
      description: 'Indicates the secret rotation completed successfully.',
    },
    secret: {
      type: 'string',
      pattern: '^whsec_[a-f0-9]{64}$',
      description: 'Newly generated primary webhook secret. Store securely; returned only once.',
    },
    expiresAt: {
      type: 'number',
      description: 'Expiration timestamp (epoch ms) of the grace period for dual-signature acceptance.',
    },
    graceSeconds: {
      type: 'integer',
      minimum: 60,
      maximum: 604800,
      description: 'Active grace period in seconds.',
    },
    previousExpiresAt: {
      type: 'number',
      description: 'Expiration timestamp (epoch ms) of the previous secret.',
    },
  },
} as const;

export const UsageQueryRequestSchema = {
  $id: 'https://easyconvert.local/schemas/usage-query-request.json',
  type: 'object',
  additionalProperties: false,
  properties: {
    from: {
      type: ['number', 'string'],
      description: 'Start of time window (epoch ms timestamp or ISO 8601 string).',
    },
    to: {
      type: ['number', 'string'],
      description: 'End of time window (epoch ms timestamp or ISO 8601 string).',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 200,
      default: 50,
      description: 'Maximum number of ledger records to return.',
    },
  },
} as const;

export const UsageLedgerEntrySchema = {
  $id: 'https://easyconvert.local/schemas/usage-ledger-entry.json',
  type: 'object',
  required: [
    'jobId',
    'nodeId',
    'units',
    'resourceClass',
    'bytesIn',
    'bytesOut',
    'durationMs',
    'timestamp',
    'status',
  ],
  additionalProperties: false,
  properties: {
    jobId: { type: 'string', description: 'Unique job identifier.' },
    nodeId: { type: 'string', description: 'Task graph node identifier.' },
    units: { type: 'integer', minimum: 0, description: 'Billed resource units (0 on rollback/failure).' },
    resourceClass: {
      type: 'string',
      enum: ['light', 'cpu', 'memory', 'gpu'],
      description: 'Resource tier multiplier applied to the task.',
    },
    bytesIn: { type: 'integer', minimum: 0, description: 'Input payload size in bytes.' },
    bytesOut: { type: 'integer', minimum: 0, description: 'Output result size in bytes.' },
    durationMs: { type: 'integer', minimum: 0, description: 'Execution wall time in milliseconds.' },
    timestamp: { type: 'integer', description: 'Epoch ms timestamp when recorded.' },
    status: {
      type: 'string',
      enum: ['completed', 'failed', 'cancelled'],
      description: 'Terminal status of the task execution.',
    },
  },
} as const;

export const UsageQueryResponseSchema = {
  $id: 'https://easyconvert.local/schemas/usage-query-response.json',
  type: 'object',
  required: ['success', 'items', 'totalUnits', 'count'],
  additionalProperties: false,
  properties: {
    success: { type: 'boolean', const: true },
    items: {
      type: 'array',
      items: { $ref: 'https://easyconvert.local/schemas/usage-ledger-entry.json' },
    },
    totalUnits: { type: 'integer', minimum: 0, description: 'Sum of units across returned items.' },
    count: { type: 'integer', minimum: 0, description: 'Number of returned ledger items.' },
  },
} as const;

export const OcrLanguageEntrySchema = {
  $id: 'https://easyconvert.local/schemas/ocr-language-entry.json',
  type: 'object',
  required: ['code', 'traineddata', 'name', 'script', 'direction', 'installed'],
  additionalProperties: false,
  properties: {
    code: { type: 'string', description: 'Short code to request the language by: its ISO 639-1 code, or the traineddata name when it has none.' },
    traineddata: { type: 'string', description: 'Name of the language data file without extension (`eng`, `chi_sim_vert`).' },
    name: { type: 'string', description: 'English name of the language.' },
    script: { type: 'string', description: 'ISO 15924 script code of the writing system (`Latn`, `Hang`, `Arab`).' },
    direction: { type: 'string', enum: ['ltr', 'rtl', 'ttb'], description: 'Direction text runs in; `ttb` is data trained on vertical lines.' },
    installed: { type: 'boolean', description: 'Whether this server has the language data. Read from the configured data directories once at start.' },
  },
} as const;

export const OcrLanguagesResponseSchema = {
  $id: 'https://easyconvert.local/schemas/ocr-languages-response.json',
  type: 'object',
  required: ['success', 'languages', 'maxLanguagesPerRequest'],
  additionalProperties: false,
  properties: {
    success: { type: 'boolean', const: true },
    languages: { type: 'array', items: { $ref: 'https://easyconvert.local/schemas/ocr-language-entry.json' } },
    maxLanguagesPerRequest: {
      type: 'integer',
      minimum: 1,
      description: 'Most languages one request may join with `+`.',
    },
  },
} as const;

export const ArchiveInspectResponseSchema = {
  $id: 'https://easyconvert.local/schemas/archive-inspect-response.json',
  type: 'object',
  required: [
    'format',
    'totalEntries',
    'totalUncompressedBytes',
    'totalCompressedBytes',
    'isEncrypted',
    'entries',
    'extractable',
    'unextractableReasons',
  ],
  properties: {
    format: { type: 'string', description: 'Detected archive format standard.' },
    totalEntries: { type: 'integer', minimum: 0, description: 'Total number of items in the archive.' },
    totalUncompressedBytes: { type: 'integer', minimum: 0, description: 'Sum of uncompressed file sizes in bytes.' },
    totalCompressedBytes: { type: 'integer', minimum: 0, description: 'Sum of compressed storage sizes in bytes.' },
    isEncrypted: { type: 'boolean', description: 'Whether archive or its entries require a password.' },
    extractable: {
      type: 'boolean',
      description:
        'False when extraction would refuse the archive because of links, unsafe paths, special entries or duplicate paths. Inspection reports these and never follows them.',
    },
    unextractableReasons: {
      type: 'array',
      items: { type: 'string' },
      description: 'One line per category that blocks extraction, with a count and the first offending entry.',
    },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'uncompressedSize', 'isEncrypted', 'isDirectory'],
        properties: {
          name: { type: 'string', description: 'Internal relative file or directory path.' },
          uncompressedSize: { type: 'integer', minimum: 0, description: 'Uncompressed size in bytes.' },
          compressedSize: { type: 'integer', minimum: 0, description: 'Compressed payload size in bytes.' },
          isEncrypted: { type: 'boolean', description: 'Whether this entry is password-protected.' },
          isDirectory: { type: 'boolean', description: 'Whether this entry represents a directory.' },
          modifiedAt: { type: 'string', description: 'ISO 8601 modification timestamp.' },
          crc32: { type: 'string', description: 'Hex-encoded CRC32 checksum.' },
          kind: {
            type: 'string',
            enum: ['symlink', 'hardlink', 'special'],
            description: 'Present for link and device/FIFO/socket entries. Links are never resolved.',
          },
          unsafePath: {
            type: 'boolean',
            description: 'The name is absolute, traverses with `..`, or is invalid. The name is reported verbatim.',
          },
          duplicate: { type: 'boolean', description: 'Another entry in the archive has the same path.' },
        },
      },
    },
  },
} as const;




