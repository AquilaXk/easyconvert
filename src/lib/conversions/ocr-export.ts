import { OcrResult, OcrLineBlock, OcrWord, OcrPageResult } from './ocr-pdf-combiner';
import { HocrExportOptions, AltoExportOptions } from '../types';

/**
 * Escapes characters for XML / XHTML output.
 */
function escapeXml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}


interface RoundedBBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  w: number;
  h: number;
}

function roundBBox(
  bbox?: { x?: number; y?: number; width?: number; height?: number; x0?: number; y0?: number; x1?: number; y1?: number } | null
): RoundedBBox {
  const x = bbox?.x ?? bbox?.x0 ?? 0;
  const y = bbox?.y ?? bbox?.y0 ?? 0;
  const w = bbox?.width ?? (bbox?.x1 != null ? Math.max(1, bbox.x1 - x) : 10);
  const h = bbox?.height ?? (bbox?.y1 != null ? Math.max(1, bbox.y1 - y) : 10);
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  const rw = Math.max(1, Math.round(w));
  const rh = Math.max(1, Math.round(h));
  return { x0, y0, x1: x0 + rw, y1: y0 + rh, w: rw, h: rh };
}

function computeWordConfidence(
  wordConf?: number | null,
  pageConf?: number | null
): number {
  if (typeof wordConf === 'number' && !isNaN(wordConf)) {
    return wordConf > 1 ? wordConf / 100 : wordConf;
  }
  if (typeof pageConf === 'number' && !isNaN(pageConf)) {
    return pageConf > 1 ? pageConf / 100 : pageConf;
  }
  return 0.9;
}

/**
 * Normalizes an OcrResult or OcrResult[] into an array of page structures.
 */
function normalizePages(
  ocrInput: OcrResult | OcrResult[],
  defaultWidth = 612,
  defaultHeight = 792
): OcrPageResult[] {
  if (Array.isArray(ocrInput)) {
    return ocrInput.map((res, idx) => {
      const w = (res as any).width || res.imageWidth || defaultWidth;
      const h = (res as any).height || res.imageHeight || defaultHeight;
      return {
        pageNumber: idx + 1,
        width: w,
        height: h,
        text: res.text || '',
        confidence: res.confidence,
        lineBlocks: res.lineBlocks && res.lineBlocks.length > 0 ? res.lineBlocks : synthesizeLineBlocks({ ...res, width: w, height: h }),
        lines: res.lines,
      };
    });
  }

  if (ocrInput.pages && ocrInput.pages.length > 0) {
    return ocrInput.pages.map((p, idx) => {
      const w = p.width || ocrInput.imageWidth || defaultWidth;
      const h = p.height || ocrInput.imageHeight || defaultHeight;
      return {
        pageNumber: p.pageNumber || idx + 1,
        width: w,
        height: h,
        text: p.text || '',
        confidence: p.confidence ?? ocrInput.confidence,
        lineBlocks: p.lineBlocks && p.lineBlocks.length > 0 ? p.lineBlocks : synthesizeLineBlocks({ ...p, width: w, height: h }),
        lines: p.lines,
      };
    });
  }

  const w = (ocrInput as any).width || ocrInput.imageWidth || defaultWidth;
  const h = (ocrInput as any).height || ocrInput.imageHeight || defaultHeight;
  return [
    {
      pageNumber: 1,
      width: w,
      height: h,
      text: ocrInput.text || '',
      confidence: ocrInput.confidence,
      lineBlocks: ocrInput.lineBlocks && ocrInput.lineBlocks.length > 0 ? ocrInput.lineBlocks : synthesizeLineBlocks({ ...ocrInput, width: w, height: h }),
      lines: ocrInput.lines,
    },
  ];
}

/**
 * Synthesizes line blocks and words if only plain lines/text exist.
 */
function synthesizeLineBlocks(res: { text?: string; lines?: string[]; imageWidth?: number; imageHeight?: number; width?: number; height?: number; confidence?: number | null }): OcrLineBlock[] {
  const lines = res.lines && res.lines.length > 0 ? res.lines : (res.text || '').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const pageWidth = (res as any).width || res.imageWidth || 612;
  const pageHeight = (res as any).height || res.imageHeight || 792;
  const lineHeight = Math.min(24, Math.max(12, Math.floor(pageHeight / (lines.length + 4))));
  const startY = 40;

  return lines.map((lineText, idx) => {
    const y = startY + idx * (lineHeight + 6);
    const wordsRaw = lineText.trim().split(/\s+/).filter(Boolean);
    const wordWidth = wordsRaw.length > 0 ? Math.max(20, Math.floor((pageWidth - 80) / wordsRaw.length)) : 50;

    const words: OcrWord[] = wordsRaw.map((w, wIdx) => ({
      text: w,
      confidence: res.confidence !== null && res.confidence !== undefined ? (res.confidence > 1 ? res.confidence : res.confidence * 100) : 90,
      bbox: {
        x: 40 + wIdx * wordWidth,
        y,
        width: Math.max(10, wordWidth - 4),
        height: lineHeight,
      },
    }));

    return {
      text: lineText,
      bbox: {
        x: 40,
        y,
        width: Math.max(10, pageWidth - 80),
        height: lineHeight,
      },
      words,
    };
  });
}

/**
 * Ensures a block has valid words. If block.words is empty, splits block.text.
 */
function ensureWordsForBlock(block: OcrLineBlock, pageConfidence: number | null): OcrWord[] {
  if (block.words && block.words.length > 0) {
    return block.words;
  }

  const rawWords = (block.text || '').trim().split(/\s+/).filter(Boolean);
  if (rawWords.length === 0) return [];

  const b = block.bbox;
  const totalChars = rawWords.reduce((sum, w) => sum + w.length, 0);
  const charWidth = totalChars > 0 ? b.width / Math.max(totalChars, 1) : 10;
  let currX = b.x;

  return rawWords.map((wordText) => {
    const wWidth = Math.max(5, Math.round(wordText.length * charWidth));
    const word: OcrWord = {
      text: wordText,
      confidence: pageConfidence !== null && pageConfidence !== undefined ? (pageConfidence > 1 ? pageConfidence : pageConfidence * 100) : 90,
      bbox: {
        x: currX,
        y: b.y,
        width: wWidth,
        height: b.height,
      },
    };
    currX += wWidth + Math.round(charWidth * 0.5);
    return word;
  });
}

/**
 * Exports OCR results to hOCR 1.2 compliant XHTML standard format.
 * Embeds standard semantic HTML/XML classes (ocr_page, ocr_carea, ocr_par, ocr_line, ocrx_word)
 * with bounding box title attributes (bbox x0 y0 x1 y1; x_wconf ...).
 */
export function exportHocr(
  ocrInput: OcrResult | OcrResult[],
  options: HocrExportOptions = {}
): string {
  const pages = normalizePages(ocrInput);
  const docTitle = options.documentTitle || options.filename || 'OCR Document';

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">',
    '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">',
    '<head>',
    `  <title>${escapeXml(docTitle)}</title>`,
    '  <meta http-equiv="Content-Type" content="text/html;charset=utf-8" />',
    '  <meta name="ocr-system" content="easyconvert-ocr" />',
    '  <meta name="ocr-capabilities" content="ocr_page ocr_carea ocr_par ocr_line ocrx_word" />',
    '</head>',
    '<body>',
  ];

  for (const page of pages) {
    const pNum = page.pageNumber;
    const pWidth = Math.round(page.width);
    const pHeight = Math.round(page.height);
    const cleanBase = options.filename ? options.filename.replace(/\.[^/.]+$/, '') : 'page';
    const imageName =
      pages.length > 1
        ? `${cleanBase}_page_${pNum}.png`
        : options.filename || `page_${pNum}.png`;

    lines.push(
      `  <div class="ocr_page" id="page_${pNum}" title="image &apos;${escapeXml(imageName)}&apos;; bbox 0 0 ${pWidth} ${pHeight}; ppageno ${pNum}">`
    );

    const blocks = page.lineBlocks || [];
    if (blocks.length > 0) {
      blocks.forEach((block, bIdx) => {
        const bb = roundBBox(block.bbox);
        lines.push(
          `    <div class="ocr_carea" id="block_${pNum}_${bIdx + 1}" title="bbox ${bb.x0} ${bb.y0} ${bb.x1} ${bb.y1}">`
        );
        lines.push(
          `      <p class="ocr_par" id="par_${pNum}_${bIdx + 1}" title="bbox ${bb.x0} ${bb.y0} ${bb.x1} ${bb.y1}">`
        );

        lines.push(
          `        <span class="ocr_line" id="line_${pNum}_${bIdx + 1}" title="bbox ${bb.x0} ${bb.y0} ${bb.x1} ${bb.y1}; baseline 0 0">`
        );

        const words = ensureWordsForBlock(block, page.confidence);
        for (let wIdx = 0; wIdx < words.length; wIdx++) {
          const w = words[wIdx];
          const wb = roundBBox(w.bbox);
          const wconf = Math.max(0, Math.min(100, Math.round(computeWordConfidence(w.confidence, page.confidence) * 100)));

          lines.push(
            `          <span class="ocrx_word" id="word_${pNum}_${bIdx + 1}_${wIdx + 1}" title="bbox ${wb.x0} ${wb.y0} ${wb.x1} ${wb.y1}; x_wconf ${wconf}">${escapeXml(w.text)}</span>`
          );
        }

        lines.push('        </span>');
        lines.push('      </p>');
        lines.push('    </div>');
      });
    }

    lines.push('  </div>');
  }

  lines.push('</body>');
  lines.push('</html>');
  lines.push('');

  return lines.join('\n');
}

/**
 * Exports OCR results to ALTO 4.x XML (Library of Congress standard) format.
 * Generates valid <alto>, <Description>, <Layout>, <Page>, <PrintSpace>, <TextBlock>,
 * <TextLine>, and <String> tags with HPOS, VPOS, WIDTH, HEIGHT, and WC attributes.
 */
export function exportAlto(
  ocrInput: OcrResult | OcrResult[],
  options: AltoExportOptions = {}
): string {
  const pages = normalizePages(ocrInput);
  const fileName = options.filename || 'document.pdf';
  const unit = options.measurementUnit || 'pixel';

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<alto xmlns="http://www.loc.gov/standards/alto/ns-v4#"',
    '      xmlns:xlink="http://www.w3.org/1999/xlink"',
    '      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '      xsi:schemaLocation="http://www.loc.gov/standards/alto/ns-v4# http://www.loc.gov/standards/alto/v4/alto-4-2.xsd">',
    '  <Description>',
    `    <MeasurementUnit>${escapeXml(unit)}</MeasurementUnit>`,
    '    <sourceImageInformation>',
    `      <fileName>${escapeXml(fileName)}</fileName>`,
    '    </sourceImageInformation>',
    '    <OCRProcessing ID="OCR_0">',
    '      <ocrProcessingStep>',
    '        <processingSoftware>',
    '          <softwareName>easyconvert</softwareName>',
    '          <softwareVersion>0.1.0</softwareVersion>',
    '        </processingSoftware>',
    '      </ocrProcessingStep>',
    '    </OCRProcessing>',
    '  </Description>',
    '  <Layout>',
  ];

  for (const page of pages) {
    const pNum = page.pageNumber;
    const pWidth = Math.round(page.width);
    const pHeight = Math.round(page.height);

    lines.push(
      `    <Page ID="PAGE_${pNum}" PHYSICAL_IMG_NR="${pNum}" WIDTH="${pWidth}" HEIGHT="${pHeight}">`
    );
    lines.push(
      `      <PrintSpace HPOS="0" VPOS="0" WIDTH="${pWidth}" HEIGHT="${pHeight}">`
    );

    const blocks = page.lineBlocks || [];
    blocks.forEach((block, bIdx) => {
      const bb = roundBBox(block.bbox);

      lines.push(
        `        <TextBlock ID="TB_${pNum}_${bIdx + 1}" HPOS="${bb.x0}" VPOS="${bb.y0}" WIDTH="${bb.w}" HEIGHT="${bb.h}">`
      );
      lines.push(
        `          <TextLine ID="TL_${pNum}_${bIdx + 1}" HPOS="${bb.x0}" VPOS="${bb.y0}" WIDTH="${bb.w}" HEIGHT="${bb.h}">`
      );

      const words = ensureWordsForBlock(block, page.confidence);
      for (let wIdx = 0; wIdx < words.length; wIdx++) {
        const w = words[wIdx];
        const wb = roundBBox(w.bbox);
        const wc = Math.max(0, Math.min(1.0, computeWordConfidence(w.confidence, page.confidence)));

        lines.push(
          `            <String CONTENT="${escapeXml(w.text)}" HPOS="${wb.x0}" VPOS="${wb.y0}" WIDTH="${wb.w}" HEIGHT="${wb.h}" WC="${wc.toFixed(2)}" />`
        );

        // Add standard <SP> whitespace delimiter between consecutive words in a line
        if (wIdx < words.length - 1) {
          const nextW = words[wIdx + 1];
          const spX = wb.x1;
          const spW = Math.max(1, Math.round(nextW.bbox.x - spX));
          lines.push(
            `            <SP HPOS="${spX}" VPOS="${wb.y0}" WIDTH="${spW}" />`
          );
        }
      }

      lines.push('          </TextLine>');
      lines.push('        </TextBlock>');
    });

    lines.push('      </PrintSpace>');
    lines.push('    </Page>');
  }

  lines.push('  </Layout>');
  lines.push('</alto>');
  lines.push('');

  return lines.join('\n');
}

/**
 * Unescapes XML / XHTML entities and numeric character references.
 */
export function unescapeXml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

/**
 * Robustly extracts an attribute value regardless of whether double or single quotes are used.
 */
function extractAttribute(tagAttrs: string, attrName: string): string {
  const regex = new RegExp(`${attrName}=(?:"([^"]*)"|'([^']*)')`, 'i');
  const match = tagAttrs.match(regex);
  return match ? (match[1] ?? match[2] ?? '') : '';
}

function buildOcrPage(
  pageNumber: number,
  width: number,
  height: number,
  lineBlocks: OcrLineBlock[]
): OcrPageResult {
  const pageLines = lineBlocks.map((b) => b.text).filter(Boolean);
  const pageText = pageLines.join('\n');
  let pageWordConfSum = 0;
  let pageWordCount = 0;
  for (const b of lineBlocks) {
    for (const w of b.words) {
      if (typeof w.confidence === 'number') {
        pageWordConfSum += w.confidence;
        pageWordCount++;
      }
    }
  }

  return {
    pageNumber,
    width,
    height,
    text: pageText,
    confidence: pageWordCount > 0 ? pageWordConfSum / pageWordCount / 100 : null,
    lineBlocks,
    lines: pageLines,
  };
}

function assembleParsedOcrResult(pages: OcrPageResult[]): OcrResult {
  const allTexts = pages.map((p) => p.text).filter(Boolean);
  const allLines = pages.flatMap((p) => p.lines || []);
  let totalWordConf = 0;
  let totalWordCount = 0;
  for (const p of pages) {
    for (const b of p.lineBlocks) {
      for (const w of b.words) {
        if (typeof w.confidence === 'number') {
          totalWordConf += w.confidence;
          totalWordCount++;
        }
      }
    }
  }

  const firstPage = pages[0];
  return {
    text: allTexts.join('\n\n').trim(),
    confidence: totalWordCount > 0 ? totalWordConf / totalWordCount / 100 : (firstPage?.confidence ?? null),
    wordCount: totalWordCount,
    lines: allLines,
    lineBlocks: pages.flatMap((p) => p.lineBlocks),
    imageWidth: firstPage?.width || 612,
    imageHeight: firstPage?.height || 792,
    pages,
  };
}

function buildFallbackOcrResult(cleanText: string, words: string[]): OcrResult {
  const lines = cleanText.split('\n').filter(Boolean);
  const wordCount = words.length > 0 ? words.length : cleanText.split(/\s+/).filter(Boolean).length;
  return {
    text: cleanText,
    confidence: 0.9,
    wordCount,
    lines,
    lineBlocks: [],
    imageWidth: 612,
    imageHeight: 792,
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        text: cleanText,
        confidence: 0.9,
        lineBlocks: [],
        lines,
      },
    ],
  };
}

function parseHocrWord(wordMatch: RegExpExecArray, lx0: number, ly0: number): OcrWord | null {
  const wordAttrs = wordMatch[1] || '';
  const wordTitle = extractAttribute(wordAttrs, 'title');
  const rawWordText = unescapeXml((wordMatch[2] || '').replace(/<[^>]+>/g, '')).trim();
  if (!rawWordText) return null;

  const wBboxMatch = wordTitle.match(/bbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/i);
  const wx0 = wBboxMatch ? Number.parseInt(wBboxMatch[1], 10) : lx0;
  const wy0 = wBboxMatch ? Number.parseInt(wBboxMatch[2], 10) : ly0;
  const wx1 = wBboxMatch ? Number.parseInt(wBboxMatch[3], 10) : wx0 + 40;
  const wy1 = wBboxMatch ? Number.parseInt(wBboxMatch[4], 10) : wy0 + 20;

  const wconfMatch = wordTitle.match(/x_wconf\s+(\d+)/i);
  const wconf = wconfMatch ? Number.parseInt(wconfMatch[1], 10) : 90;

  return {
    text: rawWordText,
    confidence: wconf,
    bbox: {
      x: wx0,
      y: wy0,
      width: Math.max(1, wx1 - wx0),
      height: Math.max(1, wy1 - wy0),
    },
  };
}

function parseHocrLine(
  curLine: { attrs: string; start: number; contentStart: number },
  nextLineStart: number,
  pageBody: string
): OcrLineBlock | null {
  const lineAttrs = curLine.attrs;
  const lineContent = pageBody.substring(curLine.contentStart, nextLineStart);
  const lineTitle = extractAttribute(lineAttrs, 'title');

  const lBboxMatch = lineTitle.match(/bbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/i);
  const lx0 = lBboxMatch ? Number.parseInt(lBboxMatch[1], 10) : 40;
  const ly0 = lBboxMatch ? Number.parseInt(lBboxMatch[2], 10) : 40;
  const lx1 = lBboxMatch ? Number.parseInt(lBboxMatch[3], 10) : lx0 + 100;
  const ly1 = lBboxMatch ? Number.parseInt(lBboxMatch[4], 10) : ly0 + 20;

  const words: OcrWord[] = [];
  const wordRegex = /<span\b([^>]*\bclass=["'][^"']*ocrx_word[^"']*["'][^>]*)>(.*?)<\/span>/gis;
  let wordMatch: RegExpExecArray | null;

  while ((wordMatch = wordRegex.exec(lineContent)) !== null) {
    const word = parseHocrWord(wordMatch, lx0, ly0);
    if (word) words.push(word);
  }

  const lineText = words.map((w) => w.text).join(' ');
  if (!lineText && words.length === 0) return null;

  return {
    text: lineText,
    bbox: {
      x: lx0,
      y: ly0,
      width: Math.max(1, lx1 - lx0),
      height: Math.max(1, ly1 - ly0),
    },
    words,
  };
}

function parseHocrPage(
  cur: { attrs: string; start: number; contentStart: number },
  nextStart: number,
  hocrContent: string,
  pageIdx: number
): OcrPageResult {
  const pageAttrs = cur.attrs;
  const pageBody = hocrContent.substring(cur.contentStart, nextStart);
  const pageTitle = extractAttribute(pageAttrs, 'title');

  const pBboxMatch = pageTitle.match(/bbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/i);
  const pWidth = pBboxMatch ? Math.max(1, Number.parseInt(pBboxMatch[3], 10) - Number.parseInt(pBboxMatch[1], 10)) : 612;
  const pHeight = pBboxMatch ? Math.max(1, Number.parseInt(pBboxMatch[4], 10) - Number.parseInt(pBboxMatch[2], 10)) : 792;
  const pNumMatch = pageTitle.match(/ppageno\s+(\d+)/i);
  const pageNumber = pNumMatch ? Number.parseInt(pNumMatch[1], 10) : pageIdx + 1;

  const lineBlocks: OcrLineBlock[] = [];
  const lineOpenRegex = /<span\b([^>]*\bclass=["'][^"']*ocr_line[^"']*["'][^>]*)>/gi;
  const lineMatches: { attrs: string; start: number; contentStart: number }[] = [];
  let lm: RegExpExecArray | null;

  while ((lm = lineOpenRegex.exec(pageBody)) !== null) {
    lineMatches.push({
      attrs: lm[1],
      start: lm.index,
      contentStart: lm.index + lm[0].length,
    });
  }

  for (let lIdx = 0; lIdx < lineMatches.length; lIdx++) {
    const nextLineStart = lIdx + 1 < lineMatches.length ? lineMatches[lIdx + 1].start : pageBody.length;
    const block = parseHocrLine(lineMatches[lIdx], nextLineStart, pageBody);
    if (block) lineBlocks.push(block);
  }

  return buildOcrPage(pageNumber, pWidth, pHeight, lineBlocks);
}

/**
 * Parses an hOCR 1.2 XHTML document into a structured OcrResult.
 */
export function parseHocr(hocrContent: string): OcrResult {
  if (!hocrContent || typeof hocrContent !== 'string') {
    return {
      text: '',
      confidence: null,
      wordCount: 0,
      lines: [],
      lineBlocks: [],
      imageWidth: 612,
      imageHeight: 792,
      pages: [],
    };
  }

  const pages: OcrPageResult[] = [];
  const pageOpenRegex = /<div\b([^>]*\bclass=["'][^"']*ocr_page[^"']*["'][^>]*)>/gi;
  const pageMatches: { attrs: string; start: number; contentStart: number }[] = [];
  let m: RegExpExecArray | null;

  while ((m = pageOpenRegex.exec(hocrContent)) !== null) {
    pageMatches.push({
      attrs: m[1],
      start: m.index,
      contentStart: m.index + m[0].length,
    });
  }

  for (let pageIdx = 0; pageIdx < pageMatches.length; pageIdx++) {
    const cur = pageMatches[pageIdx];
    const nextStart = pageIdx + 1 < pageMatches.length ? pageMatches[pageIdx + 1].start : hocrContent.length;
    pages.push(parseHocrPage(cur, nextStart, hocrContent, pageIdx));
  }

  if (pages.length === 0) {
    const wordRegex = /<span\b[^>]*class=["'][^"']*ocrx_word[^"']*["'][^>]*>(.*?)<\/span>/gis;
    const words: string[] = [];
    let wm: RegExpExecArray | null;
    while ((wm = wordRegex.exec(hocrContent)) !== null) {
      const t = unescapeXml((wm[1] || '').replace(/<[^>]+>/g, '')).trim();
      if (t) words.push(t);
    }
    const cleanText =
      words.length > 0
        ? words.join(' ')
        : unescapeXml(hocrContent.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (cleanText) {
      return buildFallbackOcrResult(cleanText, words);
    }
  }

  return assembleParsedOcrResult(pages);
}

function parseAltoString(strAttrs: string, lx: number, ly: number, lh: number): OcrWord | null {
  const rawContent = unescapeXml(extractAttribute(strAttrs, 'CONTENT')).trim();
  if (!rawContent) return null;

  const shpos = extractAttribute(strAttrs, 'HPOS');
  const svpos = extractAttribute(strAttrs, 'VPOS');
  const swidth = extractAttribute(strAttrs, 'WIDTH');
  const sheight = extractAttribute(strAttrs, 'HEIGHT');
  const wcMatch = extractAttribute(strAttrs, 'WC');

  const sx = shpos ? Number.parseFloat(shpos) : lx;
  const sy = svpos ? Number.parseFloat(svpos) : ly;
  const sw = swidth ? Number.parseFloat(swidth) : 40;
  const sh = sheight ? Number.parseFloat(sheight) : lh;
  const wcVal = wcMatch ? Number.parseFloat(wcMatch) : 0.9;
  const confidence = wcVal > 1.0 ? wcVal : wcVal * 100;

  return {
    text: rawContent,
    confidence,
    bbox: {
      x: sx,
      y: sy,
      width: Math.max(1, sw),
      height: Math.max(1, sh),
    },
  };
}

function parseAltoLine(lineMatch: RegExpExecArray): OcrLineBlock | null {
  const lineAttrs = lineMatch[1] || '';
  const lineBody = lineMatch[2] || '';

  const lhpos = lineAttrs.match(/HPOS=["']?(\d+(?:\.\d+)?)["']?/i);
  const lvpos = lineAttrs.match(/VPOS=["']?(\d+(?:\.\d+)?)["']?/i);
  const lwidth = lineAttrs.match(/WIDTH=["']?(\d+(?:\.\d+)?)["']?/i);
  const lheight = lineAttrs.match(/HEIGHT=["']?(\d+(?:\.\d+)?)["']?/i);

  const lx = lhpos ? Number.parseFloat(lhpos[1]) : 40;
  const ly = lvpos ? Number.parseFloat(lvpos[1]) : 40;
  const lw = lwidth ? Number.parseFloat(lwidth[1]) : 200;
  const lh = lheight ? Number.parseFloat(lheight[1]) : 20;

  const words: OcrWord[] = [];
  const stringRegex = /<String\b([^>]*)\/?>/gis;
  let strMatch: RegExpExecArray | null;

  while ((strMatch = stringRegex.exec(lineBody)) !== null) {
    const word = parseAltoString(strMatch[1] || '', lx, ly, lh);
    if (word) words.push(word);
  }

  const lineText = words.map((w) => w.text).join(' ');
  if (!lineText && words.length === 0) return null;

  return {
    text: lineText,
    bbox: {
      x: lx,
      y: ly,
      width: Math.max(1, lw),
      height: Math.max(1, lh),
    },
    words,
  };
}

function parseAltoPage(pageMatch: RegExpExecArray, pageIdx: number): OcrPageResult {
  const pageAttrs = pageMatch[1] || '';
  const pageBody = pageMatch[2] || '';

  const widthMatch = pageAttrs.match(/WIDTH=["']?(\d+(?:\.\d+)?)["']?/i);
  const heightMatch = pageAttrs.match(/HEIGHT=["']?(\d+(?:\.\d+)?)["']?/i);
  const nrMatch = pageAttrs.match(/PHYSICAL_IMG_NR=["']?(\d+)["']?/i);

  const pWidth = widthMatch ? Math.round(Number.parseFloat(widthMatch[1])) : 612;
  const pHeight = heightMatch ? Math.round(Number.parseFloat(heightMatch[1])) : 792;
  const pageNumber = nrMatch ? Number.parseInt(nrMatch[1], 10) : pageIdx;

  const lineBlocks: OcrLineBlock[] = [];
  const lineRegex = /<TextLine\b([^>]*)>(.*?)<\/TextLine>/gis;
  let lineMatch: RegExpExecArray | null;

  while ((lineMatch = lineRegex.exec(pageBody)) !== null) {
    const block = parseAltoLine(lineMatch);
    if (block) lineBlocks.push(block);
  }

  return buildOcrPage(pageNumber, pWidth, pHeight, lineBlocks);
}

/**
 * Parses an ALTO 4.x XML (Library of Congress) document into a structured OcrResult.
 */
export function parseAlto(altoXml: string): OcrResult {
  if (!altoXml || typeof altoXml !== 'string') {
    return {
      text: '',
      confidence: null,
      wordCount: 0,
      lines: [],
      lineBlocks: [],
      imageWidth: 612,
      imageHeight: 792,
      pages: [],
    };
  }

  const pages: OcrPageResult[] = [];
  const pageRegex = /<Page\b([^>]*)>(.*?)<\/Page>/gis;
  let pageMatch: RegExpExecArray | null;
  let pageIdx = 0;

  while ((pageMatch = pageRegex.exec(altoXml)) !== null) {
    pageIdx++;
    pages.push(parseAltoPage(pageMatch, pageIdx));
  }

  if (pages.length === 0) {
    const stringRegex = /<String\b[^>]*CONTENT=["']([^"']*)["'][^>]*\/?>/gis;
    const words: string[] = [];
    let sm: RegExpExecArray | null;
    while ((sm = stringRegex.exec(altoXml)) !== null) {
      const t = unescapeXml(sm[1]).trim();
      if (t) words.push(t);
    }
    const cleanText = words.join(' ');
    if (cleanText) {
      return buildFallbackOcrResult(cleanText, words);
    }
  }

  return assembleParsedOcrResult(pages);
}

