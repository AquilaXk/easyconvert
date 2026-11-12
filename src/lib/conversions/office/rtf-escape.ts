

/**
 * Escapes plain text for inclusion in RTF documents.
 * Escapes special RTF characters (\, {, }), newlines (\par), tabs (\tab),
 * and encodes non-ASCII characters using signed 16-bit \uN? notation.
 */
export function escapeRtf(text: string): string {
  if (!text) return '';
  return text.replace(/[\\{}]|\t|\r\n|[\r\n]|[^\x20-\x7E]/g, (ch) => {
    if (ch === '\\') return '\\\\';
    if (ch === '{') return '\\{';
    if (ch === '}') return '\\}';
    if (ch === '\r\n' || ch === '\n' || ch === '\r') return '\\par\n';
    if (ch === '\t') return '\\tab ';
    const code = ch.charCodeAt(0);
    if (code > 127) {
      const signed = code > 32767 ? code - 65536 : code;
      return `\\u${signed}?`;
    }
    return ch;
  });
}
