import type { ConversionOptions, ConversionResult } from '../types';
import { UnsupportedTargetError } from '../types';
import { renderModelHtml } from './document-html';
import { renderModelMarkdown, renderModelText } from './document-markdown';
import type { DocModel } from './document-model';
import { renderModelPdf } from './docx-pdf';
import { writeDocx } from './docx-writer';
import { writeEpub } from './epub-writer';
import { writeOdt } from './odt-writer';

/**
 * The targets written straight from the block model by every reader that produces one (DOCX, EPUB, HWP, Markdown,
 * HTML): plain text, HTML, Markdown, PDF, EPUB, DOCX and ODT.
 */

export const MODEL_TARGETS: ReadonlySet<string> = new Set(['txt', 'html', 'md', 'pdf', 'epub', 'docx', 'odt']);

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export async function renderModelTarget(model: DocModel, tgt: string, options: ConversionOptions, baseName: string): Promise<ConversionResult> {
  switch (tgt) {
    case 'pdf': {
      const buffer = await renderModelPdf(model, options, baseName);
      return { buffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: buffer.length };
    }
    case 'epub': {
      const buffer = await writeEpub(model, { title: baseName, language: options.language });
      return { buffer, mimeType: 'application/epub+zip', filename: `${baseName}.epub`, size: buffer.length };
    }
    case 'docx': {
      const buffer = await writeDocx(model, { title: baseName, language: options.language });
      return { buffer, mimeType: DOCX_MIME, filename: `${baseName}.docx`, size: buffer.length };
    }
    case 'odt': {
      const buffer = await writeOdt(model, { title: baseName, language: options.language });
      return { buffer, mimeType: 'application/vnd.oasis.opendocument.text', filename: `${baseName}.odt`, size: buffer.length };
    }
    case 'txt': {
      const buffer = Buffer.from(renderModelText(model), 'utf-8');
      return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
    }
    case 'html': {
      const buffer = Buffer.from(renderModelHtml(model, baseName), 'utf-8');
      return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
    }
    case 'md': {
      const buffer = Buffer.from(renderModelMarkdown(model), 'utf-8');
      return { buffer, mimeType: 'text/markdown', filename: `${baseName}.md`, size: buffer.length };
    }
    default:
      throw new UnsupportedTargetError(`The document model is not written to '.${tgt}'.`);
  }
}
