import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { ConversionOptions, OcrLanguageUnavailableError, OcrEngineUnavailableError } from '../types';
import {
  createLosslessSandwichPdfFromImage,
  parseTesseractBlocks,
  sortLineBlocksTopological,
  detectColumnGutters,
  ColumnGutter,
  OcrBBox,
  OcrWord,
  OcrLineBlock,
  OcrResult,
} from './ocr-pdf-combiner';

export type { ColumnGutter, OcrBBox, OcrWord, OcrLineBlock, OcrResult };
export { sortLineBlocksTopological, detectColumnGutters };

/**
 * Optical Character Recognition (OCR) Engine
 * Powered by authentic WebAssembly inference (Tesseract.js) and native Tesseract CLI.
 * Strictly fail-closed without geometric fallback or fabricated glyph classification.
 */
export async function performOcr(
  imageBuffer: Buffer,
  language: string = 'auto'
): Promise<OcrResult> {
  const langMap: Record<string, string> = {
    auto: 'eng',
    en: 'eng',
    eng: 'eng',
    ko: 'kor',
    kor: 'kor',
    de: 'deu',
    deu: 'deu',
    fr: 'fra',
    fra: 'fra',
    es: 'spa',
    spa: 'spa',
    ja: 'jpn',
    jpn: 'jpn',
    zh: 'chi_sim',
    chi_sim: 'chi_sim',
  };
  const tesseractLang = langMap[language.toLowerCase()];
  if (!tesseractLang) {
    throw new OcrLanguageUnavailableError(
      `Unsupported or unrecognized OCR language: '${language}'. Supported languages: ${Object.keys(langMap).join(', ')}.`
    );
  }

  // 1. Locate local or system pre-downloaded traineddata for zero-network offline inference
  const candidateDirs = [
    ...(process.env.TESSDATA_PREFIX ? [process.env.TESSDATA_PREFIX] : []),
    process.cwd(),
    '/usr/share/tesseract-ocr/5/tessdata',
    '/usr/share/tesseract-ocr/4.00/tessdata',
    '/usr/share/tessdata',
    '/opt/homebrew/share/tessdata',
    '/usr/local/share/tessdata',
  ];

  let localLangPath: string | undefined;
  let isGzip = false;
  for (const dir of candidateDirs) {
    const candidateGz = path.join(dir, `${tesseractLang}.traineddata.gz`);
    const candidateRaw = path.join(dir, `${tesseractLang}.traineddata`);
    if (fs.existsSync(candidateGz)) {
      localLangPath = dir;
      isGzip = true;
      break;
    }
    if (fs.existsSync(candidateRaw)) {
      localLangPath = dir;
      isGzip = false;
      break;
    }
  }

  if (!localLangPath) {
    throw new OcrLanguageUnavailableError(
      `OCR language '${language}' (${tesseractLang}.traineddata) is not available locally.`
    );
  }

  // Validate that imageBuffer is a decodable image before sending to Tesseract worker
  try {
    await sharp(imageBuffer).metadata();
  } catch (imgErr) {
    throw new OcrEngineUnavailableError(
      `OCR engine (Tesseract) is unavailable or failed to execute for language '${language}': invalid image buffer.`
    );
  }

  // 2. Try High-Performance WebAssembly Inference Engine (Tesseract.js)
  try {
    const Tesseract = await import('tesseract.js');
    const worker = await Tesseract.createWorker(tesseractLang, 1, {
      langPath: localLangPath,
      cacheMethod: 'none',
      gzip: isGzip,
    });
    const ret = await worker.recognize(imageBuffer, {}, { blocks: true });
    await worker.terminate();

    if (ret && ret.data) {
      const fullText = (ret.data.text || '').trim();
      const meta = await sharp(imageBuffer).metadata().catch(() => ({ width: 800, height: 600 }));
      const imgWidth = meta.width || 800;
      const imgHeight = meta.height || 600;
      const { lines: recognizedLines, lineBlocks } = parseTesseractBlocks(ret.data.blocks, imgWidth, imgHeight);

      const words = fullText.split(/\s+/).filter(Boolean);

      // Compute authentic mean word confidence across recognized blocks/words
      let totalConf = 0;
      let confCount = 0;
      if (Array.isArray((ret.data as any).words) && (ret.data as any).words.length > 0) {
        for (const w of (ret.data as any).words) {
          if (typeof w.confidence === 'number' && !isNaN(w.confidence)) {
            totalConf += w.confidence;
            confCount++;
          }
        }
      } else if (Array.isArray(lineBlocks) && lineBlocks.length > 0) {
        for (const block of lineBlocks) {
          if (Array.isArray(block.words)) {
            for (const w of block.words) {
              const wConf = (w as any).confidence;
              if (typeof wConf === 'number' && !isNaN(wConf)) {
                totalConf += wConf;
                confCount++;
              }
            }
          }
        }
      }

      const meanConf =
        confCount > 0
          ? totalConf / confCount / 100
          : typeof ret.data.confidence === 'number'
          ? ret.data.confidence / 100
          : null;

      return {
        text: fullText,
        confidence: meanConf,
        wordCount: words.length,
        lines: recognizedLines.length > 0 ? recognizedLines : (fullText ? fullText.split('\n') : []),
        lineBlocks,
        imageWidth: imgWidth,
        imageHeight: imgHeight,
      };
    }
  } catch (err: any) {
    if (err instanceof OcrEngineUnavailableError || err instanceof OcrLanguageUnavailableError) {
      throw err;
    }
    // Fall back to system native CLI if Tesseract.js fails
  }

  // 3. Try System Native Tesseract CLI if available
  const tesseractCandidates = ['/usr/bin/tesseract', '/usr/local/bin/tesseract', '/opt/homebrew/bin/tesseract'];
  const tesseractCli = tesseractCandidates.find((p) => fs.existsSync(p));
  if (tesseractCli) {
    const tmpIn = path.join(os.tmpdir(), `ocr_cli_in_${crypto.randomUUID()}.png`);
    const tmpOutBase = path.join(os.tmpdir(), `ocr_cli_out_${crypto.randomUUID()}`);
    try {
      fs.writeFileSync(tmpIn, imageBuffer);
      execFileSync(tesseractCli, [tmpIn, tmpOutBase, '-l', tesseractLang], {
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 15000,
      });
      const outTxtPath = `${tmpOutBase}.txt`;
      if (fs.existsSync(outTxtPath)) {
        const cliText = fs.readFileSync(outTxtPath, 'utf-8').trim();
        fs.unlinkSync(outTxtPath);
        const meta = await sharp(imageBuffer).metadata().catch(() => ({ width: 800, height: 600 }));
        const lines = cliText ? cliText.split('\n').map((l) => l.trim()).filter(Boolean) : [];
        return {
          text: cliText,
          confidence: null,
          wordCount: cliText ? cliText.split(/\s+/).filter(Boolean).length : 0,
          lines,
          lineBlocks: [],
          imageWidth: meta.width || 800,
          imageHeight: meta.height || 600,
        };
      }
    } catch (err: any) {
      // CLI failed
    } finally {
      try {
        if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
      } catch {}
    }
  }

  throw new OcrEngineUnavailableError(
    `OCR engine (Tesseract) is unavailable or failed to execute for language '${language}'.`
  );
}

/**
 * Synthesizes a true Searchable PDF by embedding invisible text matching
 * word and line coordinates (3 Tr, Tz, Tm), enabling native text selection,
 * copying, and Ctrl+F searching with 100% metadata preservation.
 */
export async function generateSearchablePdf(
  scannedImageBuffer: Buffer,
  ocrResult: OcrResult,
  options: ConversionOptions = {},
  title = 'Searchable Document'
): Promise<Buffer> {
  return createLosslessSandwichPdfFromImage(scannedImageBuffer, ocrResult, options, title);
}
