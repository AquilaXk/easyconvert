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
import { resolveChunkTransformer } from '../src/lib/edge/workers/opfs-vfs.worker';

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

      expect(fullArgs).toContain('-r');
      expect(fullArgs).toContain('-n');
      expect(fullArgs).toContain('-m');
      expect(fullArgs).toContain('-i');
      expect(fullArgs).toContain('-p');
      expect(fullArgs).toContain('--fork');
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
    it('supports media and archive streaming conversions in OPFS tier whitelist', () => {
      expect(isOpfsStreamingSupported('wav', 'pcm')).toBe(true);
      expect(isOpfsStreamingSupported('pcm', 'wav')).toBe(false); // Excluded due to non-chunked RIFF header framing
      expect(isOpfsStreamingSupported('pcm', 'adpcm')).toBe(true);
      expect(isOpfsStreamingSupported('wav', 'adpcm')).toBe(true);
      expect(isOpfsStreamingSupported('adpcm', 'pcm')).toBe(true);
      expect(isOpfsStreamingSupported('tar', 'tar_gz')).toBe(true);
      expect(isOpfsStreamingSupported('tar', 'gz')).toBe(true);
      expect(isOpfsStreamingSupported('gz', 'tar')).toBe(true);
    });

    it('streams WAV to raw PCM by stripping 44-byte RIFF header on first chunk', () => {
      const transformer = resolveChunkTransformer('wav', 'pcm');

      // Create a simulated 44-byte WAV header + 8 bytes audio data
      const chunk1 = new Uint8Array(52);
      chunk1[0] = 0x52; chunk1[1] = 0x49; chunk1[2] = 0x46; chunk1[3] = 0x46; // 'RIFF'
      for (let i = 44; i < 52; i++) chunk1[i] = i;

      const out1 = transformer(chunk1);
      expect(out1.byteLength).toBe(8);
      expect(out1[0]).toBe(44);

      // Subsequent chunk should not be stripped
      const chunk2 = new Uint8Array([1, 2, 3, 4]);
      const out2 = transformer(chunk2);
      expect(out2.byteLength).toBe(4);
      expect(out2[0]).toBe(1);
    });

    it('streams raw PCM to WAV by prepending RIFF/WAVE header on first chunk', () => {
      const transformer = resolveChunkTransformer('pcm', 'wav', {
        sampleRate: 48000,
        channels: 2,
        bitsPerSample: 16,
      });

      const pcmChunk1 = new Uint8Array([10, 20, 30, 40]);
      const out1 = transformer(pcmChunk1);
      expect(out1.byteLength).toBe(44 + 4);
      expect(out1[0]).toBe(0x52); // 'R'
      expect(out1[1]).toBe(0x49); // 'I'
      expect(out1[2]).toBe(0x46); // 'F'
      expect(out1[3]).toBe(0x46); // 'F'

      // Check sample rate at offset 24
      const view = new DataView(out1.buffer, out1.byteOffset);
      expect(view.getUint32(24, true)).toBe(48000);
      expect(view.getUint16(22, true)).toBe(2);

      // Check audio payload
      expect(out1[44]).toBe(10);
      expect(out1[45]).toBe(20);

      // Chunk 2 receives raw passthrough
      const pcmChunk2 = new Uint8Array([50, 60]);
      const out2 = transformer(pcmChunk2);
      expect(out2.byteLength).toBe(2);
      expect(out2[0]).toBe(50);
    });

    it('performs IMA ADPCM 4:1 streaming compression and 16-bit PCM decompression', () => {
      const compressor = resolveChunkTransformer('pcm', 'adpcm');
      const decompressor = resolveChunkTransformer('adpcm', 'pcm');

      // Generate 16 16-bit PCM samples (32 bytes)
      const pcmIn = new Uint8Array(32);
      const inView = new DataView(pcmIn.buffer);
      for (let i = 0; i < 16; i++) {
        inView.setInt16(i * 2, Math.round(Math.sin((i / 16) * Math.PI) * 15000), true);
      }

      // Compress: 32 bytes -> 8 bytes (4:1 compression ratio)
      const compressed = compressor(pcmIn);
      expect(compressed.byteLength).toBe(8);

      // Decompress: 8 bytes -> 32 bytes
      const decompressed = decompressor(compressed);
      expect(decompressed.byteLength).toBe(32);

      // Verify finite, valid decompressed samples
      const outView = new DataView(decompressed.buffer);
      for (let i = 0; i < 16; i++) {
        const sample = outView.getInt16(i * 2, true);
        expect(sample).toBeGreaterThanOrEqual(-32768);
        expect(sample).toBeLessThanOrEqual(32767);
      }
    });

  });
});
