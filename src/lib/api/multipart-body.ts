import type { NextRequest } from 'next/server';
import { RequestAbortedError } from '../types';

/** Whether a request declares a `multipart/form-data` body. */
export const isMultipartBody = (req: NextRequest): boolean => (req.headers.get('content-type') ?? '').toLowerCase().includes('multipart/form-data');

/** A multipart body read whole: its form, or the parser's error for a body that is not well-formed multipart. */
export type MultipartRead = { form: FormData; malformed?: undefined } | { malformed: TypeError; form?: undefined };

/**
 * Reads the multipart body of `req`. A body the parser rejects (the Fetch API throws a `TypeError`) is `malformed`. A client that
 * went away while the body was read throws `RequestAbortedError`, whatever the stream reported. Any other error is thrown as it is.
 */
export async function readMultipartForm(req: NextRequest): Promise<MultipartRead> {
  try {
    return { form: await req.formData() };
  } catch (error: unknown) {
    if (req.signal.aborted) throw new RequestAbortedError({ cause: error });
    if (error instanceof TypeError) return { malformed: error };
    throw error;
  }
}

/** The text of the form field `name`; undefined when the field is missing or holds a file. */
export function formText(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === 'string' ? value : undefined;
}

/**
 * The first of the text fields `names` that the form holds as a file part. `formText` reads such a field as missing, which is
 * right for a required field but would drop an option or a webhook the caller sent, and convert without it.
 */
export function fileSentAsText(form: FormData, names: readonly string[]): string | undefined {
  return names.find((name) => {
    const value = form.get(name);
    return value !== null && typeof value !== 'string';
  });
}
