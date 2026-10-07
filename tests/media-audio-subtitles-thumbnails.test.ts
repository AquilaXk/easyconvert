import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  buildFfmpegArguments,
  AUDIO_CODEC_MAP,
  escapeFfmpegFilterPath,
  probeAudioChannels,
  type FfprobePath,
} from '../src/lib/conversions/media-ffmpeg-args';
import {
  convertMedia,
  getFfmpegPath,
  getFfprobePath,
} from '../src/lib/conversions/media';
import { InvalidMediaOptionError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { assertDecodedMedia } from './oracles/product/media-oracle';

/** AAC priming plus padding: at most two 1024-sample frames. */
const AAC_PADDING_SAMPLES = 2048;
/**
 * lavfi `sine` has a peak of 1/8 full scale (RMS about 2900 of 32768). The ITU-R BS.775 matrix
 * weights sum to 1 per output channel, so the folded tone keeps that level; a silent or lost
 * downmix reads 0.
 */
const MIN_DOWNMIX_RMS = 1000;
/** A JPEG thumbnail of the test pattern scored 0.992 against the PNG reference; the floor leaves margin for encoder builds. */
const THUMBNAIL_MIN_SSIM = 0.98;

describe('WP-44b: Media Audio Controls, ITU-R BS.775 Downmixing & Subtitles & Thumbnails', () => {
  describe('1. Audio Codec Validation & Container Compatibility Gate', () => {
    it('accepts compliant codecs for MP4, WebM, and Ogg containers', () => {
      const mp4Args = buildFfmpegArguments('/nonexistent/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
        disableHwaccel: true,
        audio: { codec: 'aac', bitrateK: 256 },
      });
      const cIdx = mp4Args.indexOf('-c:a');
      expect(cIdx).toBeGreaterThan(0);
      expect(mp4Args[cIdx + 1]).toBe('aac');
      const bIdx = mp4Args.indexOf('-b:a');
      expect(bIdx).toBeGreaterThan(0);
      expect(mp4Args[bIdx + 1]).toBe('256k');

      const webmArgs = buildFfmpegArguments('/nonexistent/in.webm', '/tmp/out.webm', 'webm', 'webm', {
        disableHwaccel: true,
        audio: { codec: 'opus', bitrateK: 128 },
      });
      const webmCIdx = webmArgs.indexOf('-c:a');
      expect(webmArgs[webmCIdx + 1]).toBe('libopus');

      const oggArgs = buildFfmpegArguments('/tmp/in.ogg', '/tmp/out.ogg', 'ogg', 'ogg', {
        audio: { codec: 'vorbis' },
      });
      const oggCIdx = oggArgs.indexOf('-c:a');
      expect(oggArgs[oggCIdx + 1]).toBe('libvorbis');
    });

    it('fails closed when an incompatible audio codec is requested in WebM container', () => {
      expect(() => {
        buildFfmpegArguments('/nonexistent/in.webm', '/tmp/out.webm', 'webm', 'webm', {
          audio: { codec: 'aac' },
        });
      }).toThrowError(InvalidMediaOptionError);

      expect(() => {
        buildFfmpegArguments('/nonexistent/in.webm', '/tmp/out.webm', 'webm', 'webm', {
          audio: { codec: 'mp3' },
        });
      }).toThrowError(InvalidMediaOptionError);
    });

    it('fails closed when an incompatible audio codec is requested in Ogg container', () => {
      expect(() => {
        buildFfmpegArguments('/tmp/in.ogg', '/tmp/out.ogg', 'ogg', 'ogg', {
          audio: { codec: 'mp3' },
        });
      }).toThrowError(InvalidMediaOptionError);

      expect(() => {
        buildFfmpegArguments('/tmp/in.ogg', '/tmp/out.ogg', 'ogg', 'ogg', {
          audio: { codec: 'aac' },
        });
      }).toThrowError(InvalidMediaOptionError);
    });

    it('fails closed when vorbis audio is requested in MP4 container', () => {
      expect(() => {
        buildFfmpegArguments('/nonexistent/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
          audio: { codec: 'vorbis' },
        });
      }).toThrowError(InvalidMediaOptionError);
    });

    it('maps all defined AudioCodec types to valid FFmpeg encoder names', () => {
      expect(AUDIO_CODEC_MAP.aac).toBe('aac');
      expect(AUDIO_CODEC_MAP.mp3).toBe('libmp3lame');
      expect(AUDIO_CODEC_MAP.opus).toBe('libopus');
      expect(AUDIO_CODEC_MAP.flac).toBe('flac');
      expect(AUDIO_CODEC_MAP.vorbis).toBe('libvorbis');
      expect(AUDIO_CODEC_MAP.pcm_s16le).toBe('pcm_s16le');
    });
  });

  describe('2. Audio Track Selection Gate', () => {
    it('maps all audio tracks when track is set to all', () => {
      const args = buildFfmpegArguments('/nonexistent/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
        disableHwaccel: true,
        audio: { track: 'all' },
      });

      const mapIndices: number[] = [];
      args.forEach((val, idx) => {
        if (val === '-map') mapIndices.push(idx);
      });
      expect(mapIndices.length).toBe(2);
      expect(args[mapIndices[0] + 1]).toBe('0:v:0');
      expect(args[mapIndices[1] + 1]).toBe('0:a');
    });

    it('maps specific audio track index when a numeric index is provided', () => {
      const args = buildFfmpegArguments('/nonexistent/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
        disableHwaccel: true,
        audio: { track: 2 },
      });

      const mapIndices: number[] = [];
      args.forEach((val, idx) => {
        if (val === '-map') mapIndices.push(idx);
      });
      expect(mapIndices.length).toBe(2);
      expect(args[mapIndices[0] + 1]).toBe('0:v:0');
      expect(args[mapIndices[1] + 1]).toBe('0:a:2');
    });

    it('fails closed when a negative track index is provided', () => {
      expect(() => {
        buildFfmpegArguments('/nonexistent/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
          audio: { track: -1 },
        });
      }).toThrowError(InvalidMediaOptionError);
    });
  });

  describe('3. ITU-R BS.775 Surround Downmixing Gate', () => {
    it('generates normalized 5.1 downmixing pan filter and sets 2 output channels', () => {
      const args = buildFfmpegArguments('/nonexistent/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
        disableHwaccel: true,
        audio: { downmix: 'itu-r-bs775' },
      });

      const afIdx = args.indexOf('-filter:a');
      expect(afIdx).toBeGreaterThan(0);
      const afVal = args[afIdx + 1];
      expect(afVal).toContain('pan=stereo|FL=0.4142*FL+0.2929*FC+0.2929*BL|FR=0.4142*FR+0.2929*FC+0.2929*BR');

      const acIdx = args.indexOf('-ac');
      expect(acIdx).toBeGreaterThan(0);
      expect(args[acIdx + 1]).toBe('2');
    });

    it('generates normalized 7.1 downmixing pan filter when 8 channels are specified', () => {
      const args = buildFfmpegArguments('/nonexistent/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
        disableHwaccel: true,
        audio: { downmix: 'itu-r-bs775', channels: 8 },
      });

      const afIdx = args.indexOf('-filter:a');
      expect(afIdx).toBeGreaterThan(0);
      const afVal = args[afIdx + 1];
      expect(afVal).toContain('pan=stereo|FL=0.3204*FL+0.2265*FC+0.2265*BL+0.2265*SL|FR=0.3204*FR+0.2265*FC+0.2265*BR+0.2265*SR');

      const acIdx = args.indexOf('-ac');
      expect(acIdx).toBeGreaterThan(0);
      expect(args[acIdx + 1]).toBe('2');
    });

    it('combines downmix filter with volume normalization cleanly', () => {
      const args = buildFfmpegArguments('/nonexistent/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
        disableHwaccel: true,
        audio: { downmix: 'itu-r-bs775', volume: 80 },
      });

      const afIdx = args.indexOf('-filter:a');
      expect(afIdx).toBeGreaterThan(0);
      const afVal = args[afIdx + 1];
      expect(afVal).toBe(
        'aresample=async=1:first_pts=0,pan=stereo|FL=0.4142*FL+0.2929*FC+0.2929*BL|FR=0.4142*FR+0.2929*FC+0.2929*BR,volume=0.8'
      );
      expect(args[args.indexOf('-ac') + 1]).toBe('2');
    });
  });

  describe('4. Audio Parameters (Bitrate, Channels, Sample Rate, Volume) Gate', () => {
    it('sets discrete channel configurations accurately (mono, stereo, 5.1, 7.1)', () => {
      const monoArgs = buildFfmpegArguments('/tmp/in.mp3', '/tmp/out.mp3', 'mp3', 'mp3', {
        audio: { channels: 1 },
      });
      expect(monoArgs[monoArgs.indexOf('-ac') + 1]).toBe('1');

      const stereoArgs = buildFfmpegArguments('/tmp/in.mp3', '/tmp/out.mp3', 'mp3', 'mp3', {
        audio: { channels: 2 },
      });
      expect(stereoArgs[stereoArgs.indexOf('-ac') + 1]).toBe('2');

      const surround51Args = buildFfmpegArguments('/tmp/in.mp3', '/tmp/out.mp3', 'mp3', 'mp3', {
        audio: { channels: 6 },
      });
      expect(surround51Args[surround51Args.indexOf('-ac') + 1]).toBe('6');

      const surround71Args = buildFfmpegArguments('/tmp/in.mp3', '/tmp/out.mp3', 'mp3', 'mp3', {
        audio: { channels: 8 },
      });
      expect(surround71Args[surround71Args.indexOf('-ac') + 1]).toBe('8');
    });

    it('validates sample rate bounds and fails closed on invalid values', () => {
      const validArgs = buildFfmpegArguments('/tmp/in.wav', '/tmp/out.wav', 'wav', 'wav', {
        audio: { sampleRate: 48000 },
      });
      expect(validArgs[validArgs.indexOf('-ar') + 1]).toBe('48000');

      expect(() => {
        buildFfmpegArguments('/tmp/in.wav', '/tmp/out.wav', 'wav', 'wav', {
          audio: { sampleRate: 4000 },
        });
      }).toThrowError(InvalidMediaOptionError);

      expect(() => {
        buildFfmpegArguments('/tmp/in.wav', '/tmp/out.wav', 'wav', 'wav', {
          audio: { sampleRate: 250000 },
        });
      }).toThrowError(InvalidMediaOptionError);
    });

    it('validates volume bounds and fails closed on out-of-range values', () => {
      const validArgs = buildFfmpegArguments('/tmp/in.mp3', '/tmp/out.mp3', 'mp3', 'mp3', {
        audio: { volume: 150 },
      });
      expect(validArgs[validArgs.indexOf('-filter:a') + 1]).toBe('volume=1.5');

      expect(() => {
        buildFfmpegArguments('/tmp/in.mp3', '/tmp/out.mp3', 'mp3', 'mp3', {
          audio: { volume: -10 },
        });
      }).toThrowError(InvalidMediaOptionError);

      expect(() => {
        buildFfmpegArguments('/tmp/in.mp3', '/tmp/out.mp3', 'mp3', 'mp3', {
          audio: { volume: 250 },
        });
      }).toThrowError(InvalidMediaOptionError);
    });
  });

  describe('5. Subtitles (Burn, Soft, Extract) Gate', () => {
    it('escapes subtitle file paths safely against FFmpeg filter syntax injection', () => {
      const rawPath = 'C:\\media\\sub:title\'s_special.srt';
      const escaped = escapeFfmpegFilterPath(rawPath);
      expect(escaped).toBe(String.raw`C\:/media/sub\:title'\\''s_special.srt`);
    });

    it('burns subtitles by inserting subtitles filter prior to even dimension scale in videoFilters', () => {
      const args = buildFfmpegArguments('/nonexistent/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
        disableHwaccel: true,
        subtitles: {
          mode: 'burn',
          input: '/path/to/subs.srt',
        },
      });

      const vfIdx = args.indexOf('-vf');
      expect(vfIdx).toBeGreaterThan(0);
      const vf = args[vfIdx + 1];
      expect(vf).toContain("subtitles='/path/to/subs.srt'");
      expect(vf.endsWith('scale=trunc(iw/2)*2:trunc(ih/2)*2')).toBe(true);
      // subtitles filter must appear before even scale
      const subPos = vf.indexOf("subtitles='/path/to/subs.srt'");
      const scalePos = vf.indexOf('scale=trunc(iw/2)*2:trunc(ih/2)*2');
      expect(subPos).toBeLessThan(scalePos);
    });

    it('fails closed when subtitle burn mode lacks an input path or targets non-video', () => {
      expect(() => {
        buildFfmpegArguments('/nonexistent/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
          subtitles: { mode: 'burn' },
        });
      }).toThrowError(InvalidMediaOptionError);

      expect(() => {
        buildFfmpegArguments('/tmp/in.mp3', '/tmp/out.mp3', 'mp3', 'mp3', {
          subtitles: { mode: 'burn', input: '/tmp/sub.srt' },
        });
      }).toThrowError(InvalidMediaOptionError);
    });

    it('embeds soft subtitles with stream mapping and container-appropriate codec', () => {
      const mp4Args = buildFfmpegArguments('/nonexistent/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
        disableHwaccel: true,
        subtitles: {
          mode: 'soft',
          input: '/path/to/subs.srt',
        },
      });

      // Second input for subtitle file
      expect(mp4Args).toContain('-i');
      const inIndices: number[] = [];
      mp4Args.forEach((val, idx) => {
        if (val === '-i') inIndices.push(idx);
      });
      expect(inIndices.length).toBe(2);
      expect(mp4Args[inIndices[1] + 1]).toBe('/path/to/subs.srt');

      // Mappings: 0:v, 0:a?, 1:0
      expect(mp4Args).toContain('-map');
      const csIdx = mp4Args.indexOf('-c:s');
      expect(csIdx).toBeGreaterThan(0);
      expect(mp4Args[csIdx + 1]).toBe('mov_text');

      // WebM soft subtitles use webvtt
      const webmArgs = buildFfmpegArguments('/nonexistent/in.webm', '/tmp/out.webm', 'webm', 'webm', {
        disableHwaccel: true,
        subtitles: {
          mode: 'soft',
          input: '/path/to/subs.vtt',
        },
      });
      const webmCsIdx = webmArgs.indexOf('-c:s');
      expect(webmArgs[webmCsIdx + 1]).toBe('webvtt');

      // MKV soft subtitles use srt (or ass)
      const mkvArgs = buildFfmpegArguments('/tmp/in.mkv', '/tmp/out.mkv', 'mkv', 'mkv', {
        disableHwaccel: true,
        subtitles: {
          mode: 'soft',
          input: '/path/to/subs.ass',
          format: 'ass',
        },
      });
      const mkvCsIdx = mkvArgs.indexOf('-c:s');
      expect(mkvArgs[mkvCsIdx + 1]).toBe('ass');
    });

    it('extracts subtitle streams directly into standalone files without video/audio transcoding', () => {
      const extractSrtArgs = buildFfmpegArguments('/nonexistent/in.mp4', '/tmp/out.srt', 'mp4', 'srt', {
        subtitles: {
          mode: 'extract',
          streamIndex: 0,
        },
      });

      expect(extractSrtArgs).toContain('-vn');
      expect(extractSrtArgs).toContain('-an');
      const mapIdx = extractSrtArgs.indexOf('-map');
      expect(mapIdx).toBeGreaterThan(0);
      expect(extractSrtArgs[mapIdx + 1]).toBe('0:s:0');
      const csIdx = extractSrtArgs.indexOf('-c:s');
      expect(csIdx).toBeGreaterThan(0);
      expect(extractSrtArgs[csIdx + 1]).toBe('srt');

      const extractVttArgs = buildFfmpegArguments('/tmp/in.mkv', '/tmp/out.vtt', 'mkv', 'vtt', {
        subtitles: {
          mode: 'extract',
          streamIndex: 1,
          format: 'vtt',
        },
      });
      expect(extractVttArgs[extractVttArgs.indexOf('-map') + 1]).toBe('0:s:1');
      expect(extractVttArgs[extractVttArgs.indexOf('-c:s') + 1]).toBe('webvtt');
    });
  });

  describe('6. Thumbnail Extraction Gate', () => {
    it('generates fast seek thumbnail arguments with input-seeking before -i', () => {
      const args = buildFfmpegArguments('/nonexistent/in.mp4', '/tmp/thumb.jpg', 'mp4', 'jpg', {
        thumbnail: {
          at: ['00:00:03.500'],
          accurate: false,
          format: 'jpg',
          width: 640,
        },
      });

      const ssIdx = args.indexOf('-ss');
      const inIdx = args.indexOf('-i');
      expect(ssIdx).toBeGreaterThan(0);
      expect(ssIdx).toBeLessThan(inIdx); // Before -i for fast keyframe seek
      expect(args[ssIdx + 1]).toBe('00:00:03.500');

      expect(args).toContain('-frames:v');
      expect(args[args.indexOf('-frames:v') + 1]).toBe('1');
      expect(args).toContain('-an');
      expect(args[args.indexOf('-c:v') + 1]).toBe('mjpeg');

      const vf = args[args.indexOf('-vf') + 1];
      expect(vf).toContain('scale=640:-2');
      expect(vf).toContain('scale=trunc(iw/2)*2:trunc(ih/2)*2');
    });

    it('generates accurate seek thumbnail arguments with output-seeking after -i', () => {
      const args = buildFfmpegArguments('/nonexistent/in.mp4', '/tmp/thumb.png', 'mp4', 'png', {
        thumbnail: {
          at: ['00:00:08.200'],
          accurate: true,
          format: 'png',
        },
      });

      const ssIdx = args.indexOf('-ss');
      const inIdx = args.indexOf('-i');
      expect(ssIdx).toBeGreaterThan(0);
      expect(ssIdx).toBeGreaterThan(inIdx); // After -i for accurate sample decoding
      expect(args[ssIdx + 1]).toBe('00:00:08.200');

      expect(args[args.indexOf('-c:v') + 1]).toBe('png');
    });

    it('supports overrideTimestamp for multi-frame thumbnail extraction sequencing', () => {
      const args = buildFfmpegArguments('/nonexistent/in.mp4', '/tmp/thumb2.jpg', 'mp4', 'jpg', {
        thumbnail: {
          at: ['00:00:01.000', '00:00:05.000'],
          format: 'jpg',
        },
      }, null, '00:00:05.000');

      const ssIdx = args.indexOf('-ss');
      expect(args[ssIdx + 1]).toBe('00:00:05.000');
    });
  });

  describe('7. Differential Oracle Media Verification with FFprobe', () => {
    oracleTest('downmixes authentic 5.1 surround audio to stereo and verifies 2-channel layout via ffprobe JSON', ['ffmpeg', 'ffprobe'], async () => {
      const ffmpeg = getFfmpegPath() || 'ffmpeg';
      const ffprobe = getFfprobePath() || 'ffprobe';
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-oracle-downmix-'));

      try {
        const inputPath = path.join(tmpDir, 'source_51.wav');
        const outputPath = path.join(tmpDir, 'output_stereo.mp4');

        // Synthesize authentic 1-second 5.1 surround tone (6 audio channels: FL, FR, FC, LFE, BL, BR)
        execFileSync(ffmpeg, [
          '-y',
          '-f', 'lavfi',
          '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
          '-filter_complex', '[0:a][0:a][0:a][0:a][0:a][0:a]join=inputs=6:channel_layout=5.1[a]',
          '-map', '[a]',
          inputPath,
        ], { stdio: 'ignore' });

        // Verify input is authentic 5.1 (6 channels)
        expect(probeAudioChannels(inputPath, ffprobe as FfprobePath)).toBe(6);

        // Transcode to MP4 with ITU-R BS.775 downmix
        const inputBuf = fs.readFileSync(inputPath);
        const result = await convertMedia(inputBuf, 'wav', 'mp4', {
          audio: {
            codec: 'aac',
            downmix: 'itu-r-bs775',
          },
        }, 'test_audio.wav');

        expect(result.size).toBeGreaterThan(0);
        fs.writeFileSync(outputPath, result.buffer);

        // FFprobe verification of downmixed stereo stream
        const probeRaw = execFileSync(ffprobe, [
          '-v', 'quiet',
          '-print_format', 'json',
          '-show_streams',
          outputPath,
        ], { encoding: 'utf-8' });

        const info = JSON.parse(probeRaw);
        const audioStream = info.streams.find((s: any) => s.codec_type === 'audio');

        expect(audioStream).toBeDefined();
        expect(audioStream.channels).toBe(2);
        expect(audioStream.channel_layout).toBe('stereo');
        expect(audioStream.codec_name).toBe('aac');

        // Decoded: one second at 48 kHz (plus the AAC priming and padding), not silence. The five equal
        // channels of the 440 Hz source fold to a stereo tone far above the noise floor.
        const decoded = assertDecodedMedia(result.buffer, 'mp4', 'audio', {
          streams: { audio: 1, video: 0 },
          audio: { sampleRate: 48000, channels: 2, samplesPerChannel: 48000, toleranceSamples: AAC_PADDING_SAMPLES },
        });
        let energy = 0;
        for (let i = 0; i < decoded.audio!.pcm.length; i += 2) energy += decoded.audio!.pcm.readInt16LE(i) ** 2;
        const rms = Math.sqrt(energy / (decoded.audio!.pcm.length / 2));
        expect(rms).toBeGreaterThan(MIN_DOWNMIX_RMS);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    oracleTest('extracts thumbnail from video with exact width and validates dimensions via ffprobe JSON', ['ffmpeg', 'ffprobe'], async () => {
      const ffmpeg = getFfmpegPath() || 'ffmpeg';
      const ffprobe = getFfprobePath() || 'ffprobe';
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-oracle-thumb-'));

      try {
        const inputPath = path.join(tmpDir, 'source_vid.mp4');
        const outputPath = path.join(tmpDir, 'thumb.jpg');

        // Synthesize 2-second 640x480 video
        execFileSync(ffmpeg, [
          '-y',
          '-f', 'lavfi',
          '-i', 'testsrc2=size=640x480:rate=25:duration=2',
          '-c:v', 'libx264',
          inputPath,
        ], { stdio: 'ignore' });

        const inputBuf = fs.readFileSync(inputPath);
        const result = await convertMedia(inputBuf, 'mp4', 'jpg', {
          thumbnail: {
            at: ['00:00:01.000'],
            format: 'jpg',
            width: 320,
          },
        }, 'video.mp4');

        expect(result.size).toBeGreaterThan(0);
        expect(result.mimeType).toBe('image/jpeg');
        fs.writeFileSync(outputPath, result.buffer);

        const probeRaw = execFileSync(ffprobe, [
          '-v', 'quiet',
          '-print_format', 'json',
          '-show_streams',
          outputPath,
        ], { encoding: 'utf-8' });

        const info = JSON.parse(probeRaw);
        const imgStream = info.streams.find((s: any) => s.codec_type === 'video');

        expect(imgStream).toBeDefined();
        expect(imgStream.width).toBe(320);
        expect(imgStream.height).toBe(240); // 640x480 scaled to width 320 -> height 240
        expect(imgStream.codec_name).toBe('mjpeg');

        // Decoded: the thumbnail is the source frame at 1.000 s, scaled by ffmpeg's own filter.
        const referencePath = path.join(tmpDir, 'thumb_reference.png');
        execFileSync(ffmpeg, [
          '-y', '-ss', '00:00:01.000', '-i', inputPath, '-frames:v', '1', '-vf', 'scale=320:-2', referencePath,
        ], { stdio: 'ignore' });
        assertDecodedMedia(result.buffer, 'jpg', 'video', {
          streams: { video: 1 },
          video: { frameCount: 1, reference: { bytes: fs.readFileSync(referencePath), extension: 'png' }, minSsim: THUMBNAIL_MIN_SSIM },
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    oracleTest('embeds soft subtitles into MP4 container and verifies stream mapping via ffprobe JSON', ['ffmpeg', 'ffprobe'], async () => {
      const ffmpeg = getFfmpegPath() || 'ffmpeg';
      const ffprobe = getFfprobePath() || 'ffprobe';
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-oracle-softsub-'));

      try {
        const videoPath = path.join(tmpDir, 'video.mp4');
        const subPath = path.join(tmpDir, 'sample.srt');
        const outputPath = path.join(tmpDir, 'output_with_subs.mp4');

        // Synthesize 1-second video with audio
        execFileSync(ffmpeg, [
          '-y',
          '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=1',
          '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1',
          '-c:v', 'libx264',
          '-c:a', 'aac',
          videoPath,
        ], { stdio: 'ignore' });

        // Create standard SRT file
        const srtContent = `1\n00:00:00,100 --> 00:00:00,900\nHello EasyConvert Subtitles!\n\n`;
        fs.writeFileSync(subPath, srtContent);

        const args = buildFfmpegArguments(videoPath, outputPath, 'mp4', 'mp4', {
          disableHwaccel: true,
          subtitles: {
            mode: 'soft',
            input: subPath,
          },
        }, ffmpeg);

        execFileSync(ffmpeg, args, { stdio: 'ignore' });

        const probeRaw = execFileSync(ffprobe, [
          '-v', 'quiet',
          '-print_format', 'json',
          '-show_streams',
          outputPath,
        ], { encoding: 'utf-8' });

        const info = JSON.parse(probeRaw);
        const subStream = info.streams.find((s: any) => s.codec_type === 'subtitle');

        expect(subStream).toBeDefined();
        expect(subStream.codec_name).toBe('mov_text');

        // Decoded: every stream decodes, the picture is the source, and the cue text survives the container.
        assertDecodedMedia(fs.readFileSync(outputPath), 'mp4', 'video', {
          streams: { video: 1, audio: 1, subtitle: 1 },
          video: { frameCount: 25, reference: { bytes: fs.readFileSync(videoPath), extension: 'mp4' } },
        });
        const cueText = execFileSync(ffmpeg, ['-v', 'error', '-i', outputPath, '-map', '0:s:0', '-f', 'srt', '-'], {
          encoding: 'utf-8',
        });
        expect(cueText).toContain('Hello EasyConvert Subtitles!');
        expect(cueText).toContain('00:00:00,100 --> 00:00:00,900');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
