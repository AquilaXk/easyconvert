import type { ResizeOptions, Sharp } from 'sharp';
import type { ConversionOptions } from '../types';
import { staysGrey } from './image-background';
import { greenRasterOf, isNoiseDominated, type ContentClass, type Raster } from './image-content';
import { jpegOptionsFor, jpegTableDependsOnNoise } from './image-encoder-defaults';

/** What `jpegPipelineOf` needs to know about the conversion besides the pipeline. */
export interface JpegRequest {
  options: ConversionOptions;
  content: ContentClass;
  /** Colourspace of the input and the background colour: they decide whether the picture stays one-component. */
  inputSpace: string | undefined;
  background: Parameters<typeof staysGrey>[1];
  /** The decode-once route's samples of the source, when it decoded one. */
  decoded: { raster: Raster } | null;
  /** The format of the source: only a PNG is read for noise. */
  source: string;
  /** The resize the request asks for, or a falsy value: a resize averages the noise away, so a resized picture is not read. */
  resize: ResizeOptions | null | undefined;
}

/**
 * Whether the noise of the picture is read for the JPEG table (entry 266): a photograph below the full-chroma quality, from a PNG, that the
 * encoder writes at its own size. The samples are those the decode-once route holds, or else one more decode of the PNG's green band.
 */
async function isNoisySource(pipeline: Sharp, request: JpegRequest): Promise<boolean> {
  const { options, content, decoded, source, resize } = request;
  if (resize || (!decoded && source !== 'png') || !jpegTableDependsOnNoise(options.quality, content)) return false;
  return isNoiseDominated(decoded?.raster ?? (await greenRasterOf(pipeline)));
}

/** The pipeline with the JPEG encoder set up for the picture: one component for a grey source, the options of its content and noise. */
export async function jpegPipelineOf(pipeline: Sharp, request: JpegRequest): Promise<Sharp> {
  const grey = staysGrey(request.inputSpace, request.background);
  const noisy = await isNoisySource(pipeline, request);
  return (grey ? pipeline.toColourspace('b-w') : pipeline).jpeg(jpegOptionsFor(request.options.quality, request.content, grey, noisy));
}
