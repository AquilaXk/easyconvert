import type { FormatFacts } from './format-specs';

export const MEDIA_FORMAT_SPECIFICATIONS: Record<string, FormatFacts> = {
  mp4: {
    fullName: 'MPEG-4 Part 14 Multimedia Container',
    extension: 'mp4',
  },
  mp3: {
    fullName: 'MPEG-1 Audio Layer III',
    extension: 'mp3',
  },
  wav: {
    fullName: 'Resource Interchange File Format (RIFF WAVE)',
    extension: 'wav',
  },
  aac: {
    fullName: 'Advanced Audio Coding',
    extension: 'aac',
  },
  flac: {
    fullName: 'Free Lossless Audio Codec',
    extension: 'flac',
  },
  ogg: {
    fullName: 'Ogg Vorbis Audio Container',
    extension: 'ogg',
  },
  m4a: {
    fullName: 'MPEG-4 Audio Layer',
    extension: 'm4a',
  },
  png: {
    fullName: 'Portable Network Graphics',
    extension: 'png',
  },
  jpg: {
    fullName: 'JPEG Continuous-Tone Photographic Image',
    extension: 'jpg',
  },
  jpeg: {
    fullName: 'JPEG Continuous-Tone Photographic Image',
    extension: 'jpeg',
  },
  webp: {
    fullName: 'WebP Image Specification',
    extension: 'webp',
  },
  avif: {
    fullName: 'AV1 Image File Format',
    extension: 'avif',
  },
  heic: {
    fullName: 'High Efficiency Image File Format',
    extension: 'heic',
  },
  svg: {
    fullName: 'Scalable Vector Graphics',
    extension: 'svg',
  },
  gif: {
    fullName: 'Graphics Interchange Format 89a',
    extension: 'gif',
  },
};
