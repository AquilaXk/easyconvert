import { InvalidMediaOptionError } from '../types';

const VIDEO_CODECS: ReadonlySet<string> = new Set(['h264', 'hevc', 'vp9', 'av1', 'prores']);
/** Spellings accepted for a codec; h265 is the common name of hevc. */
const VIDEO_CODEC_ALIASES: Readonly<Record<string, string>> = { h265: 'hevc' };

export type VideoCodecName = 'h264' | 'hevc' | 'vp9' | 'av1' | 'prores';

/** Normalizes a requested video codec, rejecting any name this builder cannot encode. */
export function resolveVideoCodec(requested: string): VideoCodecName {
  const name = Object.hasOwn(VIDEO_CODEC_ALIASES, requested) ? VIDEO_CODEC_ALIASES[requested] : requested;
  if (!VIDEO_CODECS.has(name)) {
    throw new InvalidMediaOptionError(
      `Unsupported video codec '${requested}'. Allowed: ${[...VIDEO_CODECS].join(', ')} (h265 is accepted as hevc).`
    );
  }
  return name as VideoCodecName;
}
