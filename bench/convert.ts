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
