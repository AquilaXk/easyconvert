import { BUILT_IN_ENGINE, engineAllowsRoute, type EngineId } from '../lib/conversions/engine-ids';
import { RAW_CAMERA_FORMATS } from '../lib/conversions/raw-formats';
import { officeSuiteReadsInput, officeSuiteReadsInputAndWrites } from './office-suite-route';
import {
  ARCHIVE_EXTRACT_FORMATS,
  ARCHIVE_TARGET_FORMATS,
  HTML_TARGET,
  IN_PROCESS_RAW_SENSOR_FORMATS,
  MEDIA_FORMATS,
  OFFICE_NATIVE_RESAVE_FORMATS,
  PDF_SOURCE_FORMAT,
  PRESENTATION_HTML_SOURCES,
  RAW_PACKAGING_TARGETS,
  SVG_SOURCE,
  fixedPageEngineOf,
  isPdfChainTarget,
} from './native-route-formats';
import type { WorkerEngineOptions, WorkerVfsPayload } from './worker-types';

/** The sources a spreadsheet recalculation is asked for. */
const RECALCULATED_SOURCES: ReadonlySet<string> = new Set(['xlsx', 'xls', 'ods']);
const THUMBNAIL_TARGETS: ReadonlySet<string> = new Set(['jpg', 'jpeg', 'png']);
const SUBTITLE_TARGETS: ReadonlySet<string> = new Set(['srt', 'vtt', 'ass']);
const PACKAGING_TARGETS: ReadonlySet<string> = new Set(['hls', 'dash']);
const PDF_TEXT_TARGETS: ReadonlySet<string> = new Set(['txt', 'text']);
const PDF_TARGET = 'pdf';

/** Which of the worker's native routes take a conversion, in the order `convertWithinImageSession` tries them. */
export interface NativeRoutePlan {
  /** The office suite writes the target in the pass that opens the source (or renders text, recalculates, or saves the format again). */
  libreoffice: boolean;
  /** A spreadsheet is recalculated by the office suite. */
  recalculate: boolean;
  /** The office suite writes a PDF whose pages a native tool then draws, or a presentation's HTML. */
  libreofficePages: boolean;
  presentationHtml: boolean;
  /** The in-process decoder of the camera files LibRaw cannot open. */
  rawSensor: boolean;
  svg: boolean;
  /** The engine of the program that draws the pages of a PostScript, XPS or DjVu source. */
  fixedPage: EngineId | undefined;
  raw: boolean;
  ffmpeg: boolean;
  /** The target is the text of a PDF. */
  pdfTextTarget: boolean;
  poppler: boolean;
  sevenZip: boolean;
}

interface PlanRequest {
  src: string;
  tgt: string;
  input: Buffer | WorkerVfsPayload;
  options: WorkerEngineOptions;
  /** Text or HTML that the office suite renders first. */
  isNativeTextPdf: boolean;
}

/** Whether the media engine's route takes the pair: both formats are media, or a video source asks for thumbnails, subtitles or packaging. */
function ffmpegTakes(src: string, tgt: string, options: WorkerEngineOptions): boolean {
  if (!MEDIA_FORMATS.has(src)) return false;
  const optionDriven = (THUMBNAIL_TARGETS.has(tgt) && Boolean(options.thumbnail)) || (SUBTITLE_TARGETS.has(tgt) && options.subtitles?.mode === 'extract') || Boolean(options.packaging) || PACKAGING_TARGETS.has(tgt);
  return MEDIA_FORMATS.has(tgt) || optionDriven;
}

type OfficeRoutes = Pick<NativeRoutePlan, 'libreoffice' | 'recalculate' | 'libreofficePages' | 'presentationHtml'>;
type PageRoutes = Pick<NativeRoutePlan, 'fixedPage' | 'pdfTextTarget' | 'poppler'>;
type OtherRoutes = Pick<NativeRoutePlan, 'rawSensor' | 'svg' | 'raw' | 'ffmpeg' | 'sevenZip'>;

const allowsRoute = (options: WorkerEngineOptions, route: EngineId): boolean => engineAllowsRoute(options.engine, route);

function officeRoutes({ src, tgt, input, options, isNativeTextPdf }: PlanRequest): OfficeRoutes {
  const recalculate = Boolean(options.recalculate) && RECALCULATED_SOURCES.has(src);
  const resave = src === tgt && OFFICE_NATIVE_RESAVE_FORMATS.has(src);
  const presentationHtml = PRESENTATION_HTML_SOURCES.has(src) && tgt === HTML_TARGET;
  const allowed = allowsRoute(options, 'libreoffice');
  return {
    libreoffice: allowed && (isNativeTextPdf || recalculate || resave || officeSuiteReadsInputAndWrites(src, tgt, input)),
    recalculate,
    libreofficePages: allowed && officeSuiteReadsInput(src, input) && (isPdfChainTarget(tgt) || presentationHtml),
    presentationHtml,
  };
}

function pageRoutes({ src, tgt, options }: PlanRequest): PageRoutes {
  const fixedPage = fixedPageEngineOf(src);
  const pdfTextTarget = PDF_TEXT_TARGETS.has(tgt);
  const drawsFixedPage = fixedPage !== undefined && allowsRoute(options, fixedPage) && (tgt === PDF_TARGET || isPdfChainTarget(tgt));
  // An OCR request skips the text layer of the PDF.
  const readsPdf = src === PDF_SOURCE_FORMAT && !(pdfTextTarget && Boolean(options.ocrEnabled)) && (isPdfChainTarget(tgt) || pdfTextTarget);
  return { fixedPage: drawsFixedPage ? fixedPage : undefined, pdfTextTarget, poppler: allowsRoute(options, 'poppler') && readsPdf };
}

function otherRoutes({ src, tgt, options }: PlanRequest): OtherRoutes {
  return {
    rawSensor: allowsRoute(options, BUILT_IN_ENGINE) && IN_PROCESS_RAW_SENSOR_FORMATS.has(src) && !RAW_PACKAGING_TARGETS.has(tgt),
    svg: allowsRoute(options, 'librsvg') && src === SVG_SOURCE && tgt === PDF_TARGET,
    raw: allowsRoute(options, 'libraw') && RAW_CAMERA_FORMATS.has(src) && !RAW_PACKAGING_TARGETS.has(tgt),
    ffmpeg: allowsRoute(options, 'ffmpeg') && ffmpegTakes(src, tgt, options),
    sevenZip: allowsRoute(options, '7zip') && ARCHIVE_EXTRACT_FORMATS.has(src) && ARCHIVE_TARGET_FORMATS.has(tgt),
  };
}

/**
 * The native routes that take a conversion. A request that named an engine keeps only that engine's routes (the built-in converter has
 * none; the in-process decoder of camera files that LibRaw cannot open counts as the built-in converter's), so the route a request chose
 * is the only one that runs.
 */
export function planNativeRoutes(request: PlanRequest): NativeRoutePlan {
  return { ...officeRoutes(request), ...pageRoutes(request), ...otherRoutes(request) };
}
