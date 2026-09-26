import zlib from 'zlib';

/**
 * Unescapes PDF literal strings (\n, \r, \t, octal codes, escaped parens)
 */
export function unescapePdfString(str: string): string {
  return str.replace(/\\([0-7]{1,3}|[nrtbf\\()])/g, (_match, p1) => {
    if (/^[0-7]+$/.test(p1)) {
      return String.fromCharCode(parseInt(p1, 8));
    }
    switch (p1) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      case '(': return '(';
      case ')': return ')';
      case '\\': return '\\';
      default: return p1;
    }
  });
}

/**
 * Decodes a PDF hexadecimal string (<FEFF...>, <...>)
 * Supports UTF-16BE BOM marker and CJK strings per PDF ISO 32000-1 Section 7.9.2.2.
 */
export function decodePdfHexString(hex: string): string {
  let cleanHex = hex.replace(/\s+/g, '');
  if (cleanHex.length % 2 !== 0) {
    cleanHex += '0'; // PDF spec: trailing odd hex digit is padded with '0'
  }
  const buf = Buffer.from(cleanHex, 'hex');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE with BOM: ensure even number of bytes to avoid ERR_INVALID_BUFFER_SIZE on swap16
    const payload = buf.subarray(2);
    const alignedLen = payload.length - (payload.length % 2);
    if (alignedLen === 0) return '';
    return Buffer.from(payload.subarray(0, alignedLen)).swap16().toString('utf16le');
  }
  // Check if it's valid UTF-8
  try {
    const utf8 = buf.toString('utf-8');
    if (!utf8.includes('\ufffd')) return utf8;
  } catch {}
  return buf.toString('latin1');
}

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
      content = zlib.inflateSync(rawStream).toString('latin1');
    } catch {
      try {
        content = zlib.inflateRawSync(rawStream).toString('latin1');
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
        const itemRegex = /\(((?:[^()\\]|\\.)*)\)|<([0-9a-fA-F\s]+)>/g;
        let itemMatch: RegExpExecArray | null;
        let line = '';
        while ((itemMatch = itemRegex.exec(inner)) !== null) {
          if (itemMatch[1] !== undefined) {
            line += unescapePdfString(itemMatch[1]);
          } else if (itemMatch[2] !== undefined) {
            line += decodePdfHexString(itemMatch[2]);
          }
        }
        if (line.trim()) textPieces.push(line);
      }

      const singleTjRegex = /\(((?:[^()\\]|\\.)*)\)\s*Tj|<([0-9a-fA-F\s]+)>\s*Tj/g;
      let sMatch: RegExpExecArray | null;
      while ((sMatch = singleTjRegex.exec(block)) !== null) {
        if (sMatch[1] !== undefined) {
          textPieces.push(unescapePdfString(sMatch[1]));
        } else if (sMatch[2] !== undefined) {
          textPieces.push(decodePdfHexString(sMatch[2]));
        }
      }

      // Check ' (single prime) operator: string '
      const primeRegex = /\(((?:[^()\\]|\\.)*)\)\s*'|<([0-9a-fA-F\s]+)>\s*'/g;
      let primeMatch: RegExpExecArray | null;
      while ((primeMatch = primeRegex.exec(block)) !== null) {
        if (primeMatch[1] !== undefined) {
          textPieces.push(unescapePdfString(primeMatch[1]));
        } else if (primeMatch[2] !== undefined) {
          textPieces.push(decodePdfHexString(primeMatch[2]));
        }
      }

      // Check " (double prime) operator: aw ac string "
      const dblPrimeRegex = /\(((?:[^()\\]|\\.)*)\)\s*"|<([0-9a-fA-F\s]+)>\s*"/g;
      let dblMatch: RegExpExecArray | null;
      while ((dblMatch = dblPrimeRegex.exec(block)) !== null) {
        if (dblMatch[1] !== undefined) {
          textPieces.push(unescapePdfString(dblMatch[1]));
        } else if (dblMatch[2] !== undefined) {
          textPieces.push(decodePdfHexString(dblMatch[2]));
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
