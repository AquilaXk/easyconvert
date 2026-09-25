import PDFDocument from 'pdfkit';
import { ConversionOptions, ConversionResult } from '../types';

export async function convertDocument(
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions = {},
  originalFilename: string
): Promise<ConversionResult> {
  const baseName = originalFilename.replace(/\.[^/.]+$/, '');
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();

  const textContent = inputBuffer.toString('utf-8');

  // Convert to PDF
  if (tgt === 'pdf') {
    return generatePdfFromText(textContent, src, options, baseName);
  }

  // Markdown -> HTML
  if (src === 'md' && tgt === 'html') {
    const html = markdownToHtml(textContent, baseName);
    const buffer = Buffer.from(html, 'utf-8');
    return {
      buffer,
      mimeType: 'text/html',
      filename: `${baseName}.html`,
      size: buffer.length,
    };
  }

  // HTML -> Markdown
  if (src === 'html' && tgt === 'md') {
    const md = htmlToMarkdown(textContent);
    const buffer = Buffer.from(md, 'utf-8');
    return {
      buffer,
      mimeType: 'text/markdown',
      filename: `${baseName}.md`,
      size: buffer.length,
    };
  }

  // HTML -> Plain text
  if (src === 'html' && tgt === 'txt') {
    const text = stripHtmlTags(textContent);
    const buffer = Buffer.from(text, 'utf-8');
    return {
      buffer,
      mimeType: 'text/plain',
      filename: `${baseName}.txt`,
      size: buffer.length,
    };
  }

  // Markdown -> Plain text
  if (src === 'md' && tgt === 'txt') {
    const text = stripMarkdownSyntax(textContent);
    const buffer = Buffer.from(text, 'utf-8');
    return {
      buffer,
      mimeType: 'text/plain',
      filename: `${baseName}.txt`,
      size: buffer.length,
    };
  }

  // Plain text -> HTML
  if (src === 'txt' && tgt === 'html') {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(
      baseName
    )}</title><style>body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; padding: 2rem; max-width: 800px; margin: 0 auto; }</style></head><body><pre>${escapeHtml(
      textContent
    )}</pre></body></html>`;
    const buffer = Buffer.from(html, 'utf-8');
    return {
      buffer,
      mimeType: 'text/html',
      filename: `${baseName}.html`,
      size: buffer.length,
    };
  }

  // Plain text -> Markdown
  if (src === 'txt' && tgt === 'md') {
    const buffer = Buffer.from(textContent, 'utf-8');
    return {
      buffer,
      mimeType: 'text/markdown',
      filename: `${baseName}.md`,
      size: buffer.length,
    };
  }

  throw new Error(`Unsupported document conversion from ${sourceFormat} to ${targetFormat}`);
}

function markdownToHtml(md: string, title: string): string {
  // Simple deterministic markdown parser for headers, lists, code, emphasis
  let html = md
    // Escaping
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Headers
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    // Bold & italic
    .replace(/\*\*\*(.*?)\*\*\*/gim, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/gim, '<em>$1</em>')
    // Inline code
    .replace(/`([^`]+)`/gim, '<code>$1</code>')
    // Line breaks / paragraphs
    .replace(/\n\n+/g, '</p><p>')
    .replace(/\n/g, '<br/>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; max-width: 800px; margin: 2rem auto; padding: 0 1rem; color: #1F2340; }
    h1, h2, h3 { color: #5C6BC0; }
    code { background: #F0F2FE; padding: 0.2rem 0.4rem; border-radius: 4px; font-family: monospace; font-size: 0.9em; }
    pre { background: #F8F9FF; border: 1px solid #CCD2FC; padding: 1rem; border-radius: 6px; overflow-x: auto; }
  </style>
</head>
<body>
  <p>${html}</p>
</body>
</html>`;
}

function htmlToMarkdown(html: string): string {
  let md = html
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n')
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n')
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n')
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
    .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
    .replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*')
    .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .trim();

  return md;
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function stripMarkdownSyntax(md: string): string {
  return md
    .replace(/^#+\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .trim();
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function generatePdfFromText(
  text: string,
  sourceType: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const content = sourceType === 'html' ? stripHtmlTags(text) : sourceType === 'md' ? stripMarkdownSyntax(text) : text;

  return new Promise((resolve, reject) => {
    const isLandscape = options.orientation === 'landscape';
    const doc = new PDFDocument({
      size: 'A4',
      layout: isLandscape ? 'landscape' : 'portrait',
      margin: 50,
      info: {
        Title: baseName,
        Creator: 'EasyConvert Platform',
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => {
      const buffer = Buffer.concat(chunks);
      resolve({
        buffer,
        mimeType: 'application/pdf',
        filename: `${baseName}.pdf`,
        size: buffer.length,
      });
    });
    doc.on('error', (err) => reject(err));

    // Lavender-themed header bar
    doc.rect(50, 40, doc.page.width - 100, 3).fill('#5C6BC0');
    doc.moveDown(1.5);

    // Document Title
    doc.fillColor('#1F2340').fontSize(18).text(baseName, { underline: false });
    doc.moveDown(0.5);

    // Document Body
    doc.fillColor('#4D536B').fontSize(11).lineGap(4).text(content);

    // Footer
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.fillColor('#697089').fontSize(9).text(
        `Generated with EasyConvert — Page ${i + 1} of ${range.count}`,
        50,
        doc.page.height - 40,
        { align: 'center', width: doc.page.width - 100 }
      );
    }

    doc.end();
  });
}
