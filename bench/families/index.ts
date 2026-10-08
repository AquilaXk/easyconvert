import type { FamilyRunner } from '../context';
import type { Family } from '../report';
import { runAudio } from './audio';
import { runCompression } from './compression';
import { runDocument } from './document';
import { runImage } from './image';
import { runOcr } from './ocr';
import { runVideo } from './video';

export const FAMILY_RUNNERS: Record<Family, FamilyRunner> = {
  image: runImage,
  video: runVideo,
  audio: runAudio,
  ocr: runOcr,
  document: runDocument,
  compression: runCompression,
};
