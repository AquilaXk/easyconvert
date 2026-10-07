import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import {
  buildHlsDashArguments,
  type PackagingSource,
  DEFAULT_PACKAGING_LADDER,
  PACKAGING_VIDEO_ENCODERS,
  PACKAGING_AUDIO_ENCODERS,
} from '../src/lib/conversions/media-ffmpeg-args';
import {
  packageHlsDashMedia,
  convertMedia,
  getFfmpegPath,
  getFfprobePath,
} from '../src/lib/conversions/media';
import { InvalidMediaOptionError, ConversionFailedError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { extractZipToTemp } from './helpers/abr-oracle';

/** Real x264/AAC encodes of the ladder: about 3.5 s of ffmpeg time on an idle machine, over two thirds of the 5 s default. */
const ENCODE_TIMEOUT_MS = 120_000;

/** A described source for the argument tests, so none of them depends on a file that happens to exist. */
const SOURCE_1080P_30FPS: PackagingSource = {
  geometry: { fpsNum: 30, fpsDen: 1, width: 1920, height: 1080, durationSec: 60 },
  hasAudio: true,
};

describe('WP-44c: Media HLS/DASH Adaptive Bitrate Packaging Engine (media.package)', () => {
  describe('1. Packaging Options Validation & Fail-Closed Gate', () => {
    it('fails closed when packaging options or format is missing', () => {
      expect(() => {
        buildHlsDashArguments('/tmp/in.mp4', '/tmp/out', null as any);
      }).toThrowError(InvalidMediaOptionError);

      expect(() => {
        buildHlsDashArguments('/tmp/in.mp4', '/tmp/out', {} as any);
      }).toThrowError(InvalidMediaOptionError);
    });

    it('fails closed when unsupported packaging format is specified', () => {
      expect(() => {
        buildHlsDashArguments('/tmp/in.mp4', '/tmp/out', {
          format: 'smoothstreaming' as any,
        });
      }).toThrowError(InvalidMediaOptionError);
    });

    it('rejects segmentSeconds outside the 2..10 range or non-integer values', () => {
      expect(() => {
        buildHlsDashArguments('/tmp/in.mp4', '/tmp/out', {
          format: 'hls',
          segmentSeconds: 1,
        });
      }).toThrowError(InvalidMediaOptionError);

      expect(() => {
        buildHlsDashArguments('/tmp/in.mp4', '/tmp/out', {
          format: 'hls',
          segmentSeconds: 11,
        });
      }).toThrowError(InvalidMediaOptionError);

      expect(() => {
        buildHlsDashArguments('/tmp/in.mp4', '/tmp/out', {
          format: 'hls',
          segmentSeconds: 3.5,
        });
      }).toThrowError(InvalidMediaOptionError);
    });

    it('accepts valid segmentSeconds within the 2..10 range', () => {
      for (const seg of [2, 4, 6, 8, 10]) {
        const args = buildHlsDashArguments('/tmp/in.mp4', '/tmp/out', {
          format: 'hls',
          segmentSeconds: seg,
        }, null, SOURCE_1080P_30FPS);
        const hlsTimeIdx = args.indexOf('-hls_time');
        expect(hlsTimeIdx).toBeGreaterThan(0);
        expect(args[hlsTimeIdx + 1]).toBe(String(seg));
      }
    });

    it('rejects empty ladder array', () => {
      expect(() => {
        buildHlsDashArguments('/tmp/in.mp4', '/tmp/out', {
          format: 'hls',
          ladder: [],
        });
      }).toThrowError(InvalidMediaOptionError);
    });

    it('rejects invalid ladder rung parameters', () => {
      // Invalid height (< 144)
      expect(() => {
        buildHlsDashArguments('/tmp/in.mp4', '/tmp/out', {
          format: 'hls',
          ladder: [{ height: 100, bitrateK: 2000 }],
        });
      }).toThrowError(InvalidMediaOptionError);

      // Invalid height (> 4320)
      expect(() => {
        buildHlsDashArguments('/tmp/in.mp4', '/tmp/out', {
          format: 'hls',
          ladder: [{ height: 5000, bitrateK: 2000 }],
        });
      }).toThrowError(InvalidMediaOptionError);

      // Invalid bitrateK (< 50)
      expect(() => {
        buildHlsDashArguments('/tmp/in.mp4', '/tmp/out', {
          format: 'hls',
          ladder: [{ height: 720, bitrateK: 20 }],
        });
      }).toThrowError(InvalidMediaOptionError);

      // Invalid fps (<= 0)
      expect(() => {
        buildHlsDashArguments('/tmp/in.mp4', '/tmp/out', {
          format: 'hls',
          ladder: [{ height: 720, bitrateK: 2000, fps: -5 }],
        });
      }).toThrowError(InvalidMediaOptionError);

      // Invalid audioBitrateK (< 16)
      expect(() => {
        buildHlsDashArguments('/tmp/in.mp4', '/tmp/out', {
          format: 'hls',
          ladder: [{ height: 720, bitrateK: 2000, audioBitrateK: 8 }],
        });
      }).toThrowError(InvalidMediaOptionError);
    });

    it('rejects unsupported video and audio codecs for ABR packaging', () => {
      expect(() => {
        buildHlsDashArguments('/tmp/in.mp4', '/tmp/out', {
          format: 'hls',
          videoCodec: 'flv' as any,
        });
      }).toThrowError(InvalidMediaOptionError);

      expect(() => {
        buildHlsDashArguments('/tmp/in.mp4', '/tmp/out', {
          format: 'hls',
          audioCodec: 'mp3' as any,
        });
      }).toThrowError(InvalidMediaOptionError);
    });
  });

  describe('2. HLS ABR Packaging Command Generation', () => {
    it('generates standard 3-rung HLS command with master playlist and segment flags', () => {
      const args = buildHlsDashArguments('/tmp/nonexistent_test_in.mp4', '/tmp/out_hls', {
        format: 'hls',
        segmentSeconds: 4,
      }, null, SOURCE_1080P_30FPS);

      // Global & Input
      expect(args[0]).toBe('-y');
      expect(args).toContain('-i');
      expect(args[args.indexOf('-i') + 1]).toBe('/tmp/nonexistent_test_in.mp4');

      // Filter complex: split=3 video and asplit=3 audio
      const fcIdx = args.indexOf('-filter_complex');
      expect(fcIdx).toBeGreaterThan(0);
      const filterComplex = args[fcIdx + 1];

      expect(filterComplex).toContain('[0:v]split=3[v_in0][v_in1][v_in2]');
      expect(filterComplex).toContain('[v_in0]scale=w=-2:h=1080[v_out0]');
      expect(filterComplex).toContain('[v_in1]scale=w=-2:h=720[v_out1]');
      expect(filterComplex).toContain('[v_in2]scale=w=-2:h=480[v_out2]');
      expect(filterComplex).toContain('[0:a]asplit=3[a_out0][a_out1][a_out2]');

      // Video streams mapping & bitrates
      expect(args).toContain('-map');
      expect(args[args.indexOf('-c:v:0') + 1]).toBe('libx264');
      expect(args[args.indexOf('-b:v:0') + 1]).toBe('4500k');
      expect(args[args.indexOf('-c:v:1') + 1]).toBe('libx264');
      expect(args[args.indexOf('-b:v:1') + 1]).toBe('2500k');
      expect(args[args.indexOf('-c:v:2') + 1]).toBe('libx264');
      expect(args[args.indexOf('-b:v:2') + 1]).toBe('1000k');

      // Audio streams mapping & bitrates
      expect(args[args.indexOf('-c:a:0') + 1]).toBe('aac');
      expect(args[args.indexOf('-b:a:0') + 1]).toBe('192k');
      expect(args[args.indexOf('-c:a:1') + 1]).toBe('aac');
      expect(args[args.indexOf('-b:a:1') + 1]).toBe('128k');
      expect(args[args.indexOf('-c:a:2') + 1]).toBe('aac');
      expect(args[args.indexOf('-b:a:2') + 1]).toBe('96k');

      // Keyframe / GOP alignment for seamless switching (30fps * 4s = 120)
      expect(args[args.indexOf('-g:v:0') + 1]).toBe('120');
      expect(args[args.indexOf('-keyint_min:v:0') + 1]).toBe('120');
      expect(args[args.indexOf('-sc_threshold:v:0') + 1]).toBe('0');

      // HLS muxer options
      expect(args[args.indexOf('-f') + 1]).toBe('hls');
      expect(args[args.indexOf('-hls_time') + 1]).toBe('4');
      expect(args[args.indexOf('-hls_playlist_type') + 1]).toBe('vod');
      expect(args[args.indexOf('-hls_flags') + 1]).toBe('independent_segments');
      expect(args[args.indexOf('-master_pl_name') + 1]).toBe('master.m3u8');

      // var_stream_map
      const vsmIdx = args.indexOf('-var_stream_map');
      expect(vsmIdx).toBeGreaterThan(0);
      expect(args[vsmIdx + 1]).toBe('v:0,a:0,name:1080p v:1,a:1,name:720p v:2,a:2,name:480p');

      // Output paths
      expect(args[args.indexOf('-hls_segment_filename') + 1]).toBe(path.join('/tmp/out_hls', 'stream_%v_%03d.ts'));
      expect(args[args.length - 1]).toBe(path.join('/tmp/out_hls', 'stream_%v.m3u8'));
    });

    it('supports custom ladder rungs and custom master playlist name', () => {
      const customLadder = [
        { height: 720, bitrateK: 2200, fps: 24, audioBitrateK: 160 },
        { height: 360, bitrateK: 600, fps: 24, audioBitrateK: 64 },
      ];

      const args = buildHlsDashArguments('/tmp/in.mp4', '/tmp/out_custom', {
        format: 'hls',
        segmentSeconds: 6,
        ladder: customLadder,
        masterPlaylistName: 'custom_index.m3u8',
        videoCodec: 'hevc',
        audioCodec: 'opus',
      }, null, SOURCE_1080P_30FPS);

      // Codecs
      expect(args[args.indexOf('-c:v:0') + 1]).toBe('libx265');
      expect(args[args.indexOf('-c:v:1') + 1]).toBe('libx265');
      expect(args[args.indexOf('-c:a:0') + 1]).toBe('libopus');
      expect(args[args.indexOf('-c:a:1') + 1]).toBe('libopus');

      // Bitrates
      expect(args[args.indexOf('-b:v:0') + 1]).toBe('2200k');
      expect(args[args.indexOf('-b:v:1') + 1]).toBe('600k');
      expect(args[args.indexOf('-b:a:0') + 1]).toBe('160k');
      expect(args[args.indexOf('-b:a:1') + 1]).toBe('64k');

      // GOP (24fps * 6s = 144)
      expect(args[args.indexOf('-g:v:0') + 1]).toBe('144');

      // Master playlist name
      expect(args[args.indexOf('-master_pl_name') + 1]).toBe('custom_index.m3u8');
      expect(args[args.indexOf('-var_stream_map') + 1]).toBe('v:0,a:0,name:720p v:1,a:1,name:360p');
    });

    it('treats h265 as an alias of hevc and still rejects prores', () => {
      const args = buildHlsDashArguments('/tmp/in.mp4', '/tmp/out_h265', {
        format: 'hls',
        videoCodec: 'h265' as any,
      }, null, SOURCE_1080P_30FPS);
      expect(args[args.indexOf('-c:v:0') + 1]).toBe('libx265');

      expect(() => {
        buildHlsDashArguments('/tmp/in.mp4', '/tmp/out', {
          format: 'hls',
          videoCodec: 'prores' as any,
        });
      }).toThrowError(InvalidMediaOptionError);
    });
  });

  describe('3. MPEG-DASH ABR Packaging Command Generation', () => {
    it('generates compliant MPEG-DASH packaging command with adaptation sets', () => {
      const args = buildHlsDashArguments('/tmp/in.mp4', '/tmp/out_dash', {
        format: 'dash',
        segmentSeconds: 4,
        videoCodec: 'h264',
        audioCodec: 'aac',
      }, null, SOURCE_1080P_30FPS);

      expect(args[args.indexOf('-f') + 1]).toBe('dash');
      expect(args[args.indexOf('-seg_duration') + 1]).toBe('4');
      expect(args[args.indexOf('-use_template') + 1]).toBe('1');
      expect(args[args.indexOf('-use_timeline') + 1]).toBe('1');

      // Init and media segment templates
      expect(args[args.indexOf('-init_seg_name') + 1]).toBe('init_$RepresentationID$.m4s');
      expect(args[args.indexOf('-media_seg_name') + 1]).toBe('chunk_$RepresentationID$_$Number%05d$.m4s');

      // Adaptation sets for video and audio
      expect(args[args.indexOf('-adaptation_sets') + 1]).toBe('id=0,streams=v id=1,streams=a');

      // Output manifest path
      expect(args[args.length - 1]).toBe(path.join('/tmp/out_dash', 'manifest.mpd'));
    });

    it('supports custom manifest name and VP9 codec for DASH', () => {
      const args = buildHlsDashArguments('/tmp/in.webm', '/tmp/out_dash2', {
        format: 'dash',
        segmentSeconds: 5,
        masterPlaylistName: 'video_manifest.mpd',
        videoCodec: 'vp9',
        audioCodec: 'opus',
        ladder: [
          { height: 1080, bitrateK: 3000 },
          { height: 540, bitrateK: 1200 },
        ],
      }, null, SOURCE_1080P_30FPS);

      expect(args[args.indexOf('-c:v:0') + 1]).toBe('libvpx-vp9');
      expect(args[args.indexOf('-c:a:0') + 1]).toBe('libopus');
      expect(args[args.indexOf('-seg_duration') + 1]).toBe('5');
      expect(args[args.length - 1]).toBe(path.join('/tmp/out_dash2', 'video_manifest.mpd'));
    });
  });

  describe('4. Worker Engine & Task Pipeline Contract Integrity', () => {
    it('guarantees media.package pipeline operation and packaging options are exported', () => {
      expect(DEFAULT_PACKAGING_LADDER.length).toBe(3);
      expect(DEFAULT_PACKAGING_LADDER[0].height).toBe(1080);
      expect(DEFAULT_PACKAGING_LADDER[1].height).toBe(720);
      expect(DEFAULT_PACKAGING_LADDER[2].height).toBe(480);

      expect(PACKAGING_VIDEO_ENCODERS.h264).toBe('libx264');
      expect(PACKAGING_VIDEO_ENCODERS.hevc).toBe('libx265');
      expect(PACKAGING_AUDIO_ENCODERS.aac).toBe('aac');
      expect(PACKAGING_AUDIO_ENCODERS.opus).toBe('libopus');
    });
  });

  describe('5. Differential Oracle Packaging Verification with FFmpeg & FFprobe', () => {
    oracleTest('packages authentic video into HLS multi-bitrate ZIP bundle and verifies manifest & segment chunk structure', ['ffmpeg', 'ffprobe'], async () => {
      const ffmpeg = getFfmpegPath() || 'ffmpeg';
      const ffprobe = getFfprobePath() || 'ffprobe';
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-oracle-hls-'));

      try {
        const inputPath = path.join(tmpDir, 'source_test.mp4');

        // Synthesize authentic 4-second video with synchronized audio
        execFileSync(ffmpeg, [
          '-y',
          '-f', 'lavfi',
          '-i', 'testsrc=duration=4:size=1280x720:rate=30',
          '-f', 'lavfi',
          '-i', 'sine=frequency=1000:sample_rate=48000:duration=4',
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          inputPath,
        ], { stdio: 'ignore' });

        const inputBuf = fs.readFileSync(inputPath);
        expect(inputBuf.length).toBeGreaterThan(1000);

        // Package into HLS via convertMedia with custom 2-rung ladder and 2s segments
        const result = await convertMedia(inputBuf, 'mp4', 'zip', {
          packaging: {
            format: 'hls',
            segmentSeconds: 2,
            masterPlaylistName: 'master.m3u8',
            ladder: [
              { height: 720, bitrateK: 1500, audioBitrateK: 128 },
              { height: 360, bitrateK: 500, audioBitrateK: 64 },
            ],
          },
        }, 'test_video.mp4');

        expect(result.mimeType).toBe('application/zip');
        expect(result.filename).toBe('test_video-hls.zip');
        expect(result.size).toBeGreaterThan(5000);
        expect(result.parts).toBeDefined();

        // Inspect ZIP contents via JSZip
        const zip = await JSZip.loadAsync(result.buffer);
        const fileNames = Object.keys(zip.files);

        // Master playlist must be present
        expect(fileNames).toContain('master.m3u8');
        const masterContent = await zip.files['master.m3u8'].async('text');

        // Assert HLS master playlist spec compliance:
        // Must start with #EXTM3U
        expect(masterContent.startsWith('#EXTM3U')).toBe(true);
        // Must contain stream info for both rungs
        const streamInfMatches = masterContent.match(/#EXT-X-STREAM-INF:/g);
        expect(streamInfMatches).not.toBeNull();
        expect(streamInfMatches!.length).toBe(2);

        // Variant playlists must be present
        expect(fileNames).toContain('stream_720p.m3u8');
        expect(fileNames).toContain('stream_360p.m3u8');

        // Verify variant playlist content
        const variant720Content = await zip.files['stream_720p.m3u8'].async('text');
        expect(variant720Content).toContain('#EXTM3U');
        expect(variant720Content).toContain('#EXT-X-TARGETDURATION:');
        expect(variant720Content).toContain('#EXTINF:');

        // Verify segment chunks exist and have non-zero bytes
        const tsSegments = fileNames.filter(f => f.endsWith('.ts'));
        expect(tsSegments.length).toBeGreaterThanOrEqual(2);

        for (const seg of tsSegments) {
          const segBuf = await zip.files[seg].async('nodebuffer');
          expect(segBuf.length).toBeGreaterThan(100);

          // Verify segment duration with ffprobe
          const segPath = path.join(tmpDir, seg);
          fs.writeFileSync(segPath, segBuf);
          const probeOut = execFileSync(ffprobe, [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            segPath,
          ], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

          const dur = Number.parseFloat(probeOut);
          expect(Number.isFinite(dur)).toBe(true);
          // 2-second segments: should be between 0.5 and 3.0 seconds
          expect(dur).toBeGreaterThan(0.5);
          expect(dur).toBeLessThanOrEqual(3.0);
        }

        // Decoded: each rung plays through its whole playlist with no decode error and holds the 4 s clip.
        const extracted = await extractZipToTemp(result.buffer);
        try {
          for (const playlist of ['stream_720p.m3u8', 'stream_360p.m3u8']) {
            const decodeLog = execFileSync(
              ffmpeg,
              ['-v', 'error', '-xerror', '-i', path.join(extracted, playlist), '-map', '0:v:0', '-f', 'framemd5', '-'],
              { encoding: 'utf-8' }
            );
            const frames = decodeLog.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
            expect(frames).toHaveLength(4 * 30);
          }
        } finally {
          fs.rmSync(extracted, { recursive: true, force: true });
        }
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    }, ENCODE_TIMEOUT_MS);

    oracleTest('packages authentic video into MPEG-DASH multi-bitrate ZIP bundle and verifies XML MPD manifest & init/media chunks', ['ffmpeg', 'ffprobe'], async () => {
      const ffmpeg = getFfmpegPath() || 'ffmpeg';
      const ffprobe = getFfprobePath() || 'ffprobe';
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-oracle-dash-'));

      try {
        const inputPath = path.join(tmpDir, 'source_test_dash.mp4');

        // Synthesize authentic 4-second video with audio
        execFileSync(ffmpeg, [
          '-y',
          '-f', 'lavfi',
          '-i', 'testsrc=duration=4:size=1280x720:rate=30',
          '-f', 'lavfi',
          '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          inputPath,
        ], { stdio: 'ignore' });

        const inputBuf = fs.readFileSync(inputPath);

        // Package into MPEG-DASH via convertMedia
        const result = await convertMedia(inputBuf, 'mp4', 'dash', {
          packaging: {
            format: 'dash',
            segmentSeconds: 2,
            masterPlaylistName: 'manifest.mpd',
            ladder: [
              { height: 720, bitrateK: 1800 },
              { height: 480, bitrateK: 800 },
            ],
          },
        }, 'test_dash.mp4');

        expect(result.mimeType).toBe('application/zip');
        expect(result.filename).toBe('test_dash-dash.zip');
        expect(result.size).toBeGreaterThan(5000);

        // Inspect ZIP contents via JSZip
        const zip = await JSZip.loadAsync(result.buffer);
        const fileNames = Object.keys(zip.files);

        // Manifest must be present
        expect(fileNames).toContain('manifest.mpd');
        const mpdContent = await zip.files['manifest.mpd'].async('text');

        // Validate XML schema structure
        expect(mpdContent).toContain('<MPD');
        expect(mpdContent).toContain('profiles="urn:mpeg:dash:profile:isoff-live:2011"');
        expect(mpdContent).toContain('<Period');
        expect(mpdContent).toContain('<AdaptationSet');
        expect(mpdContent).toContain('contentType="video"');
        expect(mpdContent).toContain('<Representation');

        // Representations count should match ladder
        const repMatches = mpdContent.match(/<Representation/g);
        expect(repMatches).not.toBeNull();
        expect(repMatches!.length).toBeGreaterThanOrEqual(2);

        // Check init segments and chunk segments
        const initSegments = fileNames.filter(f => f.startsWith('init_') && f.endsWith('.m4s'));
        expect(initSegments.length).toBeGreaterThanOrEqual(1);

        const chunkSegments = fileNames.filter(f => f.startsWith('chunk_') && f.endsWith('.m4s'));
        expect(chunkSegments.length).toBeGreaterThanOrEqual(2);

        for (const seg of initSegments) {
          const segBuf = await zip.files[seg].async('nodebuffer');
          expect(segBuf.length).toBeGreaterThan(50);
        }

        // Decoded: the manifest plays end to end, both video rungs and the audio, with no decode error.
        const extracted = await extractZipToTemp(result.buffer);
        try {
          const frameLines = execFileSync(
            ffmpeg,
            ['-v', 'error', '-xerror', '-i', path.join(extracted, 'manifest.mpd'), '-map', '0:v:0', '-f', 'framemd5', '-'],
            { encoding: 'utf-8' }
          )
            .split('\n')
            .filter((line) => line !== '' && !line.startsWith('#'));
          expect(frameLines).toHaveLength(4 * 30);
          execFileSync(ffmpeg, ['-v', 'error', '-xerror', '-i', path.join(extracted, 'manifest.mpd'), '-map', '0:a:0', '-f', 'null', '-']);
        } finally {
          fs.rmSync(extracted, { recursive: true, force: true });
        }
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    }, ENCODE_TIMEOUT_MS);
  });
});
