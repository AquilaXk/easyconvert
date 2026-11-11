import type { Sharp } from 'sharp';
import type { ContentClass } from './image-content';
import { jpegliPolicyFor, jpegOptionsFor } from './image-encoder-defaults';
import { findCjpegli, jpegliFits, startJpegli, withMetadataSegments } from './jpegli-cli';
import { withPipelineThreads } from './image-threads';

/**
 * The JPEG of a photograph written by `cjpegli` from the samples of an image-library pipeline, with the metadata segments the library's
 * own encoder writes for that pipeline. The pipeline is the one `jpegOptionsFor` would encode: orientation, resize, flattening, grey
 * conversion and the metadata kept or dropped are all attached already.
 *
 * - The program is started first and waits for its samples, so that the start of the sandbox (three processes deep) runs while the library
 *   decodes the picture; the samples come from the pipeline's raw output, 8 bits, one channel (grey) or three.
 * - The metadata comes from a JPEG of one pixel of the same pipeline (the library writes the EXIF block, the XMP packet and the profile
 *   exactly as for the picture); its application segments are spliced in front of the tables of the encoder's file. The library reads only
 *   the top left pixel of the pipeline for that file, so it costs no second pass over the picture.
 *
 * Returns null where the picture cannot be written this way (no program installed, a sample layout the program does not take, a picture
 * over its pixel bound); the caller then encodes with the library. A program that is installed and fails throws.
 */
export async function encodeJpegliFromPipeline(pipeline: Sharp, requestedQuality: number | undefined, grey: boolean, signal?: AbortSignal): Promise<Buffer | null> {
  const cjpegli = await findCjpegli();
  if (cjpegli === null) return null;
  const policy = jpegliPolicyFor(requestedQuality);
  // A quality that is not a whole number is the image library's to refuse, with its own message.
  if (!Number.isInteger(policy.quality)) return null;
  // The samples are asked for first: the library decodes on its own threads while this thread starts the program, whose fork blocks it for as long as the process is large.
  const samples = withPipelineThreads(() => pipeline.clone().raw().toBuffer({ resolveWithObject: true }));
  samples.catch(() => undefined);
  const run = startJpegli(cjpegli, { ...policy, grey, signal });
  try {
    const template = pipeline.clone().extract({ left: 0, top: 0, width: 1, height: 1 }).jpeg({ quality: 1 }).toBuffer();
    // Awaited below; a failure of the samples must not leave this promise rejected without a handler.
    template.catch(() => undefined);
    const { data, info } = await samples;
    if (info.channels !== (grey ? 1 : 3) || data.length !== info.width * info.height * info.channels || !jpegliFits(info.width, info.height)) {
      await run.cancel();
      return null;
    }
    run.send({ pixels: data, width: info.width, height: info.height, channels: info.channels });
    const [encoded, segments] = await Promise.all([run.result, template]);
    return withMetadataSegments(encoded, segments);
  } catch (err) {
    await run.cancel();
    throw err;
  }
}

/**
 * The JPEG of a prepared pipeline: a photograph goes to the jpegli program when it is installed and takes the picture (entry 231), and
 * everything else, a graphic included, to the image library with the options of `jpegOptionsFor`.
 */
export async function encodeJpegFromPipeline(pipeline: Sharp, requestedQuality: number | undefined, content: ContentClass, grey: boolean): Promise<Buffer> {
  const fromProgram = content === 'photo' ? await encodeJpegliFromPipeline(pipeline, requestedQuality, grey) : null;
  return fromProgram ?? withPipelineThreads(() => pipeline.jpeg(jpegOptionsFor(requestedQuality, content, grey)).toBuffer());
}
