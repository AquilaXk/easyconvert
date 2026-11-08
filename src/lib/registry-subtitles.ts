import type { FormatDefinition } from './types';

/**
 * The subtitle formats of the registry (docs/policy-decisions.md, entry 188): text cues that FFmpeg reads and writes in the
 * sandbox of the media path. They are a category of their own, as the reference converters group them by the media they time
 * (docs/policy-decisions.md, entry 196). SubStation Alpha is read, not written (FFmpeg writes ASS), and MicroDVD
 * (frames, no frame rate in the file) is read only.
 */
export const SUBTITLE_DEFINITIONS: Record<string, FormatDefinition> = {
  srt: {
    id: 'srt',
    name: 'SubRip Subtitles',
    extension: 'srt',
    mimeType: 'application/x-subrip',
    category: 'subtitle',
    description: 'SubRip text subtitles: numbered cues with start and end times and plain text.',
    targetFormats: ['vtt', 'ass'],
  },
  vtt: {
    id: 'vtt',
    name: 'WebVTT Subtitles',
    extension: 'vtt',
    mimeType: 'text/vtt',
    category: 'subtitle',
    description: 'Web Video Text Tracks, the W3C subtitle format of HTML5 video.',
    targetFormats: ['srt', 'ass'],
  },
  ass: {
    id: 'ass',
    name: 'Advanced SubStation Alpha Subtitles',
    extension: 'ass',
    mimeType: 'text/x-ssa',
    category: 'subtitle',
    description: 'Advanced SubStation Alpha subtitles with styles and positioned, timed text.',
    targetFormats: ['srt', 'vtt'],
  },
  ssa: {
    id: 'ssa',
    name: 'SubStation Alpha Subtitles',
    extension: 'ssa',
    mimeType: 'text/x-ssa',
    category: 'subtitle',
    description: 'SubStation Alpha subtitles, the predecessor of Advanced SubStation Alpha.',
    targetFormats: ['srt', 'vtt'],
  },
  sub: {
    id: 'sub',
    name: 'MicroDVD Subtitles',
    extension: 'sub',
    mimeType: 'text/x-microdvd',
    category: 'subtitle',
    description: 'MicroDVD text subtitles timed in video frames.',
    targetFormats: ['srt', 'vtt', 'ass'],
  },
};
