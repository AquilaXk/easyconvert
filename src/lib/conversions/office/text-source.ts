import { detectTextInputEncoding, decodeTextInput } from '../text-input';
import { outlookMessageText, readOutlookMessage } from './msg-reader';
import { ConversionFailedError } from '../../types';
import { assertReadableAsText } from './text-source-guard';

/** The sources that are text with no reader of their own: a byte order mark that names UTF-16 is how they declare it. */
const BOM_DECLARED_TEXT_SOURCES: ReadonlySet<string> = new Set(['txt', 'text', 'md', 'log', 'rst', 'man']);
const UTF16_ENCODINGS: ReadonlySet<string> = new Set(['utf-16le', 'utf-16be']);

/**
 * The text of a source that has no reader of its own and is not read as HTML: an Outlook message is read, a text source that declares
 * UTF-16 is decoded as such, and any other binary container is refused. Whatever starts with the two bytes of a UTF-16 mark but is
 * not a text source stays binary.
 */
export function sourceBytesAsText(input: Buffer, format: string): string {
  if (format === 'msg') return outlookMessageText(readOutlookMessage(input));
  if (BOM_DECLARED_TEXT_SOURCES.has(format) && UTF16_ENCODINGS.has(detectTextInputEncoding(input))) {
    const text = decodeTextInput(input);
    // Text in UTF-16 has no U+0000; a binary file behind a FE FF mark decodes into them, as it has null bytes as UTF-8.
    if (text.includes('\u0000')) {
      throw new ConversionFailedError(`Binary null bytes detected in source format '.${format}': fail-closed against mojibake corruption.`);
    }
    return text;
  }
  assertReadableAsText(input, format);
  return input.toString('utf-8');
}
