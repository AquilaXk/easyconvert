import type { FormatFacts } from './format-specs';

export const MEDIA_FORMAT_SPECIFICATIONS: Record<string, FormatFacts> = {
  mp4: {
    fullName: 'MPEG-4 Part 14 Multimedia Container',
  },
  mp3: {
    fullName: 'MPEG-1 Audio Layer III',
  },
  wav: {
    fullName: 'Resource Interchange File Format (RIFF WAVE)',
  },
  aac: {
    fullName: 'Advanced Audio Coding',
  },
  flac: {
    fullName: 'Free Lossless Audio Codec',
  },
  ogg: {
    fullName: 'Ogg Vorbis Audio Container',
  },
  m4a: {
    fullName: 'MPEG-4 Audio Layer',
  },
  png: {
    fullName: 'Portable Network Graphics',
  },
  jpg: {
    fullName: 'JPEG Continuous-Tone Photographic Image',
  },
  jpeg: {
    fullName: 'JPEG Continuous-Tone Photographic Image',
  },
  webp: {
    fullName: 'WebP Image Specification',
  },
  avif: {
    fullName: 'AV1 Image File Format',
  },
  heic: {
    fullName: 'High Efficiency Image File Format',
  },
  svg: {
    fullName: 'Scalable Vector Graphics',
  },
  gif: {
    fullName: 'Graphics Interchange Format 89a',
  },
};
