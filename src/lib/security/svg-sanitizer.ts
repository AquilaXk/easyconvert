/**
 * SVG Security Sanitizer & Stored XSS Defense Engine
 *
 * Implements strict sanitization against SVG-based Stored XSS, XXE, and script injection vectors:
 * - Strips DOCTYPE declarations and external entity definitions.
 * - Strips <script>, <foreignObject>, <iframe>, <object>, <embed> tags (both self-closing and block).
 * - Strips inline event handlers (onload, onclick, onerror, on*).
 * - Sanitizes dangerous URI schemes (javascript:, vbscript:, data:text/html) in href/xlink:href/src attributes.
 * - Preserves authentic vector geometry (path, rect, circle, g, svg, text, defs, use, etc.).
 */

/**
 * Decodes standard and numerical HTML entities (hex and decimal).
 */
export function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

/**
 * Checks whether the given buffer or text represents an SVG document.
 */
export function isSvg(input: string | Buffer): boolean {
  if (!input) return false;
  const str = typeof input === 'string' ? input : input.toString('utf-8');

  // Guard against binary files
  if (typeof input !== 'string') {
    if (input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) return false; // JPG
    if (input.length >= 8 && input[0] === 0x89 && input[1] === 0x50 && input[2] === 0x4e && input[3] === 0x47) return false; // PNG
    if (input.length >= 4 && input[0] === 0x47 && input[1] === 0x49 && input[2] === 0x46 && input[3] === 0x38) return false; // GIF
  }

  const trimmed = str.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return false; // JSON
  if (trimmed.startsWith('GIF87a') || trimmed.startsWith('GIF89a')) return false;

  // Strip XML declaration, comments, and doctypes (including internal subsets) to verify root element
  const stripped = trimmed
    .replace(/^<\?xml[^>]*\?>/i, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE\b[^>[]*(?:\[[\s\S]*?\]\s*)?>/gi, '')
    .trim();

  return /^<svg\b/i.test(stripped);
}

/**
 * Sanitizes an SVG string by stripping dangerous tags, attributes, and script execution vectors.
 */
export function sanitizeSvgString(svg: string): string {
  if (!svg || typeof svg !== 'string') return '';

  let result = svg;

  // 1. Strip DOCTYPE and ENTITY definitions (including multiline internal subsets)
  result = result.replace(/<!DOCTYPE\b[^>[]*(?:\[[\s\S]*?\]\s*)?>/gi, '');
  result = result.replace(/<!ENTITY\b[^>]*>/gi, '');

  // 2. Iteratively strip dangerous executable and embedding tags (both paired and unclosed/self-closing)
  // to defeat recursive tag injection attacks like <scr<script>ipt>
  let prev = '';
  while (prev !== result) {
    prev = result;

    result = result.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    result = result.replace(/<script\b[^>]*\/?>/gi, '');

    result = result.replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject>/gi, '');
    result = result.replace(/<foreignObject\b[^>]*\/?>/gi, '');

    result = result.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '');
    result = result.replace(/<iframe\b[^>]*\/?>/gi, '');

    result = result.replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '');
    result = result.replace(/<object\b[^>]*\/?>/gi, '');

    result = result.replace(/<embed\b[^>]*>[\s\S]*?<\/embed>/gi, '');
    result = result.replace(/<embed\b[^>]*\/?>/gi, '');

    result = result.replace(/<meta\b[^>]*\/?>/gi, '');
    result = result.replace(/<link\b[^>]*\/?>/gi, '');
  }

  // 3. Strip all inline on* event handler attributes
  result = result.replace(/\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // 4. Sanitize dangerous URI protocols (javascript:, vbscript:, data:text/html, data:image/svg+xml)
  result = result.replace(
    /(?:(?:xlink:)?href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (full, v1, v2, v3) => {
      const rawVal = v1 !== undefined ? v1 : (v2 !== undefined ? v2 : v3);
      const decoded = decodeHtmlEntities(rawVal).replace(/[\s\x00-\x1f]/g, '').toLowerCase();
      if (
        decoded.startsWith('javascript:') ||
        decoded.startsWith('vbscript:') ||
        decoded.startsWith('data:text/html') ||
        decoded.startsWith('data:image/svg+xml') ||
        decoded.startsWith('data:application/javascript')
      ) {
        return 'href="#"';
      }
      return full;
    }
  );

  // 5. Sanitize animation values and attributes (prevent SVG animation script vectors)
  result = result.replace(
    /\b(?:values|to|from)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (full, v1, v2, v3) => {
      const rawVal = v1 !== undefined ? v1 : (v2 !== undefined ? v2 : v3);
      const decoded = decodeHtmlEntities(rawVal).replace(/[\s\x00-\x1f]/g, '').toLowerCase();
      if (
        decoded.startsWith('javascript:') ||
        decoded.startsWith('vbscript:') ||
        decoded.startsWith('data:text/html') ||
        decoded.startsWith('data:image/svg+xml') ||
        decoded.startsWith('data:application/javascript')
      ) {
        return 'to="#"';
      }
      return full;
    }
  );

  return result.trim();
}

/**
 * Sanitizes an SVG buffer and returns a sanitized Buffer.
 */
export function sanitizeSvgBuffer(buffer: Buffer): Buffer {
  const svgText = buffer.toString('utf-8');
  const cleanText = sanitizeSvgString(svgText);
  return Buffer.from(cleanText, 'utf-8');
}
