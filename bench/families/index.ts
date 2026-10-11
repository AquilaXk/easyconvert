import type { FamilyRunner } from '../context';
import type { Family } from '../report';
import { runAudio } from './audio';
import { runCad } from './cad';
import { runCompression } from './compression';
import { runData } from './data';
import { runDocument } from './document';
import { runDocumentPublic } from './document-public';
import { runEbook } from './ebook';
import { runFont } from './font';
import { runImage } from './image';
import { runOcr } from './ocr';
import { runPdfOps } from './pdf-ops';
import { runPdfOpsPublic } from './pdf-ops-public';
import { runRaw } from './raw';
import { runVector } from './vector';
import { runVideo } from './video';

export const FAMILY_RUNNERS: Record<Family, FamilyRunner> = {
  image: runImage,
  video: runVideo,
  audio: runAudio,
  ocr: runOcr,
  document: async (ctx) => [...(await runDocument(ctx)), ...(await runDocumentPublic(ctx))],
  compression: runCompression,
  'pdf-ops': async (ctx) => [...(await runPdfOps(ctx)), ...(await runPdfOpsPublic(ctx))],
  data: runData,
  ebook: runEbook,
  font: runFont,
  cad: runCad,
  raw: runRaw,
  vector: runVector,
};
