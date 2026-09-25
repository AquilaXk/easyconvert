import zlib from 'zlib';

/**
 * Extracts plain text from uncompressed or flate-compressed PDF streams
 */
export function extractTextFromPdf(pdfBuffer: Buffer): string {
  const binary = pdfBuffer.toString('binary');
  const streamRegex = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;
  let match: RegExpExecArray | null;
  const textPieces: string[] = [];

  while ((match = streamRegex.exec(binary)) !== null) {
    let content = '';
    const rawStream = Buffer.from(match[1], 'binary');
    try {
      content = zlib.inflateSync(rawStream).toString('utf-8');
    } catch {
      try {
        content = zlib.inflateRawSync(rawStream).toString('utf-8');
      } catch {
        content = match[1];
      }
    }

    const btRegex = /BT[\s\S]*?ET/g;
    let btMatch: RegExpExecArray | null;
    while ((btMatch = btRegex.exec(content)) !== null) {
      const block = btMatch[0];
      const tjRegex = /\[(.*?)\]\s*TJ/g;
      let tjMatch: RegExpExecArray | null;
      while ((tjMatch = tjRegex.exec(block)) !== null) {
        const inner = tjMatch[1];
        const itemRegex = /\((.*?)\)|<([0-9a-fA-F]+)>/g;
        let itemMatch: RegExpExecArray | null;
        let line = '';
        while ((itemMatch = itemRegex.exec(inner)) !== null) {
          if (itemMatch[1] !== undefined) {
            line += itemMatch[1].replace(/\\([()\\])/g, '$1');
          } else if (itemMatch[2] !== undefined) {
            const hex = itemMatch[2];
            let str = '';
            for (let i = 0; i < hex.length; i += 2) {
              str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
            }
            line += str;
          }
        }
        if (line.trim()) textPieces.push(line);
      }

      const singleTjRegex = /\((.*?)\)\s*Tj|<([0-9a-fA-F]+)>\s*Tj/g;
      let sMatch: RegExpExecArray | null;
      while ((sMatch = singleTjRegex.exec(block)) !== null) {
        if (sMatch[1] !== undefined) {
          textPieces.push(sMatch[1].replace(/\\([()\\])/g, '$1'));
        } else if (sMatch[2] !== undefined) {
          const hex = sMatch[2];
          let str = '';
          for (let i = 0; i < hex.length; i += 2) {
            str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
          }
          textPieces.push(str);
        }
      }
    }
  }

  return textPieces.join('\n').trim() || 'No extractable text found in PDF document.';
}

/**
 * Extracts embedded image streams from PDF for OCR processing
 */
export function extractEmbeddedImageFromPdf(pdfBuffer: Buffer): Buffer | null {
  const binary = pdfBuffer.toString('binary');
  const dctIndex = binary.indexOf('/Filter/DCTDecode');
  if (dctIndex !== -1) {
    const streamStart = binary.indexOf('stream', dctIndex);
    if (streamStart !== -1) {
      const start =
        streamStart +
        (binary[streamStart + 6] === '\r' && binary[streamStart + 7] === '\n'
          ? 8
          : binary[streamStart + 6] === '\n'
          ? 7
          : 6);
      const end = binary.indexOf('endstream', start);
      if (end !== -1 && end > start) {
        return Buffer.from(binary.substring(start, end), 'binary');
      }
    }
  }
  return null;
}
