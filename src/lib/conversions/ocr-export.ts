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

/**
 * Normalizes an OcrResult or OcrResult[] into an array of page structures.
 */
function normalizePages(
  ocrInput: OcrResult | OcrResult[],
  defaultWidth = 612,
  defaultHeight = 792
): OcrPageResult[] {
  if (Array.isArray(ocrInput)) {
    return ocrInput.map((res, idx) => ({
      pageNumber: idx + 1,
      width: res.imageWidth || defaultWidth,
      height: res.imageHeight || defaultHeight,
      text: res.text || '',
      confidence: res.confidence,
      lineBlocks: res.lineBlocks && res.lineBlocks.length > 0 ? res.lineBlocks : synthesizeLineBlocks(res),
      lines: res.lines,
    }));
  }

  if (ocrInput.pages && ocrInput.pages.length > 0) {
    return ocrInput.pages.map((p, idx) => ({
      pageNumber: p.pageNumber || idx + 1,
      width: p.width || ocrInput.imageWidth || defaultWidth,
      height: p.height || ocrInput.imageHeight || defaultHeight,
      text: p.text || '',
      confidence: p.confidence ?? ocrInput.confidence,
      lineBlocks: p.lineBlocks && p.lineBlocks.length > 0 ? p.lineBlocks : synthesizeLineBlocks(p),
      lines: p.lines,
    }));
  }

  return [
    {
      pageNumber: 1,
      width: ocrInput.imageWidth || defaultWidth,
      height: ocrInput.imageHeight || defaultHeight,
      text: ocrInput.text || '',
      confidence: ocrInput.confidence,
      lineBlocks: ocrInput.lineBlocks && ocrInput.lineBlocks.length > 0 ? ocrInput.lineBlocks : synthesizeLineBlocks(ocrInput),
      lines: ocrInput.lines,
    },
  ];
}

/**
 * Synthesizes line blocks and words if only plain lines/text exist.
 */
function synthesizeLineBlocks(res: { text?: string; lines?: string[]; imageWidth?: number; imageHeight?: number; confidence?: number | null }): OcrLineBlock[] {
  const lines = res.lines && res.lines.length > 0 ? res.lines : (res.text || '').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const pageWidth = res.imageWidth || 612;
  const pageHeight = res.imageHeight || 792;
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
    const imageName = options.filename ? `${options.filename}_page_${pNum}.png` : `page_${pNum}.png`;

    lines.push(
      `  <div class="ocr_page" id="page_${pNum}" title="image &apos;${escapeXml(imageName)}&apos;; bbox 0 0 ${pWidth} ${pHeight}; ppageno ${pNum}">`
    );

    const blocks = page.lineBlocks || [];
    if (blocks.length > 0) {
      blocks.forEach((block, bIdx) => {
        const b = block.bbox;
        const bx0 = Math.round(b.x);
        const by0 = Math.round(b.y);
        const bx1 = Math.round(b.x + b.width);
        const by1 = Math.round(b.y + b.height);

        lines.push(
          `    <div class="ocr_carea" id="block_${pNum}_${bIdx + 1}" title="bbox ${bx0} ${by0} ${bx1} ${by1}">`
        );
        lines.push(
          `      <p class="ocr_par" id="par_${pNum}_${bIdx + 1}" title="bbox ${bx0} ${by0} ${bx1} ${by1}">`
        );

        lines.push(
          `        <span class="ocr_line" id="line_${pNum}_${bIdx + 1}" title="bbox ${bx0} ${by0} ${bx1} ${by1}; baseline 0 0">`
        );

        const words = ensureWordsForBlock(block, page.confidence);
        for (let wIdx = 0; wIdx < words.length; wIdx++) {
          const w = words[wIdx];
          const wx0 = Math.round(w.bbox.x);
          const wy0 = Math.round(w.bbox.y);
          const wx1 = Math.round(w.bbox.x + w.bbox.width);
          const wy1 = Math.round(w.bbox.y + w.bbox.height);

          let wconf = 90;
          if (w.confidence !== undefined && w.confidence !== null && !isNaN(w.confidence)) {
            wconf = Math.round(w.confidence > 1 ? w.confidence : w.confidence * 100);
          } else if (page.confidence !== null && page.confidence !== undefined && !isNaN(page.confidence)) {
            wconf = Math.round(page.confidence > 1 ? page.confidence : page.confidence * 100);
          }
          wconf = Math.max(0, Math.min(100, wconf));

          lines.push(
            `          <span class="ocrx_word" id="word_${pNum}_${bIdx + 1}_${wIdx + 1}" title="bbox ${wx0} ${wy0} ${wx1} ${wy1}; x_wconf ${wconf}">${escapeXml(w.text)}</span>`
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
      const b = block.bbox;
      const bx = Math.round(b.x);
      const by = Math.round(b.y);
      const bw = Math.max(1, Math.round(b.width));
      const bh = Math.max(1, Math.round(b.height));

      lines.push(
        `        <TextBlock ID="TB_${pNum}_${bIdx + 1}" HPOS="${bx}" VPOS="${by}" WIDTH="${bw}" HEIGHT="${bh}">`
      );
      lines.push(
        `          <TextLine ID="TL_${pNum}_${bIdx + 1}" HPOS="${bx}" VPOS="${by}" WIDTH="${bw}" HEIGHT="${bh}">`
      );

      const words = ensureWordsForBlock(block, page.confidence);
      for (let wIdx = 0; wIdx < words.length; wIdx++) {
        const w = words[wIdx];
        const wx = Math.round(w.bbox.x);
        const wy = Math.round(w.bbox.y);
        const ww = Math.max(1, Math.round(w.bbox.width));
        const wh = Math.max(1, Math.round(w.bbox.height));

        let wc = 0.9;
        if (w.confidence !== undefined && w.confidence !== null && !isNaN(w.confidence)) {
          wc = w.confidence > 1 ? w.confidence / 100 : w.confidence;
        } else if (page.confidence !== null && page.confidence !== undefined && !isNaN(page.confidence)) {
          wc = page.confidence > 1 ? page.confidence / 100 : page.confidence;
        }
        wc = Math.max(0, Math.min(1.0, wc));

        lines.push(
          `            <String CONTENT="${escapeXml(w.text)}" HPOS="${wx}" VPOS="${wy}" WIDTH="${ww}" HEIGHT="${wh}" WC="${wc.toFixed(2)}" />`
        );

        // Add standard <SP> whitespace delimiter between consecutive words in a line
        if (wIdx < words.length - 1) {
          const nextW = words[wIdx + 1];
          const spX = wx + ww;
          const spW = Math.max(1, Math.round(nextW.bbox.x - spX));
          lines.push(
            `            <SP HPOS="${spX}" VPOS="${wy}" WIDTH="${spW}" />`
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
