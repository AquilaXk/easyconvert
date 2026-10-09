import type { ConversionOptions } from '../src/lib/types';

/**
 * Our side of every comparison goes through the project's single public conversion dispatcher, the entry point
 * every API route, batch job and queue worker uses: it picks the in-process engine or the native worker engine
 * exactly as production does. It is imported lazily so a run that skips every row never loads the engines.
 */
export interface ConvertedOutput {
  buffer: Buffer;
  engineUsed: string;
}

export async function convertWithProject(
  input: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions,
  filename: string
): Promise<ConvertedOutput> {
  const { dispatchConversion } = await import('../src/lib/conversions/dispatch');
  const result = await dispatchConversion(input, sourceFormat, targetFormat, options, filename);
  return { buffer: result.buffer, engineUsed: result.engineUsed };
}

/**
 * Our in-process engine called directly. The dispatcher prefers the native office engine when it is installed, which
 * would make a document comparison measure the reference tool against itself; the document family measures what
 * this project's own readers and writers produce, so it calls the in-process entry point.
 */
export async function convertInProcess(
  input: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions,
  filename: string
): Promise<Buffer> {
  const { convertFile } = await import('../src/lib/conversions');
  return (await convertFile(input, sourceFormat, targetFormat, options, filename)).buffer;
}
