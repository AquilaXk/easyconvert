import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  S3ObjectStorageService,
  s3Storage,
} from '../src/lib/storage/s3-storage';
import {
  getUnshareCapability,
  resolveSandboxedCommand,
  buildUnshareIsolationArgs,
  generateSeccompBpfProfile,
  DANGEROUS_SYSCALL_FILTER_LIST,
} from '../src/lib/security/process-sandbox';
import {
  isOpfsStreamingSupported,
  SUPPORTED_OPFS_STREAMING_CONVERSIONS,
} from '../src/lib/edge/tier-router';
import { collectOutput } from '../src/lib/edge/workers/chunk-transformer';
import { resolveChunkTransformer } from '../src/lib/edge/workers/opfs-vfs.worker';
import { craftWav } from './helpers/wav-craft';
import { oracleTest } from './helpers/oracle-test';
import { readUnshareOptionMeanings } from './helpers/unshare-help';

describe('Phase 3 Zero-Heap Storage, Sandbox & OPFS Streaming Testnet', () => {
  // ==========================================================================
  // 1. Zero-Heap S3 / R2 Multipart Storage Engine
  // ==========================================================================
  describe('Zero-Heap S3 / R2 Storage Engine (Component 3.1)', () => {
    it('manages zero-heap multipart upload sessions with disk-backed parts', () => {
      const storage = new S3ObjectStorageService();
      const filename = 'large-video-recording.mp4';
      const mimeType = 'video/mp4';
      const totalSize = 100 * 1024 * 1024; // 100 MB

      // 1. Initiate multipart upload
      const init = storage.initiateMultipartUpload(filename, mimeType, totalSize);
      expect(init.uploadId).toMatch(/^oci_mp_/);
      expect(init.key).toContain('large-video-recording.mp4');
      expect(init.partSize).toBeGreaterThan(0);
      expect(init.totalParts).toBeGreaterThan(0);

      // 2. Upload chunks with zero-heap disk backing
      const chunk1 = Buffer.from('Zero-Heap chunk 1 streaming bytes from network.');
      const chunk2 = Buffer.from('Zero-Heap chunk 2 streaming bytes from network.');
      const part1 = storage.uploadPart(init.uploadId, 1, chunk1);
      const part2 = storage.uploadPart(init.uploadId, 2, chunk2);

      expect(part1.partNumber).toBe(1);
      expect(part1.size).toBe(chunk1.length);
      expect(part1.etag).toBeDefined();

      expect(part2.partNumber).toBe(2);
      expect(part2.size).toBe(chunk2.length);
      expect(part2.etag).toBeDefined();

      // 3. Complete multipart upload
      const complete = storage.completeMultipartUpload(init.uploadId);
      expect(complete.key).toBe(init.key);
      expect(complete.size).toBe(chunk1.length + chunk2.length);
      expect(complete.etag).toContain('-2"'); // S3 multipart ETag format

      // 4. Retrieve stored object
      const retrieved = storage.getObject(complete.key);
      expect(retrieved).toBeDefined();
      expect(retrieved?.filename).toBe(filename);
      expect(retrieved?.buffer.toString('utf-8')).toBe(
        'Zero-Heap chunk 1 streaming bytes from network.Zero-Heap chunk 2 streaming bytes from network.'
      );

      // 5. Delete object
      const deleted = storage.deleteObject(complete.key);
      expect(deleted).toBe(true);
      expect(storage.getObject(complete.key)).toBeUndefined();

      storage.stopGc();
    });

    it('generates SigV4 presigned upload URLs that this application verifies, and no download URLs', () => {
      const storage = new S3ObjectStorageService({ signingSecret: 'phase-3-s3-local-signing-secret-0001' });
      const key = 'uploads/test-image.png';

      // Upload presigned URL
      const presignedUpload = storage.generatePresignedUploadUrl(key, 1, 's3_upload_123', 900);
      expect(presignedUpload.url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
      expect(presignedUpload.url).toContain('X-Amz-Credential');
      expect(presignedUpload.url).toContain('X-Amz-Date');
      expect(presignedUpload.url).toContain('X-Amz-Expires=900');
      expect(presignedUpload.url).toContain('X-Amz-Signature');
      expect(presignedUpload.url).toContain('partNumber=1');
      expect(presignedUpload.url).toContain('uploadId=s3_upload_123');

      // The signature checks out under the application's signing secret, and only under it
      const verified = storage.verifySigV4Url(presignedUpload.url, 'PUT');
      expect(verified.valid).toBe(true);
      expect(verified.queryParams?.uploadId).toBe('s3_upload_123');
      const stranger = new S3ObjectStorageService({ signingSecret: 'another-signing-secret-for-the-stranger' });
      expect(stranger.verifySigV4Url(presignedUpload.url, 'PUT').valid).toBe(false);
      stranger.stopGc();

      // Local storage has no object-store host that could verify a download URL, so it mints none
      expect((storage as { generatePresignedDownloadUrl?: unknown }).generatePresignedDownloadUrl).toBeUndefined();

      // A capability signature is not valid after its expiry
      expect(
        storage.verifyPresignedSignature(
          'PUT',
          key,
          Date.now() - 1000,
          presignedUpload.signature,
          's3_upload_123',
          1
        )
      ).toBe(false);

      storage.stopGc();
    });

    it('cleans up temporary disk directories on abort and sweeps expired sessions', () => {
      const storage = new S3ObjectStorageService();
      const init = storage.initiateMultipartUpload('temp.bin', 'application/octet-stream', 1024);
      storage.uploadPart(init.uploadId, 1, Buffer.from('data'));

      const aborted = storage.abortMultipartUpload(init.uploadId);
      expect(aborted).toBe(true);
      expect(() => storage.completeMultipartUpload(init.uploadId)).toThrow();

      // Sweeping expired objects
      const swept = storage.sweepExpiredObjects(Date.now() + 48 * 60 * 60 * 1000);
      expect(typeof swept).toBe('number');

      storage.stopGc();
    });
  });

  // ==========================================================================
  // 2. Enterprise Linux Process Sandbox
  // ==========================================================================
  describe('Enterprise Linux Process Sandbox (Component 3.2)', () => {
    it('probes Linux unshare capability and supports multi-namespace isolation', () => {
      const cap = getUnshareCapability();
      expect(typeof cap.available).toBe('boolean');
      expect(typeof cap.path).toBe('string');
      expect(Array.isArray(cap.args)).toBe(true);
      expect(typeof cap.supportsNetNamespace).toBe('boolean');
    });

    it('assembles unshare isolation arguments with mount, IPC, and PID flags', () => {
      const mockCap = {
        available: true,
        path: '/usr/bin/unshare',
        args: ['-r', '-n'],
      };

      const fullArgs = buildUnshareIsolationArgs(mockCap, {
        mountNamespace: true,
        ipcNamespace: true,
        pidNamespace: true,
      });

      // Arguments the capability already carries are kept as they are and never repeated.
      expect(fullArgs).toEqual(['-r', '-n', '-m', '-i', '-p', '--fork']);
      expect(buildUnshareIsolationArgs(mockCap, { netNamespace: true, userNamespace: true })).toEqual(['-r', '-n']);
    });

    oracleTest('keeps every unshare option it builds inside what util-linux unshare documents', ['unshare'], () => {
      const meanings = readUnshareOptionMeanings();
      const built = buildUnshareIsolationArgs(
        { available: true, path: '/usr/bin/unshare', args: [] },
        { userNamespace: true, netNamespace: true, mountNamespace: true, ipcNamespace: true, pidNamespace: true }
      );
      expect(built).toEqual(['-r', '-n', '-m', '-i', '-p', '--fork']);
      for (const option of built) {
        expect(meanings.has(option), `unshare --help does not list ${option}`).toBe(true);
      }
    });

    it('generates defensive Seccomp BPF syscall filter profiles', () => {
      const profile = generateSeccompBpfProfile();
      expect(profile.defaultAction).toBe('SCMP_ACT_ALLOW');
      expect(profile.killAction).toBe('SCMP_ACT_ERRNO');
      expect(profile.blockedSyscalls).toContain('ptrace');
      expect(profile.blockedSyscalls).toContain('bpf');
      expect(profile.blockedSyscalls).toContain('mount');
      expect(profile.blockedSyscalls).toContain('reboot');
      expect(profile.blockedSyscalls).toEqual(DANGEROUS_SYSCALL_FILTER_LIST);
    });

    it('resolves sandboxed commands with full options dictionary', () => {
      const res = resolveSandboxedCommand('/usr/bin/ffmpeg', ['-version'], {
        networkIsolated: true,
        sandboxOptions: {
          mountNamespace: true,
          pidNamespace: true,
        },
      });

      expect(res.binary).toBeDefined();
      if (res.wrapped) {
        expect(res.args).toContain('/usr/bin/ffmpeg');
        expect(res.args).toContain('-version');
      } else {
        expect(res.binary).toBe('/usr/bin/ffmpeg');
        expect(res.args).toEqual(['-version']);
      }
    });
  });

  // ==========================================================================
  // 3. Expanded Level 3 OPFS Streaming Pipeline
  // ==========================================================================
  describe('Expanded L3 OPFS Streaming Pipeline (Component 3.3)', () => {
    const PCM_FORMAT = { sampleRate: 48000, channels: 2, bitDepth: 16 };

    it('supports media and archive streaming conversions in OPFS tier whitelist', () => {
      expect(isOpfsStreamingSupported('wav', 'pcm')).toBe(true);
      expect(isOpfsStreamingSupported('wav', 'adpcm')).toBe(true);
      expect(isOpfsStreamingSupported('adpcm', 'pcm')).toBe(true);
      expect(isOpfsStreamingSupported('adpcm', 'wav')).toBe(true);
      expect(isOpfsStreamingSupported('tar', 'tar_gz')).toBe(true);
      expect(isOpfsStreamingSupported('tar', 'gz')).toBe(true);
      expect(isOpfsStreamingSupported('gz', 'tar')).toBe(true);
      // Raw PCM says nothing about itself, so it is streamed only when the options describe it.
      expect(isOpfsStreamingSupported('pcm', 'wav')).toBe(false);
      expect(isOpfsStreamingSupported('pcm', 'adpcm')).toBe(false);
      expect(isOpfsStreamingSupported('pcm', 'wav', PCM_FORMAT)).toBe(true);
      expect(isOpfsStreamingSupported('pcm', 'adpcm', PCM_FORMAT)).toBe(true);
    });

    it('streams WAV to raw PCM from the data chunk when the first window ends inside the audio', async () => {
      const audio = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const wav = craftWav({ sampleRate: 8000, channels: 1, bitsPerSample: 16, data: audio });
      expect(wav.length).toBe(44 + 8);
      const transformer = resolveChunkTransformer('wav', 'pcm');

      // The first window holds the 44-byte header and the first four audio bytes.
      const out1 = await collectOutput(transformer(wav.subarray(0, 48), 0, wav.length));
      expect(Array.from(out1)).toEqual([1, 2, 3, 4]);
      // The next window is audio only.
      const out2 = await collectOutput(transformer(wav.subarray(48), 48, wav.length));
      expect(Array.from(out2)).toEqual([5, 6, 7, 8]);
    });

    it('streams raw PCM to WAV with a header that states the whole input, written with the first window', async () => {
      const transformer = resolveChunkTransformer('pcm', 'wav', PCM_FORMAT);
      const pcm = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);

      const out1 = await collectOutput(transformer(pcm.subarray(0, 4), 0, pcm.length));
      expect(out1.byteLength).toBe(44 + 4);
      expect(String.fromCharCode(...out1.subarray(0, 4))).toBe('RIFF');
      const view = new DataView(out1.buffer, out1.byteOffset);
      expect(view.getUint32(4, true)).toBe(36 + 8);
      expect(view.getUint32(24, true)).toBe(48000);
      expect(view.getUint16(22, true)).toBe(2);
      expect(view.getUint32(40, true)).toBe(8);
      expect(Array.from(out1.subarray(44))).toEqual([10, 20, 30, 40]);

      const out2 = await collectOutput(transformer(pcm.subarray(4), 4, pcm.length));
      expect(Array.from(out2)).toEqual([50, 60, 70, 80]);
    });
  });
});
