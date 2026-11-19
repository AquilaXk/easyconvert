import { detectTextInputEncoding, decodeTextInput } from '../text-input';
import { outlookMessageText, readOutlookMessage } from './msg-reader';
import { ConversionFailedError } from '../../types';
import { assertReadableAsText } from './text-source-guard';

/** The sources that are text with no reader of their own: a byte order mark that names UTF-16 is how they declare it. */
const BOM_DECLARED_TEXT_SOURCES: ReadonlySet<string> = new Set(['txt', 'text', 'md', 'log', 'rst', 'man']);
const UTF16_ENCODINGS: ReadonlySet<string> = new Set(['utf-16le', 'utf-16be']);

/**
 * The text of a source that has no reader of its own and is not read as HTML: an Outlook message is read, a text source that declares
 * UTF-16 is decoded as such, any other binary container is refused, and the rest is decoded as text to PDF is (`decodeTextInput`, policy
 * entry 72: UTF-8, else the detected legacy encoding with a warning). Whatever starts with the two bytes of a UTF-16 mark but is
 * not a text source stays binary.
 */
export function sourceBytesAsText(input: Buffer, format: string): string {
  if (format === 'msg') return outlookMessageText(readOutlookMessage(input));
  const declaresUtf16 = UTF16_ENCODINGS.has(detectTextInputEncoding(input));
  if (declaresUtf16 && BOM_DECLARED_TEXT_SOURCES.has(format)) {
    const text = decodeTextInput(input);
    assertNoNullCharacter(text, format);
    return text;
  }
  assertReadableAsText(input, format);
  // A mark of UTF-16 on a source that cannot declare it is no declaration: the bytes stay UTF-8 text and decode as before.
  return declaresUtf16 ? input.toString('utf-8') : decodeTextInput(input);
}

/** Text in UTF-16 has no U+0000; a binary file behind a FE FF mark decodes into them, as it has null bytes as UTF-8. */
function assertNoNullCharacter(text: string, format: string): void {
  if (text.includes('\u0000')) {
    throw new ConversionFailedError(`Binary null bytes detected in source format '.${format}': fail-closed against mojibake corruption.`);
  }
}

/**
 * The refusal of `sourceBytesAsText` for a text file that is not handed to the reader as a whole: the first bytes of a source that is
 * declared as text, read the way that function reads them (a UTF-16 mark decodes the head, any other head is checked for a binary
 * container and for null bytes). The head of a UTF-16 file may end inside a character, which the decoder here does not refuse.
 */
export function assertTextSourceHead(head: Buffer, format: string): void {
  const encoding = detectTextInputEncoding(head);
  if (BOM_DECLARED_TEXT_SOURCES.has(format) && UTF16_ENCODINGS.has(encoding)) {
    assertNoNullCharacter(new TextDecoder(encoding).decode(head), format);
    return;
  }
  assertReadableAsText(head, format);
}
