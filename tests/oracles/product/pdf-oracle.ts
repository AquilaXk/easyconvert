import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import {
  getOracleToolPath,
  requireOracleTool,
  OracleToolMissingError,
} from '../../helpers/differential-oracle';

export interface MssimOptions {
  /** Target threshold for passing test (default: 0.98) */
  threshold?: number;
  /** Downscale factor for very large images (default: 1.0, no downscale) */
  scaleFactor?: number;
}

export interface MssimResult {
  mssim: number;
  passed: boolean;
  width: number;
  height: number;
  samplePoints: number;
}

export interface CerResult {
  cer: number;
  editDistance: number;
  insertions: number;
  deletions: number;
  substitutions: number;
  referenceLength: number;
  hypothesisLength: number;
}

export interface PdfOracleVerificationResult {
  passed: boolean;
  pageCount: number;
  pageMssimScores: number[];
  meanMssim: number;
  cerScore?: number;
  extractedText?: string;
  discrepancies: string[];
}

/**
 * 1D Gaussian kernel for Wang et al. 2004 MSSIM window.
 * Size: 11, sigma = 1.5, normalized to sum to 1.0.
 */
function create1DGaussianKernel(): Float64Array {
  const kernel = new Float64Array(11);
  const sigma = 1.5;
  const radius = 5;
  let sum = 0;
  for (let i = 0; i <= 10; i++) {
    const x = i - radius;
    const g = Math.exp(-(x * x) / (2 * sigma * sigma));
    kernel[i] = g;
    sum += g;
  }
  for (let i = 0; i <= 10; i++) {
    kernel[i] /= sum;
  }
  return kernel;
}

const GAUSSIAN_1D_KERNEL = create1DGaussianKernel();

/**
 * Separable 2D Gaussian convolution on 2D Float64Array luminance plane.
 */
function convolve2DGaussian(
  input: Float64Array,
  width: number,
  height: number
): Float64Array {
  const intermediate = new Float64Array(width * height);
  const output = new Float64Array(width * height);
  const kernel = GAUSSIAN_1D_KERNEL;
  const radius = 5;

  // 1. Horizontal 1D convolution
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const nx = Math.min(Math.max(x + k, 0), width - 1);
        sum += input[rowOffset + nx] * kernel[k + radius];
      }
      intermediate[rowOffset + x] = sum;
    }
  }

  // 2. Vertical 1D convolution
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const ny = Math.min(Math.max(y + k, 0), height - 1);
        sum += intermediate[ny * width + x] * kernel[k + radius];
      }
      output[y * width + x] = sum;
    }
  }

  return output;
}

/**
 * Computes authentic Wang et al. 2004 Mean Structural Similarity Index (MSSIM)
 * using an 11x11 Gaussian window (sigma = 1.5) between two image buffers.
 */
export async function computeWang2004Mssim(
  imgA: Buffer,
  imgB: Buffer,
  options: MssimOptions = {}
): Promise<MssimResult> {
  const threshold = options.threshold ?? 0.98;

  const [rawA, rawB] = await Promise.all([
    sharp(imgA).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(imgB).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);

  if (rawA.info.width !== rawB.info.width || rawA.info.height !== rawB.info.height) {
    throw new Error(
      `Dimension mismatch for MSSIM comparison: A is ${rawA.info.width}x${rawA.info.height}, B is ${rawB.info.width}x${rawB.info.height}`
    );
  }

  const { width, height } = rawA.info;
  const pixelCount = width * height;

  if (pixelCount === 0) {
    return { mssim: 1.0, passed: true, width, height, samplePoints: 0 };
  }

  // Convert RGBA to grayscale luminance (0..255)
  const lumA = new Float64Array(pixelCount);
  const lumB = new Float64Array(pixelCount);
  const bufA = rawA.data;
  const bufB = rawB.data;

  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4;
    lumA[i] = 0.299 * bufA[idx] + 0.587 * bufA[idx + 1] + 0.114 * bufA[idx + 2];
    lumB[i] = 0.299 * bufB[idx] + 0.587 * bufB[idx + 1] + 0.114 * bufB[idx + 2];
  }

  if (width < 11 || height < 11) {
    // For tiny images where 11x11 window does not fit, compute global statistics
    let meanA = 0;
    let meanB = 0;
    for (let i = 0; i < pixelCount; i++) {
      meanA += lumA[i];
      meanB += lumB[i];
    }
    meanA /= pixelCount;
    meanB /= pixelCount;

    let varA = 0;
    let varB = 0;
    let covAB = 0;
    for (let i = 0; i < pixelCount; i++) {
      const da = lumA[i] - meanA;
      const db = lumB[i] - meanB;
      varA += da * da;
      varB += db * db;
      covAB += da * db;
    }
    const denom = Math.max(1, pixelCount - 1);
    varA /= denom;
    varB /= denom;
    covAB /= denom;

    const C1 = (0.01 * 255) ** 2;
    const C2 = (0.03 * 255) ** 2;
    const ssim = ((2 * meanA * meanB + C1) * (2 * covAB + C2)) /
      ((meanA * meanA + meanB * meanB + C1) * (varA + varB + C2));
    const score = Math.max(0, Math.min(1.0, ssim));
    return { mssim: score, passed: score >= threshold, width, height, samplePoints: 1 };
  }

  // Intermediate product planes
  const lumA2 = new Float64Array(pixelCount);
  const lumB2 = new Float64Array(pixelCount);
  const lumAB = new Float64Array(pixelCount);

  for (let i = 0; i < pixelCount; i++) {
    lumA2[i] = lumA[i] * lumA[i];
    lumB2[i] = lumB[i] * lumB[i];
    lumAB[i] = lumA[i] * lumB[i];
  }

  // 2D Gaussian filtered means and cross products
  const muA = convolve2DGaussian(lumA, width, height);
  const muB = convolve2DGaussian(lumB, width, height);
  const muA2 = convolve2DGaussian(lumA2, width, height);
  const muB2 = convolve2DGaussian(lumB2, width, height);
  const muAB = convolve2DGaussian(lumAB, width, height);

  const C1 = (0.01 * 255) ** 2; // 6.5025
  const C2 = (0.03 * 255) ** 2; // 58.5225

  let ssimSum = 0;
  let sampleCount = 0;

  // Window valid bounds (stride 1)
  const radius = 5;
  for (let y = radius; y < height - radius; y++) {
    const rowOffset = y * width;
    for (let x = radius; x < width - radius; x++) {
      const idx = rowOffset + x;
      const mX = muA[idx];
      const mY = muB[idx];
      const mX2 = mX * mX;
      const mY2 = mY * mY;
      const mXY = mX * mY;

      const sigmaX2 = Math.max(0, muA2[idx] - mX2);
      const sigmaY2 = Math.max(0, muB2[idx] - mY2);
      const sigmaXY = muAB[idx] - mXY;

      const num = (2 * mXY + C1) * (2 * sigmaXY + C2);
      const den = (mX2 + mY2 + C1) * (sigmaX2 + sigmaY2 + C2);

      const localSsim = den !== 0 ? num / den : 1.0;
      ssimSum += localSsim;
      sampleCount++;
    }
  }

  const mssim = sampleCount > 0 ? Math.max(0, Math.min(1.0, ssimSum / sampleCount)) : 1.0;

  return {
    mssim,
    passed: mssim >= threshold,
    width,
    height,
    samplePoints: sampleCount,
  };
}

/**
 * Computes Character Error Rate (CER) via Levenshtein edit distance between
 * hypothesis string and reference string.
 */
export function calculateCharacterErrorRate(
  hypothesis: string,
  reference: string,
  options: { normalizeWhitespace?: boolean } = {}
): CerResult {
  const normHyp = options.normalizeWhitespace
    ? hypothesis.replace(/\f/g, '\n').replace(/\r\n/g, '\n').replace(/\n+/g, '\n').trim()
    : hypothesis;
  const normRef = options.normalizeWhitespace
    ? reference.replace(/\f/g, '\n').replace(/\r\n/g, '\n').replace(/\n+/g, '\n').trim()
    : reference;

  const hyp = Array.from(normHyp);
  const ref = Array.from(normRef);

  const n = hyp.length;
  const m = ref.length;

  if (m === 0) {
    const cer = n === 0 ? 0.0 : 1.0;
    return {
      cer,
      editDistance: n,
      insertions: n,
      deletions: 0,
      substitutions: 0,
      referenceLength: 0,
      hypothesisLength: n,
    };
  }

  if (n === 0) {
    return {
      cer: 1.0,
      editDistance: m,
      insertions: 0,
      deletions: m,
      substitutions: 0,
      referenceLength: m,
      hypothesisLength: 0,
    };
  }

  // Dynamic programming matrix with operation tracking
  // dp[i][j] stores [distance, insertions, deletions, substitutions]
  const prevRow = new Array(m + 1);
  for (let j = 0; j <= m; j++) {
    prevRow[j] = { dist: j, ins: 0, del: j, sub: 0 };
  }

  for (let i = 1; i <= n; i++) {
    const currRow = new Array(m + 1);
    currRow[0] = { dist: i, ins: i, del: 0, sub: 0 };

    for (let j = 1; j <= m; j++) {
      const cost = hyp[i - 1] === ref[j - 1] ? 0 : 1;

      // Substitution / Match
      const matchSub = {
        dist: prevRow[j - 1].dist + cost,
        ins: prevRow[j - 1].ins,
        del: prevRow[j - 1].del,
        sub: prevRow[j - 1].sub + cost,
      };

      // Insertion (relative to reference)
      const insertion = {
        dist: prevRow[j].dist + 1,
        ins: prevRow[j].ins + 1,
        del: prevRow[j].del,
        sub: prevRow[j].sub,
      };

      // Deletion (relative to reference)
      const deletion = {
        dist: currRow[j - 1].dist + 1,
        ins: currRow[j - 1].ins,
        del: currRow[j - 1].del + 1,
        sub: currRow[j - 1].sub,
      };

      let best = matchSub;
      if (insertion.dist < best.dist) best = insertion;
      if (deletion.dist < best.dist) best = deletion;

      currRow[j] = best;
    }

    for (let j = 0; j <= m; j++) {
      prevRow[j] = currRow[j];
    }
  }

  const result = prevRow[m];
  const cer = result.dist / m;

  return {
    cer,
    editDistance: result.dist,
    insertions: result.ins,
    deletions: result.del,
    substitutions: result.sub,
    referenceLength: m,
    hypothesisLength: n,
  };
}

/**
 * Renders PDF pages into PNG images using Poppler's native `pdftoppm` CLI.
 */
export async function renderPdfPagesWithPdftoppm(
  pdfBuffer: Buffer,
  options: { dpi?: number } = {}
): Promise<Buffer[]> {
  const pdftoppmPath = requireOracleTool('pdftoppm');
  const dpi = options.dpi ?? 150;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-oracle-render-'));
  const inputPdfPath = path.join(tempDir, 'input.pdf');
  const outPrefix = path.join(tempDir, 'page');

  try {
    fs.writeFileSync(inputPdfPath, pdfBuffer);
    execFileSync(pdftoppmPath, ['-png', '-r', String(dpi), inputPdfPath, outPrefix], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const files = fs.readdirSync(tempDir);
    const pageFiles = files
      .filter((f) => f.startsWith('page-') && f.endsWith('.png'))
      .sort((a, b) => {
        const numA = parseInt(a.replace(/[^0-9]/g, ''), 10) || 0;
        const numB = parseInt(b.replace(/[^0-9]/g, ''), 10) || 0;
        return numA - numB;
      });

    return pageFiles.map((f) => fs.readFileSync(path.join(tempDir, f)));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Extracts plain text from a PDF buffer using Poppler's native `pdftotext` CLI.
 */
export function extractTextWithPdftotext(pdfBuffer: Buffer): string {
  const pdftotextPath = requireOracleTool('pdftotext');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-oracle-text-'));
  const inputPdfPath = path.join(tempDir, 'input.pdf');
  const outputTxtPath = path.join(tempDir, 'output.txt');

  try {
    fs.writeFileSync(inputPdfPath, pdfBuffer);
    execFileSync(pdftotextPath, [inputPdfPath, outputTxtPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (fs.existsSync(outputTxtPath)) {
      return fs.readFileSync(outputTxtPath, 'utf-8');
    }
    return '';
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * End-to-end PDF Product Differential Oracle:
 * 1. Renders pages using Poppler `pdftoppm` and verifies Wang 2004 MSSIM against reference.
 * 2. Extracts text using `pdftotext` and computes CER against ground-truth text.
 */
export async function verifyPdfFidelityWithOracle(
  actualPdf: Buffer,
  referencePdf: Buffer,
  groundTruthText?: string,
  options: {
    mssimThreshold?: number;
    cerThreshold?: number;
    dpi?: number;
    normalizeWhitespace?: boolean;
  } = {}
): Promise<PdfOracleVerificationResult> {
  const mssimThreshold = options.mssimThreshold ?? 0.98;
  const cerThreshold = options.cerThreshold ?? 0.05; // 5% max character error
  const normalizeWhitespace = options.normalizeWhitespace ?? true;
  const discrepancies: string[] = [];

  const [actualPages, refPages] = await Promise.all([
    renderPdfPagesWithPdftoppm(actualPdf, { dpi: options.dpi }),
    renderPdfPagesWithPdftoppm(referencePdf, { dpi: options.dpi }),
  ]);

  if (actualPages.length !== refPages.length) {
    discrepancies.push(
      `PDF page count mismatch: actual has ${actualPages.length} pages, reference has ${refPages.length} pages`
    );
  }

  const pageMssimScores: number[] = [];
  const minPages = Math.min(actualPages.length, refPages.length);

  for (let p = 0; p < minPages; p++) {
    const mssimRes = await computeWang2004Mssim(actualPages[p], refPages[p], {
      threshold: mssimThreshold,
    });
    pageMssimScores.push(mssimRes.mssim);
    if (!mssimRes.passed) {
      discrepancies.push(
        `Page ${p + 1} MSSIM score ${mssimRes.mssim.toFixed(4)} failed threshold ${mssimThreshold}`
      );
    }
  }

  const meanMssim = pageMssimScores.length > 0
    ? pageMssimScores.reduce((a, b) => a + b, 0) / pageMssimScores.length
    : 0;

  let cerScore: number | undefined;
  let extractedText: string | undefined;

  if (groundTruthText !== undefined) {
    extractedText = extractTextWithPdftotext(actualPdf);
    const cerResult = calculateCharacterErrorRate(extractedText, groundTruthText, {
      normalizeWhitespace,
    });
    cerScore = cerResult.cer;

    if (cerResult.cer > cerThreshold) {
      discrepancies.push(
        `Character Error Rate (CER) ${cerResult.cer.toFixed(4)} exceeds allowed threshold ${cerThreshold} (Edits: ${cerResult.editDistance}/${cerResult.referenceLength})`
      );
    }
  }

  const passed = discrepancies.length === 0;

  return {
    passed,
    pageCount: actualPages.length,
    pageMssimScores,
    meanMssim,
    cerScore,
    extractedText,
    discrepancies,
  };
}
