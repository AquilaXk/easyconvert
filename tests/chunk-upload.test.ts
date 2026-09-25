import { describe, it, expect } from 'vitest';
import { s3Storage } from '../src/lib/storage/s3-storage';

describe('S3 Chunked Multipart Upload Engine', () => {
  it('handles full lifecycle: initiate, upload parts, commit and retrieve object', () => {
    const filename = 'large-dataset.bin';
    const mimeType = 'application/octet-stream';
    const totalSize = 12 * 1024 * 1024; // 12 MB

    // 1. Initiate multipart upload
    const init = s3Storage.initiateMultipartUpload(filename, mimeType, totalSize);
    expect(init.uploadId).toMatch(/^oci_mp_/);
    expect(init.key).toContain('large-dataset.bin');
    expect(init.partSize).toBeGreaterThan(0);
    expect(init.totalParts).toBeGreaterThan(0);

    // 2. Upload chunk parts
    const part1Data = Buffer.from('Part 1 content data block for testing chunk uploads.');
    const part2Data = Buffer.from('Part 2 content data block for testing chunk uploads.');
    const part1 = s3Storage.uploadPart(init.uploadId, 1, part1Data);
    const part2 = s3Storage.uploadPart(init.uploadId, 2, part2Data);

    expect(part1.partNumber).toBe(1);
    expect(part1.etag).toBeDefined();
    expect(part1.size).toBe(part1Data.length);

    expect(part2.partNumber).toBe(2);
    expect(part2.etag).toBeDefined();
    expect(part2.size).toBe(part2Data.length);

    // 3. Complete multipart upload
    const complete = s3Storage.completeMultipartUpload(init.uploadId);
    expect(complete.key).toBe(init.key);
    expect(complete.size).toBe(part1Data.length + part2Data.length);
    expect(complete.etag).toBeDefined();

    // 4. Retrieve stored object
    const stored = s3Storage.getObject(complete.key);
    expect(stored).toBeDefined();
    expect(stored?.filename).toBe(filename);
    expect(stored?.buffer.toString('utf-8')).toBe(
      'Part 1 content data block for testing chunk uploads.Part 2 content data block for testing chunk uploads.'
    );

    // 5. Cleanup
    const deleted = s3Storage.deleteObject(complete.key);
    expect(deleted).toBe(true);
    expect(s3Storage.getObject(complete.key)).toBeUndefined();
  });

  it('handles aborting a multipart upload session', () => {
    const init = s3Storage.initiateMultipartUpload('abort-target.dat', 'application/octet-stream', 1024);
    s3Storage.uploadPart(init.uploadId, 1, Buffer.from('chunk data'));

    const aborted = s3Storage.abortMultipartUpload(init.uploadId);
    expect(aborted).toBe(true);

    // Attempting to complete aborted upload should throw
    expect(() => s3Storage.completeMultipartUpload(init.uploadId)).toThrow();
  });

  it('fails closed on invalid part numbers or non-existent sessions', () => {
    expect(() => {
      s3Storage.uploadPart('non-existent-session-id', 1, Buffer.from('data'));
    }).toThrow(/Invalid or expired/);

    const init = s3Storage.initiateMultipartUpload('bounds-test.dat', 'application/octet-stream', 1024);
    expect(() => {
      s3Storage.uploadPart(init.uploadId, 0, Buffer.from('data'));
    }).toThrow(/Invalid OCI partNumber/);

    expect(() => {
      s3Storage.uploadPart(init.uploadId, 10001, Buffer.from('data'));
    }).toThrow(/Invalid OCI partNumber/);

    s3Storage.abortMultipartUpload(init.uploadId);
  });
});
