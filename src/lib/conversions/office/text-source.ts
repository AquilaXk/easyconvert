import { outlookMessageText, readOutlookMessage } from './msg-reader';
import { assertReadableAsText } from './text-source-guard';

/** The text of a source that has no reader of its own and is not text: an Outlook message is read, any other binary container is refused. */
export function sourceBytesAsText(input: Buffer, format: string): string {
  if (format === 'msg') return outlookMessageText(readOutlookMessage(input));
  assertReadableAsText(input, format);
  return input.toString('utf-8');
}
