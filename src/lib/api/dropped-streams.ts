import type { DroppedStream, DroppedStreamKind, DroppedStreamReason } from '../types';

/**
 * The input streams a media conversion left out, as an API surface carries them. The engines record the list
 * in the result metadata; what reaches a client is the bounded, validated form built here, so a value from a
 * worker or a stored job result is never trusted as it stands.
 */

export const DROPPED_STREAMS_HEADER = 'X-Dropped-Streams';

/** Most entries a response lists: one per input stream (at most 64 are mapped) plus the chapter list. */
export const MAX_DROPPED_STREAMS = 65;
/** Longest codec, language or title text of an entry, in characters. */
export const MAX_DROPPED_TEXT_CHARS = 100;

export const DROPPED_STREAM_KINDS: readonly DroppedStreamKind[] = [
  'video',
  'subtitle',
  'attachment',
  'data',
  'attached_picture',
  'chapters',
];
export const DROPPED_STREAM_REASONS: readonly DroppedStreamReason[] = [
  'container_unsupported',
  'stream_type_unsupported',
  'additional_video_track',
];

const KIND_SET: ReadonlySet<string> = new Set(DROPPED_STREAM_KINDS);
const REASON_SET: ReadonlySet<string> = new Set(DROPPED_STREAM_REASONS);
const CONTROL_CHARACTERS = /\p{Cc}/gu;

export interface DroppedStreamsSource {
  droppedStreams?: unknown;
  metadata?: Record<string, unknown>;
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = [...value.replaceAll(CONTROL_CHARACTERS, ' ').trim()].slice(0, MAX_DROPPED_TEXT_CHARS).join('');
  return text === '' ? undefined : text;
}

function toEntry(raw: unknown): DroppedStream | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { index, kind, codec, language, title, reason } = raw as Record<string, unknown>;
  if (typeof kind !== 'string' || !KIND_SET.has(kind)) return undefined;
  if (typeof reason !== 'string' || !REASON_SET.has(reason)) return undefined;
  const entry: DroppedStream = { kind: kind as DroppedStreamKind, reason: reason as DroppedStreamReason };
  if (typeof index === 'number' && Number.isInteger(index) && index >= 0) entry.index = index;
  const text = { codec: boundedText(codec), language: boundedText(language), title: boundedText(title) };
  if (text.codec) entry.codec = text.codec;
  if (text.language) entry.language = text.language;
  if (text.title) entry.title = text.title;
  return entry;
}

/** The valid entries of a recorded list, at most MAX_DROPPED_STREAMS; anything else in it is ignored. */
export function publicDroppedStreams(value: unknown): DroppedStream[] {
  if (!Array.isArray(value)) return [];
  const entries: DroppedStream[] = [];
  for (const raw of value.slice(0, MAX_DROPPED_STREAMS)) {
    const entry = toEntry(raw);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** JSON field listing the streams a conversion left out; empty when it left none out. */
export function droppedStreamsFields(result: DroppedStreamsSource): { droppedStreams?: DroppedStream[] } {
  const entries = publicDroppedStreams(result.droppedStreams ?? result.metadata?.droppedStreams);
  return entries.length > 0 ? { droppedStreams: entries } : {};
}

/**
 * Header form for a raw binary response: `kind[#index]:reason` entries separated by commas, for example
 * `subtitle#3:container_unsupported,chapters:container_unsupported`. Printable ASCII only.
 */
export function droppedStreamsHeaders(result: DroppedStreamsSource): Record<string, string> {
  const { droppedStreams } = droppedStreamsFields(result);
  if (!droppedStreams) return {};
  const value = droppedStreams
    .map((entry) => `${entry.kind}${entry.index === undefined ? '' : `#${entry.index}`}:${entry.reason}`)
    .join(',');
  return { [DROPPED_STREAMS_HEADER]: value };
}
