import type { FamilyRunner } from '../context';
import type { Family } from '../report';
import { runAudio } from './audio';
import { runCad } from './cad';
import { runCompression } from './compression';
import { runDocument } from './document';
import { runImage } from './image';
import { runOcr } from './ocr';
import { runPdfOps } from './pdf-ops';
import { runRaw } from './raw';
import { runVector } from './vector';
import { runVideo } from './video';

export const FAMILY_RUNNERS: Record<Family, FamilyRunner> = {
  image: runImage,
  video: runVideo,
  audio: runAudio,
  ocr: runOcr,
  document: runDocument,
  compression: runCompression,
  cad: runCad,
  raw: runRaw,
  'pdf-ops': runPdfOps,
  vector: runVector,
};
