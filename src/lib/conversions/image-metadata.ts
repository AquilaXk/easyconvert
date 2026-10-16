import type { Metadata, Sharp } from 'sharp';

/**
 * The header of the input a pipeline reads, asked of the image library once per pipeline. The library parses the header again on every
 * call (0.05 ms for decoded pixels, 0.1 to 0.2 ms for a PNG) and a conversion asks the same pipeline for it up to six times, each ask
 * a hop through the library's thread pool. A pipeline's metadata describes its input, which no later operation on it changes.
 */
const headers = new WeakMap<Sharp, Promise<Metadata>>();

export function metadataOf(pipeline: Sharp): Promise<Metadata> {
  let header = headers.get(pipeline);
  if (header === undefined) {
    header = pipeline.metadata();
    headers.set(pipeline, header);
  }
  return header;
}

/** `pipeline`, whose input header the caller has read already as `header`: the library is not asked for it again. */
export function withHeader(pipeline: Sharp, header: Metadata | undefined): Sharp {
  if (header !== undefined) headers.set(pipeline, Promise.resolve(header));
  return pipeline;
}
