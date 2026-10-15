import type { ConversionOptions } from '../src/lib/types';
import { importProduct } from './product';

type DispatchModule = typeof import('../src/lib/conversions/dispatch');
type ConversionsModule = typeof import('../src/lib/conversions');

/**
 * The product modules are loaded once per process: a dynamic import resolves through the module loader hooks on every
 * call (0.2 to 0.5 ms under tsx), which is time of the benchmark and not of the conversion, and which the reference
 * tool never pays.
 */
let dispatchModule: Promise<DispatchModule> | undefined;
let conversionsModule: Promise<ConversionsModule> | undefined;

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
  dispatchModule ??= importProduct<DispatchModule>('lib/conversions/dispatch');
  const { dispatchConversion } = await dispatchModule;
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
  conversionsModule ??= importProduct<ConversionsModule>('lib/conversions');
  const { convertFile } = await conversionsModule;
  return (await convertFile(input, sourceFormat, targetFormat, options, filename)).buffer;
}
