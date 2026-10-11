import type { FamilyRunner } from '../context';
import type { Family } from '../report';
import { runAudio } from './audio';
import { runCompression } from './compression';
import { runData } from './data';
import { runDocument } from './document';
import { runEbook } from './ebook';
import { runFont } from './font';
import { runImage } from './image';
import { runOcr } from './ocr';
import { runPdfOps } from './pdf-ops';
import { runVideo } from './video';

export const FAMILY_RUNNERS: Record<Family, FamilyRunner> = {
  image: runImage,
  video: runVideo,
  audio: runAudio,
  ocr: runOcr,
  document: runDocument,
  compression: runCompression,
  'pdf-ops': runPdfOps,
  data: runData,
  ebook: runEbook,
  font: runFont,
};
