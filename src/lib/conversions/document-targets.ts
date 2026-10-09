import type { ConversionOptions, ConversionResult } from '../types';
import { UnsupportedTargetError } from '../types';
import { documentToDocx } from './document-model/docx';
import { documentToEpub } from './document-model/epub';
import { documentToHtml } from './document-model/html';
import { documentToMarkdown } from './document-model/markdown';
import type { DocumentModel } from './document-model/model';
import { documentToOdt } from './document-model/odt';
import { documentToPdf } from './document-model/pdf';
import { documentToText } from './document-model/text';

/**
 * The targets written straight from the document model by every reader that produces one (DOCX, EPUB, HWP, Markdown,
 * HTML): plain text, HTML, Markdown, PDF, EPUB, DOCX and ODT.
 */

export const MODEL_TARGETS: ReadonlySet<string> = new Set(['txt', 'html', 'md', 'pdf', 'epub', 'docx', 'odt']);

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export async function renderModelTarget(model: DocumentModel, tgt: string, options: ConversionOptions, baseName: string): Promise<ConversionResult> {
  switch (tgt) {
    case 'pdf': {
      const buffer = await documentToPdf(model, options, baseName);
      return { buffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: buffer.length };
    }
    case 'epub': {
      const buffer = await documentToEpub(model, { title: baseName, language: options.language });
      return { buffer, mimeType: 'application/epub+zip', filename: `${baseName}.epub`, size: buffer.length };
    }
    case 'docx': {
      const buffer = await documentToDocx(model, { title: baseName, language: options.language });
      return { buffer, mimeType: DOCX_MIME, filename: `${baseName}.docx`, size: buffer.length };
    }
    case 'odt': {
      const buffer = await documentToOdt(model, { title: baseName, language: options.language });
      return { buffer, mimeType: 'application/vnd.oasis.opendocument.text', filename: `${baseName}.odt`, size: buffer.length };
    }
    case 'txt': {
      const buffer = Buffer.from(documentToText(model), 'utf-8');
      return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
    }
    case 'html': {
      const buffer = Buffer.from(documentToHtml(model, baseName), 'utf-8');
      return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
    }
    case 'md': {
      const buffer = Buffer.from(`${documentToMarkdown(model)}\n`, 'utf-8');
      return { buffer, mimeType: 'text/markdown', filename: `${baseName}.md`, size: buffer.length };
    }
    default:
      throw new UnsupportedTargetError(`The document model is not written to '.${tgt}'.`);
  }
}
