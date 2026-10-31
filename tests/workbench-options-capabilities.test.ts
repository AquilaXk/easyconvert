import { describe, expect, it, vi } from 'vitest';
import { createElement, isValidElement, useRef, type ReactNode } from 'react';
import {
  computeVisibleSections,
  FFMPEG_VIDEO_CONTAINERS,
  getPasswordValidationError,
  isLosslessAudioTarget,
  isValidPasswordForTarget,
  resolveAllowedVideoCodecs,
  resolveAudioCapabilities,
  resolveSelectableVideoCodecs,
  sanitizeOptionsForPair,
  sanitizeVideoOptionsForTarget,
} from '../src/components/workbench/options/options-capabilities';
import {
  AudioOptionsSection,
  ImageOptionsSection,
  VideoOptionsSection,
} from '../src/components/workbench/options/ImageAndMediaOptions';
import {
  DataOptionsSection,
  DocumentOptionsSection,
  PasswordOptionsSection,
} from '../src/components/workbench/options/DocumentAndArchiveOptions';
import { INPUT_CLASS as PRIMITIVE_INPUT_CLASS } from '../src/components/workbench/options/section-primitives';
import { INPUT_CLASS as BARREL_INPUT_CLASS } from '../src/components/workbench/OptionsSections';
import OptionsModal from '../src/components/OptionsModal';
import ConversionQueue from '../src/components/ConversionQueue';
import QueueItemRow from '../src/components/workbench/QueueItemRow';
import {
  areOptionsEqual,
  createConversionRunners,
  createQueueMutators,
  type QueueMutationContext,
} from '../src/hooks/useClientQueue';
import * as clientConverter from '../src/lib/client-converter';
import type { ConversionOptions, ConversionQueueItem } from '../src/lib/types';
import { attrOf, renderDom, select, visibleText } from './helpers/rendered-dom';

interface ControlProps {
  id?: string;
  value?: unknown;
  checked?: boolean;
  maxLength?: number;
  disabled?: boolean;
  onClick?: () => void;
  onChange?: (event: { target: { value: string; checked?: boolean } }) => void;
  children?: ReactNode;
}

function findControlProps(node: ReactNode, targetId: string): ControlProps | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findControlProps(child, targetId);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (typeof node.type === 'function') {
    const rendered = (node.type as (props: unknown) => ReactNode)(node.props);
    return findControlProps(rendered, targetId);
  }
  const props = node.props as ControlProps;
  if (props.id === targetId) return props;
  return findControlProps(props.children, targetId);
}

function findButtonPropsByText(node: ReactNode, label: string): ControlProps | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButtonPropsByText(child, label);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (typeof node.type === 'function') {
    const rendered = (node.type as (props: unknown) => ReactNode)(node.props);
    return findButtonPropsByText(rendered, label);
  }
  const props = node.props as ControlProps;
  if (node.type === 'button' && props.children === label) return props;
  return findButtonPropsByText(props.children, label);
}

function buildTestQueueContext(initialItems: ConversionQueueItem[]) {
  const state = {
    isBatchRunning: false,
    inFlightCount: 0,
    zipError: null as string | null,
    revokedUrls: [] as string[],
  };
  const queueRef = { current: [...initialItems] };
  const mountedRef = { current: true };
  const generationRef = { current: new Map<string, number>() };
  const inFlightIdsRef = { current: new Set<string>() };
  const blobUrlsRef = { current: new Set<string>() };
  const timersRef = { current: new Set<ReturnType<typeof setTimeout>>() };
  const batchGenRef = { current: 0 };
  const batchRunningRef = { current: false };

  const ctx: QueueMutationContext = {
    bundlePrefix: 'test_bundle',
    mountedRef,
    queueRef,
    generationRef,
    inFlightIdsRef,
    blobUrlsRef,
    timersRef,
    batchGenRef,
    batchRunningRef,
    updateQueue: (action) => {
      queueRef.current = typeof action === 'function' ? action(queueRef.current) : action;
    },
    revokeBlobUrl: (url) => {
      if (url) state.revokedUrls.push(url);
    },
    isItemBusy: (item) =>
      item.status === 'uploading' || item.status === 'converting' || inFlightIdsRef.current.has(item.id),
    syncInFlight: () => {
      state.inFlightCount = inFlightIdsRef.current.size;
    },
    setIsBatchRunning: (action) => {
      state.isBatchRunning = typeof action === 'function' ? action(state.isBatchRunning) : action;
    },
    setInFlightCount: (action) => {
      state.inFlightCount = typeof action === 'function' ? action(state.inFlightCount) : action;
    },
    setZipError: (action) => {
      state.zipError = typeof action === 'function' ? action(state.zipError) : action;
    },
  };

  return {
    ctx,
    state,
    mutators: createQueueMutators(ctx),
    runners: createConversionRunners(ctx),
  };
}

function makeItem(overrides: Partial<ConversionQueueItem>): ConversionQueueItem {
  return {
    id: 'item-1',
    file: new File(['sample'], 'clip.mp4', { type: 'video/mp4' }),
    name: 'clip.mp4',
    size: 2048,
    sourceFormat: 'mp4',
    targetFormat: 'mp4',
    status: 'ready',
    progress: 0,
    options: {},
    ...overrides,
  };
}

describe('Workbench media, document, and tabular capability model', () => {
  it('restricts video containers, video codecs, and image visibility to real backend dispatch', () => {
    expect([...FFMPEG_VIDEO_CONTAINERS]).toEqual(['mp4', 'mov', 'mkv', 'webm', 'avi']);
    expect(resolveAllowedVideoCodecs('mp4')).toEqual(['h264', 'hevc', 'vp9', 'av1']);
    expect(resolveAllowedVideoCodecs('mov')).toEqual(['h264', 'hevc', 'vp9', 'av1']);
    expect(resolveSelectableVideoCodecs('mov')).toEqual(['h264', 'hevc', 'vp9', 'av1', 'prores']);
    expect(resolveSelectableVideoCodecs('mp4')).toEqual(['h264', 'hevc', 'vp9', 'av1']);
    expect(resolveAllowedVideoCodecs('mkv')).toEqual(['h264', 'hevc', 'vp9', 'av1']);
    expect(resolveAllowedVideoCodecs('webm')).toEqual(['vp9', 'av1']);
    expect(resolveAllowedVideoCodecs('avi')).toEqual([]);
    expect(resolveAllowedVideoCodecs('flv')).toEqual([]);

    const aviVis = computeVisibleSections('mp4', 'avi');
    expect(aviVis.showVideo).toBe(true);
    expect(aviVis.showVideoCodec).toBe(false);
    expect(aviVis.showAudio).toBe(true);

    for (const unmappedVideo of ['flv', 'wmv']) {
      const vis = computeVisibleSections('mp4', unmappedVideo);
      expect(vis.showVideo).toBe(false);
      expect(vis.showVideoCodec).toBe(false);
      expect(vis.showImage).toBe(false);
      expect(vis.showAudio).toBe(true);
    }

    for (const animTarget of ['gif', 'webp']) {
      const fromVideo = computeVisibleSections('mp4', animTarget);
      expect(fromVideo.showVideo).toBe(false);
      expect(fromVideo.showImage).toBe(false);
      expect(fromVideo.showAudio).toBe(false);
      expect(fromVideo.hasAny).toBe(false);
    }

    expect(computeVisibleSections('png', 'gif').showImage).toBe(true);
    expect(computeVisibleSections('png', 'webp').showImage).toBe(true);
    expect(computeVisibleSections('mp3', 'dss').showAudio).toBe(false);
  });

  it('models per-target audio codecs, sample rates, channel layouts, and lossless bitrate rules', () => {
    expect(resolveAudioCapabilities('mp4').allowedCodecs).toEqual(['aac', 'mp3', 'opus', 'flac']);
    expect(resolveAudioCapabilities('mov').allowedCodecs).toEqual(['aac', 'mp3', 'pcm_s16le']);
    expect(resolveAudioCapabilities('mkv').allowedCodecs).toEqual([
      'aac',
      'mp3',
      'opus',
      'flac',
      'vorbis',
      'pcm_s16le',
    ]);
    expect(resolveAudioCapabilities('avi').allowedCodecs).toEqual(['mp3', 'aac', 'pcm_s16le']);
    expect(resolveAudioCapabilities('flv').allowedCodecs).toEqual([]);
    expect(resolveAudioCapabilities('wmv').allowedCodecs).toEqual([]);

    const amrCaps = resolveAudioCapabilities('amr');
    expect(amrCaps.canConfigureBitrate).toBe(false);
    expect(amrCaps.allowedSampleRates).toEqual([]);
    expect(amrCaps.allowedChannels).toEqual([]);

    for (const opusTarget of ['opus', 'weba', 'webm']) {
      expect(resolveAudioCapabilities(opusTarget).allowedSampleRates).toEqual([16000, 48000]);
    }
    expect(resolveAudioCapabilities('webm', 'vorbis').allowedSampleRates).toEqual([
      16000, 22050, 32000, 44100, 48000,
    ]);

    const ac3Caps = resolveAudioCapabilities('ac3');
    expect(ac3Caps.allowedSampleRates).toEqual([32000, 44100, 48000]);
    expect(ac3Caps.allowedChannels).toEqual(['mono', 'stereo', '5.1']);

    for (const stereoMax of ['mp3', 'wma', 'voc']) {
      expect(resolveAudioCapabilities(stereoMax).allowedChannels).toEqual(['mono', 'stereo']);
    }
    expect(resolveAudioCapabilities('avi').allowedChannels).toEqual(['mono', 'stereo']);
    expect(resolveAudioCapabilities('avi', 'aac').allowedChannels).toEqual([
      'mono',
      'stereo',
      '5.1',
      '7.1',
    ]);
    expect(resolveAudioCapabilities('voc').allowedSampleRates).toEqual([16000, 22050, 32000, 44100]);
    expect(resolveAudioCapabilities('voc').canConfigureBitrate).toBe(false);
    expect(isLosslessAudioTarget('wav')).toBe(true);
    expect(resolveAudioCapabilities('mp4', 'flac').canConfigureBitrate).toBe(false);
    expect(resolveAudioCapabilities('mov', 'pcm_s16le').canConfigureBitrate).toBe(false);
  });

  it('scopes delimiter and worksheet index visibility to real spreadsheet/tabular pairs', () => {
    expect(computeVisibleSections('csv', 'json').canConfigureDelimiter).toBe(true);
    expect(computeVisibleSections('csv', 'zip').canConfigureDelimiter).toBe(false);
    expect(computeVisibleSections('csv', 'zst').canConfigureDelimiter).toBe(false);
    expect(computeVisibleSections('tsv', 'xlsx').canConfigureDelimiter).toBe(false);
    expect(computeVisibleSections('tsv', 'ods').canConfigureDelimiter).toBe(false);
    expect(computeVisibleSections('tsv', 'xls').canConfigureDelimiter).toBe(false);
    expect(computeVisibleSections('tsv', 'json').canConfigureDelimiter).toBe(true);
    expect(computeVisibleSections('tab', 'json').canConfigureDelimiter).toBe(true);
    expect(computeVisibleSections('tab', 'xlsx').canConfigureDelimiter).toBe(false);
    expect(computeVisibleSections('pdf', 'csv').canConfigureDelimiter).toBe(false);
    expect(computeVisibleSections('xlsx', 'tsv').canConfigureDelimiter).toBe(false);
    expect(computeVisibleSections('docx', 'csv').canConfigureDelimiter).toBe(true);

    expect(computeVisibleSections('xlsx', 'csv').canConfigureSheetIndex).toBe(true);
    expect(computeVisibleSections('xlsx', 'json').canConfigureSheetIndex).toBe(true);
    expect(computeVisibleSections('xlsx', 'pdf').canConfigureSheetIndex).toBe(false);
    expect(computeVisibleSections('xls', 'csv').canConfigureSheetIndex).toBe(false);
  });

  it('sanitizes incompatible options idempotently when format pairs change', () => {
    const mp4Opts: ConversionOptions = {
      videoCodec: 'h264',
      videoFps: 30,
      video: { scale: { width: 1280, height: 720, fit: 'contain' } },
      audio: { codec: 'aac' },
      audioBitrate: '192k',
      audioSampleRate: 44100,
      audioChannels: '5.1',
      audioVolume: 125,
      trim: { start: ' 00:00:02 ', end: '00:00:10' },
    };
    const forWebm = sanitizeOptionsForPair(mp4Opts, 'mp4', 'webm');
    expect(forWebm).toEqual({
      videoFps: 30,
      video: { scale: { width: 1280, height: 720, fit: 'contain' } },
      audioBitrate: '192k',
      audioChannels: '5.1',
      audioVolume: 125,
      trim: { start: '00:00:02', end: '00:00:10' },
    });
    expect(sanitizeOptionsForPair(forWebm, 'mp4', 'webm')).toEqual(forWebm);
    expect(
      sanitizeOptionsForPair(
        {
          videoCodec: 'h264',
          video: {
            preset: 'fast',
            profile: 'high',
            level: '4.1',
            scale: { width: 1280, fit: 'contain' },
          },
        },
        'mp4',
        'webm'
      )
    ).toEqual({
      video: { scale: { width: 1280, fit: 'contain' } },
    });
    expect(
      sanitizeOptionsForPair(
        { video: { profile: 'high', preset: 'fast', level: '4.1' } },
        'mp4',
        'webm'
      )
    ).toEqual({});
    expect(
      sanitizeOptionsForPair(
        {
          videoCodec: 'h264',
          video: {
            preset: 'fast',
            profile: 'high',
            level: '4.1',
            rateControl: { mode: 'vbr', bitrateK: 2000, twoPass: true },
          },
        },
        'mp4',
        'avi'
      )
    ).toEqual({
      video: { rateControl: { mode: 'vbr', bitrateK: 2000 } },
    });
    expect(
      sanitizeOptionsForPair(
        {
          videoCodec: 'av1',
          video: {
            preset: 'fast',
            profile: 'high',
            level: '4.0',
            rateControl: { mode: 'vbr', bitrateK: 1500, twoPass: true },
          },
        },
        'mp4',
        'mp4'
      )
    ).toEqual({
      videoCodec: 'av1',
      video: { rateControl: { mode: 'vbr', bitrateK: 1500 } },
    });
    expect(
      sanitizeOptionsForPair(
        { videoCodec: 'av1', video: { preset: '8', profile: 'main' } },
        'mp4',
        'mp4'
      )
    ).toEqual({
      videoCodec: 'av1',
      video: { preset: '8', profile: 'main' },
    });
    expect(
      sanitizeOptionsForPair(
        {
          video: {
            codec: 'prores',
            profile: 'hq',
            preset: 'fast',
            level: '4.1',
            rateControl: { mode: 'crf', crf: 20 },
          },
        },
        'mp4',
        'mov'
      )
    ).toEqual({
      video: { codec: 'prores', profile: 'hq' },
    });
    expect(
      sanitizeOptionsForPair({ video: { codec: 'prores', profile: 'hq' } }, 'mov', 'mp4')
    ).toEqual({});
    expect(
      sanitizeVideoOptionsForTarget({ video: { rateControl: { mode: 'crf', crf: 51 } } }, 'avi')
    ).toEqual({ video: { rateControl: { mode: 'crf', crf: 51 } } });
    for (const badCrf of [52, -1, Number.NaN]) {
      expect(sanitizeVideoOptionsForTarget({ video: { rateControl: { mode: 'crf', crf: badCrf } } }, 'avi')).toEqual({});
    }
    expect(
      sanitizeVideoOptionsForTarget(
        { videoCodec: 'h264', video: { codec: 'av1', preset: '8', profile: 'main', rateControl: { mode: 'crf', crf: 60 } } },
        'webm'
      )
    ).toEqual({ video: { codec: 'av1', preset: '8', profile: 'main', rateControl: { mode: 'crf', crf: 60 } } });
    expect(
      sanitizeVideoOptionsForTarget(
        { videoCodec: 'vp9', video: { codec: 'prores', profile: 'hq', rateControl: { mode: 'crf', crf: 60 } } },
        'mp4'
      )
    ).toEqual({});
    expect(
      sanitizeVideoOptionsForTarget({ videoCodec: 'vp9', video: { rateControl: { mode: 'crf', crf: 58 } } }, 'avi')
    ).toEqual({});

    expect(
      sanitizeOptionsForPair({ password: '비밀번호', compressionLevel: 9 }, 'txt', 'tar')
    ).toEqual({});
    expect(
      sanitizeOptionsForPair({ password: '비밀번호' }, 'txt', 'zip')
    ).toEqual({ password: '비밀번호' });
    expect(
      sanitizeOptionsForPair({ password: 'a'.repeat(100), compressionLevel: 6 }, 'txt', 'zip')
    ).toEqual({ password: 'a'.repeat(100), compressionLevel: 6 });
    expect(
      sanitizeOptionsForPair({ password: 'a'.repeat(100), compressionLevel: 6 }, 'txt', '7z')
    ).toEqual({ password: 'a'.repeat(100), compressionLevel: 6 });
    expect(
      sanitizeOptionsForPair({ password: 'a'.repeat(257) }, 'pdf', 'txt')
    ).toEqual({ password: 'a'.repeat(257) });

    expect(getPasswordValidationError('txt', 'tar', '비밀번호')).toBeNull();
    expect(getPasswordValidationError('txt', 'zip', '비밀번호')).toBe(
      'ZIP passwords support 1 to 99 printable ASCII characters only.'
    );
    expect(getPasswordValidationError('txt', '7z', '비밀번호🔑')).toBeNull();
    expect(isValidPasswordForTarget('비밀번호🔑', '7z')).toBe(true);
    for (const badPw of ['bad\rpw', 'bad\npw', 'bad\0pw', 'bad\ud800pw', 'bad\udc00pw']) {
      expect(isValidPasswordForTarget(badPw, '7z')).toBe(false);
      expect(getPasswordValidationError('txt', '7z', badPw)).toBe(
        'Passwords cannot contain line breaks, null bytes, or invalid Unicode.'
      );
      expect(getPasswordValidationError('pdf', 'txt', badPw)).toBe(
        'Passwords cannot contain line breaks, null bytes, or invalid Unicode.'
      );
    }
    expect(getPasswordValidationError('txt', '7z', 'a'.repeat(257))).toBe(
      'Passwords must be 256 characters or fewer.'
    );
    expect(getPasswordValidationError('pdf', 'txt', 'a'.repeat(257))).toBe(
      'Passwords must be 256 characters or fewer.'
    );

    const pngPdfOpts: ConversionOptions = {
      ocrEnabled: true,
      ocrLanguage: 'kor',
      orientation: 'landscape',
      quality: 88,
      stripMetadata: false,
    };
    expect(sanitizeOptionsForPair(pngPdfOpts, 'png', 'webp')).toEqual({ quality: 88 });
    expect(sanitizeOptionsForPair(pngPdfOpts, 'png', 'hocr')).toEqual({ ocrLanguage: 'kor' });
    expect(sanitizeOptionsForPair(pngPdfOpts, 'png', '')).toEqual({});
    expect(sanitizeOptionsForPair({ sheetIndex: 2 }, 'xlsx', 'csv')).toEqual({
      sheetIndex: 2,
      sheetMode: 'index',
    });
    expect(sanitizeOptionsForPair({ audioVolume: 100 }, 'mp3', 'ogg')).toEqual({});
  });

  it('writes video.scale, prunes sibling audio fields on codec switch, and pairs sheetMode with sheetIndex', () => {
    let videoOpts: ConversionOptions = {};
    const applyVideo = (next: ConversionOptions) => {
      videoOpts = next;
    };

    expect(PRIMITIVE_INPUT_CLASS).toBe(BARREL_INPUT_CLASS);

    const renderMp4Video = () =>
      VideoOptionsSection({ options: videoOpts, onChange: applyVideo, showCodec: true, targetFormat: 'mp4' });
    findControlProps(renderMp4Video(), 'opt-video-width')!.onChange!({ target: { value: '1280' } });
    expect(videoOpts).toEqual({ video: { scale: { width: 1280, fit: 'contain' } } });
    expect(videoOpts.width).toBeUndefined();

    findControlProps(renderMp4Video(), 'opt-video-height')!.onChange!({ target: { value: '720' } });
    expect(videoOpts).toEqual({ video: { scale: { width: 1280, height: 720, fit: 'contain' } } });

    findControlProps(renderMp4Video(), 'opt-video-width')!.onChange!({ target: { value: '' } });
    findControlProps(renderMp4Video(), 'opt-video-height')!.onChange!({ target: { value: '' } });
    expect(videoOpts).toEqual({});

    const aviModalDom = renderDom(
      createElement(OptionsModal, {
        filename: 'clip.mp4', sourceFormat: 'mp4', targetFormat: 'avi',
        initialOptions: {}, onSave: () => undefined, onClose: () => undefined,
      })
    );
    expect(select(aviModalDom, 'select', 'id', 'opt-video-codec')).toHaveLength(0);
    expect(select(aviModalDom, 'select', 'id', 'opt-video-fps')).toHaveLength(1);

    let audioOpts: ConversionOptions = {
      audio: { codec: 'aac' }, audioBitrate: '256k', audioSampleRate: 22050, audioChannels: '5.1',
    };
    const applyAudio = (next: ConversionOptions) => { audioOpts = next; };
    const renderAudio = (targetFormat: string) =>
      AudioOptionsSection({ options: audioOpts, onChange: applyAudio, includeTrim: false, targetFormat });
    findControlProps(renderAudio('mp4'), 'opt-audio-codec')!.onChange!({ target: { value: 'flac' } });
    expect(audioOpts.audioBitrate).toBeUndefined();
    expect(audioOpts.audio?.codec).toBe('flac');

    audioOpts = { audio: { codec: 'aac' }, audioBitrate: '192k', audioSampleRate: 22050, audioChannels: '5.1' };
    findControlProps(renderAudio('mp4'), 'opt-audio-codec')!.onChange!({ target: { value: 'opus' } });
    expect(audioOpts.audioSampleRate).toBeUndefined();
    expect(audioOpts.audioChannels).toBe('5.1');

    findControlProps(renderAudio('mp4'), 'opt-audio-codec')!.onChange!({ target: { value: 'mp3' } });
    expect(audioOpts.audioChannels).toBeUndefined();

    audioOpts = { audioVolume: 140 };
    findControlProps(renderAudio('mp3'), 'opt-audio-volume')!.onChange!({ target: { value: '100' } });
    expect(audioOpts.audioVolume).toBeUndefined();

    const amrDom = renderDom(
      createElement(AudioOptionsSection, { options: {}, onChange: () => undefined, includeTrim: true, targetFormat: 'amr' })
    );
    expect(select(amrDom, 'select', 'id', 'opt-audio-bitrate')).toHaveLength(0);
    expect(select(amrDom, 'select', 'id', 'opt-audio-sample-rate')).toHaveLength(0);
    expect(select(amrDom, 'select', 'id', 'opt-audio-channels')).toHaveLength(0);

    let dataOpts: ConversionOptions = {};
    const applyData = (next: ConversionOptions) => { dataOpts = next; };
    const renderData = () =>
      DataOptionsSection({ options: dataOpts, onChange: applyData, canConfigureDelimiter: true, canConfigureSheetIndex: true });
    findControlProps(renderData(), 'opt-data-sheet-index')!.onChange!({ target: { value: '3' } });
    expect(dataOpts).toEqual({ sheetIndex: 3, sheetMode: 'index' });
    findControlProps(renderData(), 'opt-data-sheet-index')!.onChange!({ target: { value: '' } });
    expect(dataOpts).toEqual({ sheetIndex: undefined, sheetMode: undefined });

    let docOpts: ConversionOptions = {};
    const applyDoc = (next: ConversionOptions) => { docOpts = next; };
    const renderDoc = () =>
      DocumentOptionsSection({ options: docOpts, onChange: applyDoc, canSelectPages: false, canConfigureLayout: false, canConfigureOcr: true });
    findControlProps(renderDoc(), 'opt-doc-ocr')!.onChange!({ target: { value: '', checked: true } });
    expect(docOpts).toEqual({ ocrEnabled: true, ocrLanguage: 'eng' });
    findControlProps(renderDoc(), 'opt-doc-ocr')!.onChange!({ target: { value: '', checked: false } });
    expect(docOpts).toEqual({ ocrEnabled: undefined, ocrLanguage: undefined });

    let imgOpts: ConversionOptions = { stripMetadata: true };
    findControlProps(
      ImageOptionsSection({ options: imgOpts, onChange: (next) => { imgOpts = next; }, targetFormat: 'webp' }),
      'opt-strip-metadata'
    )!.onChange!({ target: { value: '', checked: false } });
    expect(imgOpts.stripMetadata).toBeUndefined();

    const sevenZipPwDom = renderDom(
      createElement(PasswordOptionsSection, {
        options: {}, onChange: () => undefined, mode: 'archive-encrypt', sourceFormat: 'txt', targetFormat: '7z',
      })
    );
    expect(attrOf(select(sevenZipPwDom, 'input', 'id', 'opt-doc-password')[0], 'maxlength')).toBe('256');
    expect(attrOf(select(sevenZipPwDom, 'input', 'id', 'opt-doc-password')[0], 'aria-describedby')).toBe('opt-doc-password-help');

    expect(isValidPasswordForTarget('', 'ZIP')).toBe(false);
    expect(isValidPasswordForTarget('AsciiSecret1!', 'ZIP')).toBe(true);
    expect(isValidPasswordForTarget('비밀번호', 'ZIP')).toBe(false);

    const tooLongSevenZipDom = renderDom(
      createElement(PasswordOptionsSection, {
        options: { password: 'a'.repeat(257) }, onChange: () => undefined,
        mode: 'archive-encrypt', sourceFormat: 'txt', targetFormat: '7z',
      })
    );
    const sevenZipAlerts = select(tooLongSevenZipDom, 'p', 'role', 'alert');
    expect(sevenZipAlerts).toHaveLength(1);
    expect(visibleText(sevenZipAlerts[0])).toBe('Passwords must be 256 characters or fewer.');

    const tooLongPdfDom = renderDom(
      createElement(PasswordOptionsSection, {
        options: { password: 'a'.repeat(257) }, onChange: () => undefined,
        mode: 'pdf-decrypt', sourceFormat: 'pdf', targetFormat: 'txt',
      })
    );
    expect(visibleText(select(tooLongPdfDom, 'p', 'role', 'alert')[0])).toBe(
      'Passwords must be 256 characters or fewer.'
    );

    let nestedCodecVideoOpts: ConversionOptions = {
      video: {
        codec: 'hevc',
        profile: 'main10',
        preset: 'slow',
        rateControl: { mode: 'vbr', bitrateK: 2000, twoPass: true },
      },
    };
    const renderNestedVideo = () =>
      VideoOptionsSection({
        options: nestedCodecVideoOpts,
        onChange: (next) => { nestedCodecVideoOpts = next; },
        showCodec: true,
        targetFormat: 'mp4',
      });
    const videoCodecCtrl = findControlProps(renderNestedVideo(), 'opt-video-codec')!;
    expect(videoCodecCtrl.value).toBe('hevc');
    videoCodecCtrl.onChange!({ target: { value: 'av1' } });
    expect(nestedCodecVideoOpts).toEqual({
      videoCodec: 'av1',
      video: { rateControl: { mode: 'vbr', bitrateK: 2000 } },
    });

    nestedCodecVideoOpts = { video: { codec: 'h264', profile: 'high', level: '4.1', preset: 'slow' } };
    findControlProps(renderNestedVideo(), 'opt-video-codec')!.onChange!({ target: { value: '' } });
    expect(nestedCodecVideoOpts).toEqual({});

    let movVideoOpts: ConversionOptions = { videoCodec: 'h264', video: { codec: 'prores', profile: 'hq' } };
    const renderMovVideo = () =>
      VideoOptionsSection({ options: movVideoOpts, onChange: (next) => { movVideoOpts = next; }, showCodec: true, targetFormat: 'mov' });
    const movDom = renderDom(createElement(VideoOptionsSection, { options: movVideoOpts, onChange: () => undefined, showCodec: true, targetFormat: 'mov' }));
    expect(select(movDom, 'option').map((o) => attrOf(o, 'value'))).toContain('prores');
    expect(findControlProps(renderMovVideo(), 'opt-video-codec')!.value).toBe('prores');
    findControlProps(renderMovVideo(), 'opt-video-codec')!.onChange!({ target: { value: '' } });
    expect(movVideoOpts).toEqual({});
    findControlProps(renderMovVideo(), 'opt-video-codec')!.onChange!({ target: { value: 'prores' } });
    expect(movVideoOpts).toEqual({ video: { codec: 'prores' } });
    findControlProps(renderMovVideo(), 'opt-video-codec')!.onChange!({ target: { value: '' } });
    expect(movVideoOpts).toEqual({});

    const mountedUnicodeZipModal = renderDom(
      createElement(OptionsModal, {
        filename: 'report.txt', sourceFormat: 'txt', targetFormat: 'zip',
        initialOptions: { password: '비밀번호' }, onSave: () => undefined, onClose: () => undefined,
      })
    );
    const mountedPwInput = select(mountedUnicodeZipModal, 'input', 'id', 'opt-doc-password')[0];
    expect(attrOf(mountedPwInput, 'value')).toBe('비밀번호');
    expect(attrOf(mountedPwInput, 'aria-invalid')).toBe('true');
    expect(visibleText(select(mountedUnicodeZipModal, 'p', 'role', 'alert')[0])).toBe(
      'ZIP passwords support 1 to 99 printable ASCII characters only.'
    );
    const mountedApplyBtn = select(mountedUnicodeZipModal, 'button').find(
      (b) => visibleText(b) === 'Apply Options'
    )!;
    expect(attrOf(mountedApplyBtn, 'disabled')).toBe('');

    const onSaveZip = vi.fn();
    const captured: { apply: ControlProps | null } = { apply: null };
    function ZipModalAfterNonAsciiPassword() {
      const didType = useRef(false);
      const tree = OptionsModal({
        filename: 'report.txt',
        sourceFormat: 'txt',
        targetFormat: 'zip',
        initialOptions: {},
        onSave: onSaveZip,
        onClose: () => undefined,
      });
      if (!didType.current) {
        didType.current = true;
        findControlProps(tree, 'opt-doc-password')!.onChange!({ target: { value: '비밀번호' } });
      } else {
        captured.apply = findButtonPropsByText(tree, 'Apply Options');
      }
      return tree;
    }
    const zipModalDom = renderDom(createElement(ZipModalAfterNonAsciiPassword));
    const zipApplyBtn = select(zipModalDom, 'button').find((b) => visibleText(b) === 'Apply Options')!;
    expect(attrOf(zipApplyBtn, 'disabled')).toBe('');
    const zipAlerts = select(zipModalDom, 'p', 'role', 'alert');
    expect(zipAlerts).toHaveLength(1);
    expect(attrOf(zipAlerts[0], 'id')).toBe('opt-doc-password-error');
    expect(visibleText(zipAlerts[0])).toBe(
      'ZIP passwords support 1 to 99 printable ASCII characters only.'
    );
    const zipPwInput = select(zipModalDom, 'input', 'id', 'opt-doc-password')[0];
    expect(attrOf(zipPwInput, 'aria-invalid')).toBe('true');
    expect(attrOf(zipPwInput, 'aria-describedby')).toBe('opt-doc-password-error');
    captured.apply?.onClick?.();
    expect(onSaveZip).not.toHaveBeenCalled();
  });

  it('compares nested options structurally, disables oversize row controls, and prevents batch stranding', async () => {
    expect(
      areOptionsEqual(
        { video: { scale: { width: 1280, fit: 'contain' } }, stripMetadata: undefined },
        { video: { scale: { width: 1280, fit: 'contain' } } }
      )
    ).toBe(true);
    expect(
      areOptionsEqual(
        { video: { scale: { width: 1280, fit: 'contain' } } },
        { video: { scale: { width: 1920, fit: 'contain' } } }
      )
    ).toBe(false);

    const maxBytes = clientConverter.getEffectiveMaxFileSize();
    const noop = () => undefined;
    const rowNoops = {
      isFormatSelectorOpen: false, onToggleFormatSelector: noop, onCloseFormatSelector: noop,
      onSelectTargetFormat: noop, onOpenOptions: noop, onRetry: noop, onRemove: noop,
    };
    const recoverableRowDom = renderDom(
      createElement(QueueItemRow, {
        item: makeItem({
          id: 'cells-err-1', name: 'sheet.csv', size: 2048, sourceFormat: 'csv', targetFormat: 'parquet',
          status: 'error', error: 'Cannot write Parquet: table exceeds the limit of 5000000 cells.',
        }),
        ...rowNoops,
      })
    );
    expect(
      attrOf(select(recoverableRowDom, 'button', 'data-testid', 'queue-target-format-btn')[0], 'disabled')
    ).toBeNull();
    expect(
      attrOf(select(recoverableRowDom, 'button', 'data-testid', 'queue-options-btn')[0], 'disabled')
    ).toBeNull();
    const recoverableRetryBtn = select(recoverableRowDom, 'button').find(
      (b) => visibleText(b) === 'Retry'
    )!;
    expect(attrOf(recoverableRetryBtn, 'disabled')).toBeNull();

    const oversizeRowDom = renderDom(
      createElement(QueueItemRow, {
        item: makeItem({
          id: 'over-1', size: maxBytes + 1024, targetFormat: 'webm',
          status: 'error', error: 'File exceeds the 100 MB real-time conversion limit.',
        }),
        ...rowNoops,
      })
    );
    expect(
      attrOf(select(oversizeRowDom, 'button', 'data-testid', 'queue-target-format-btn')[0], 'disabled')
    ).toBe('');
    expect(
      attrOf(select(oversizeRowDom, 'button', 'data-testid', 'queue-options-btn')[0], 'disabled')
    ).toBe('');
    const retryBtn = select(oversizeRowDom, 'button').find((b) => visibleText(b) === 'Retry')!;
    expect(attrOf(retryBtn, 'disabled')).toBe('');
    const removeBtn = select(oversizeRowDom, 'button', 'aria-label', 'Remove clip.mp4')[0];
    expect(attrOf(removeBtn, 'disabled')).toBeNull();

    const harness = buildTestQueueContext([
      makeItem({
        id: 'vid-1',
        sourceFormat: 'mp4',
        targetFormat: 'mp4',
        status: 'completed',
        resultUrl: 'blob:http://localhost/done-1',
        options: { videoCodec: 'h264', audio: { codec: 'aac' }, videoFps: 30 },
      }),
      makeItem({
        id: 'over-2',
        size: maxBytes + 10,
        sourceFormat: 'mp4',
        targetFormat: '',
        status: 'error',
        error: 'File exceeds the 100 MB real-time conversion limit.',
      }),
    ]);

    harness.mutators.handleUpdateOptions('vid-1', {
      videoCodec: 'h264',
      audio: { codec: 'aac' },
      videoFps: 30,
    });
    expect(harness.ctx.queueRef.current[0].status).toBe('completed');
    expect(harness.state.revokedUrls).toEqual([]);

    harness.mutators.handleUpdateTargetFormat('vid-1', 'webm');
    expect(harness.ctx.queueRef.current[0].status).toBe('ready');
    expect(harness.ctx.queueRef.current[0].targetFormat).toBe('webm');
    expect(harness.ctx.queueRef.current[0].options).toEqual({ videoFps: 30 });
    expect(harness.state.revokedUrls).toEqual(['blob:http://localhost/done-1']);

    let resolveConversion: (() => void) | undefined;
    const execSpy = vi
      .spyOn(clientConverter, 'executeItemConversion')
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveConversion = resolve;
          })
      );

    try {
      const firstBatch = harness.runners.handleConvertAll();
      const duplicateBatch = harness.runners.handleConvertAll();
      await duplicateBatch;
      expect(execSpy).toHaveBeenCalledTimes(1);
      expect(harness.state.isBatchRunning).toBe(true);
      expect(harness.ctx.batchRunningRef.current).toBe(true);

      harness.mutators.handleRemoveItem('vid-1');
      expect(harness.ctx.queueRef.current.map((i) => i.id)).toEqual(['over-2']);
      expect(harness.state.isBatchRunning).toBe(false);
      expect(harness.ctx.batchRunningRef.current).toBe(false);
      expect(harness.state.inFlightCount).toBe(0);

      resolveConversion?.();
      await firstBatch;
      expect(harness.state.isBatchRunning).toBe(false);
    } finally {
      execSpy.mockRestore();
    }
  });

  it('fails closed on invalid target passwords across queue transitions while keeping recoverable non-size errors convertible', async () => {
    const noop = () => undefined;
    const queueNoops = {
      onRemoveItem: noop, onClearAll: noop, onUpdateTargetFormat: noop, onUpdateOptions: noop,
      onConvertAll: noop, onConvertSingle: noop, onAddMoreFiles: noop, onDownloadAllZip: noop, isConverting: false,
    };
    const parquetFailedQueue = renderDom(
      createElement(ConversionQueue, {
        items: [
          makeItem({
            id: 'parquet-err', name: 'sheet.csv', size: 2048, sourceFormat: 'csv', targetFormat: 'parquet',
            status: 'error', error: 'Cannot write Parquet: table exceeds the limit of 5000000 cells.',
          }),
        ],
        ...queueNoops,
      })
    );
    const parquetConvertBtn = select(parquetFailedQueue, 'button').find(
      (b) => visibleText(b) === 'Convert'
    )!;
    expect(attrOf(parquetConvertBtn, 'disabled')).toBeNull();
    expect(visibleText(select(parquetFailedQueue, 'output')[0])).toBe(
      '1 file failed conversion. Retry or remove to continue.'
    );

    const pwHarness = buildTestQueueContext([
      makeItem({
        id: 'arch-1', name: 'report.txt', sourceFormat: 'txt', targetFormat: '7z',
        status: 'completed', resultUrl: 'blob:http://localhost/arch-7z', options: { password: '비밀번호' },
      }),
    ]);

    pwHarness.mutators.handleUpdateTargetFormat('arch-1', 'zip');
    const zipItem = pwHarness.ctx.queueRef.current[0];
    expect(pwHarness.state.revokedUrls).toEqual(['blob:http://localhost/arch-7z']);
    expect(zipItem.targetFormat).toBe('zip');
    expect(zipItem.options).toEqual({ password: '비밀번호' });
    expect(zipItem.status).toBe('error');
    expect(zipItem.error).toBe('ZIP passwords support 1 to 99 printable ASCII characters only.');

    const invalidZipRowDom = renderDom(
      createElement(QueueItemRow, {
        item: zipItem, isFormatSelectorOpen: false, onToggleFormatSelector: noop, onCloseFormatSelector: noop,
        onSelectTargetFormat: noop, onOpenOptions: noop, onRetry: noop, onRemove: noop,
      })
    );
    expect(
      attrOf(select(invalidZipRowDom, 'button', 'data-testid', 'queue-target-format-btn')[0], 'disabled')
    ).toBeNull();
    expect(
      attrOf(select(invalidZipRowDom, 'button', 'data-testid', 'queue-options-btn')[0], 'disabled')
    ).toBeNull();
    expect(
      attrOf(select(invalidZipRowDom, 'button').find((b) => visibleText(b) === 'Retry')!, 'disabled')
    ).toBe('');

    const invalidZipQueueDom = renderDom(createElement(ConversionQueue, { items: [zipItem], ...queueNoops }));
    expect(
      attrOf(select(invalidZipQueueDom, 'button').find((b) => visibleText(b) === 'Convert')!, 'disabled')
    ).toBe('');

    const completedPlusReadyQueueDom = renderDom(
      createElement(ConversionQueue, {
        items: [
          makeItem({
            id: 'done-zip', name: 'done.txt', sourceFormat: 'txt', targetFormat: 'zip',
            status: 'completed', resultUrl: 'blob:http://localhost/done-zip', options: { password: '비밀번호' },
          }),
          makeItem({ id: 'pending-valid', name: 'next.txt', sourceFormat: 'txt', targetFormat: '7z', status: 'ready' }),
        ],
        ...queueNoops,
      })
    );
    expect(
      attrOf(select(completedPlusReadyQueueDom, 'button').find((b) => visibleText(b) === 'Convert')!, 'disabled')
    ).toBeNull();
    expect(visibleText(select(completedPlusReadyQueueDom, 'output')[0])).toBe('Ready to convert 1 file');

    const execSpy = vi.spyOn(clientConverter, 'executeItemConversion').mockResolvedValue(undefined);
    try {
      await pwHarness.runners.convertSingleItem('arch-1');
      await pwHarness.runners.handleConvertAll();
      expect(execSpy).not.toHaveBeenCalled();

      pwHarness.mutators.handleUpdateTargetFormat('arch-1', '7z');
      expect(pwHarness.ctx.queueRef.current[0].status).toBe('ready');
      expect(pwHarness.ctx.queueRef.current[0].error).toBeUndefined();
      expect(pwHarness.ctx.queueRef.current[0].options).toEqual({ password: '비밀번호' });

      pwHarness.mutators.handleUpdateTargetFormat('arch-1', 'zip');
      expect(pwHarness.ctx.queueRef.current[0].status).toBe('error');

      pwHarness.mutators.handleUpdateOptions('arch-1', { password: 'Secret123' });
      expect(pwHarness.ctx.queueRef.current[0].status).toBe('ready');
      expect(pwHarness.ctx.queueRef.current[0].error).toBeUndefined();
      expect(pwHarness.ctx.queueRef.current[0].options).toEqual({ password: 'Secret123' });
    } finally {
      execSpy.mockRestore();
    }
  });
});
