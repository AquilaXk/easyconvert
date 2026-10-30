import { DROPPED_STREAM_KINDS, DROPPED_STREAM_REASONS, MAX_DROPPED_STREAMS, MAX_DROPPED_TEXT_CHARS } from '../dropped-streams';
import { MAX_CONVERSION_WARNING_CHARS, MAX_CONVERSION_WARNINGS } from '../conversion-warnings';
import { MAX_FALLBACK_REASON_CHARS } from '../engine-trace';

/** Which engine ran and, only after a fallback, why; shared by every response that reports a conversion. */
export const EngineTraceProperties = {
  engineUsed: {
    type: 'string',
    description: 'Engine that produced the output, for example `native-ffmpeg`, `native-soffice` or `internal-fallback`.',
  },
  fallbackReason: {
    type: 'string',
    maxLength: MAX_FALLBACK_REASON_CHARS,
    description:
      'Why a first-choice engine did not produce the output. Present only when a fallback happened; redacted, one line, without file paths.',
  },
} as const;

/** What a document conversion left out, such as the images of an HTML page that are not embedded; absent when nothing was. */
export const ConversionWarningsProperties = {
  warnings: {
    type: 'array',
    maxItems: MAX_CONVERSION_WARNINGS,
    description:
      'What the conversion left out of the document, one line each, for example an HTML image that could not be loaded: it is omitted unless the request sets `requireResources`. The conversion succeeded. Present only when something was left out.',
    items: { type: 'string', maxLength: MAX_CONVERSION_WARNING_CHARS },
  },
} as const;

/** Input streams a media conversion left out because the target container cannot carry them; absent when none. */
export const DroppedStreamsProperties = {
  droppedStreams: {
    type: 'array',
    maxItems: MAX_DROPPED_STREAMS,
    description:
      'Streams of the input that the output does not contain, for example the subtitle tracks of an mkv converted to avi. The conversion succeeded; this lists what it could not carry. Present only when something was left out. Audio tracks `audio.track` did not choose and subtitles burned into the picture are not listed. An audio stream with no decodable packet is listed only when the file has a picture to convert; a conversion to an audio target is refused instead.',
    items: {
      type: 'object',
      required: ['kind', 'reason'],
      additionalProperties: false,
      properties: {
        index: {
          type: 'integer',
          minimum: 0,
          description: 'Stream index in the input; absent for the chapter list.',
        },
        kind: { type: 'string', enum: [...DROPPED_STREAM_KINDS] },
        codec: { type: 'string', maxLength: MAX_DROPPED_TEXT_CHARS, description: 'Codec name of the stream, when known.' },
        language: { type: 'string', maxLength: MAX_DROPPED_TEXT_CHARS, description: 'Language tag of the stream, when it has one.' },
        title: { type: 'string', maxLength: MAX_DROPPED_TEXT_CHARS, description: 'Title of the stream, when it has one.' },
        reason: {
          type: 'string',
          enum: [...DROPPED_STREAM_REASONS],
          description:
            '`container_unsupported`: the target container cannot carry this stream. `stream_type_unsupported`: no video-container output carries this kind of stream (data, cover art). `additional_video_track`: only the first video track is kept. `undecodable`: no packet of this audio stream can be decoded, so the video was converted without it.',
        },
      },
    },
  },
} as const;

/** Whether the converted file can still be downloaded; the job API reports it next to the result. */
export const ResultRetentionSchema = {
  type: 'object',
  description:
    'Whether the converted file can still be downloaded. A result is deleted shortly after its first complete download, or when nobody downloaded it in time; its download then answers 410. Present for a completed job that stored a result.',
  required: ['state'],
  properties: {
    state: { type: 'string', enum: ['available', 'deleted'] },
    deleteAt: { type: 'number', description: 'Epoch milliseconds after which an available result is deleted.' },
    deliveredAt: { type: 'number', description: 'Epoch milliseconds of the first complete download, when there was one.' },
    reason: { type: 'string', enum: ['delivered', 'expired'], description: 'Why a deleted result is gone: it was downloaded, or nobody downloaded it in time.' },
  },
} as const;
