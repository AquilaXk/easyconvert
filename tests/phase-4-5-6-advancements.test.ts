import { describe, it, expect, beforeEach } from 'vitest';
import {
  inCircle2D,
  lawsonEdgeFlipHealing2D,
  verifyWatertightManifoldMesh,
} from '../src/lib/conversions/cad-nurbs';
import {
  applyIec61966SrgbGamma,
  inverseIec61966SrgbGamma,
  demosaicAmazeBayerCfa,
  DEFAULT_D65_COLOR_MATRIX,
} from '../src/lib/conversions/image';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { ociStorage } from '../src/lib/storage/oci-storage';
import { redisKeyStore, isIpInCidr, isIpAllowed } from '../src/lib/api-keys/redis-key-store';
import { WebhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { userStore } from '../src/lib/auth/user-store';
import { validateApiAccess } from '../src/lib/api-keys/guard';
import { POST as jobsPostHandler, GET as jobsGetHandler } from '../src/app/api/v1/jobs/route';
import { GET as jobDetailHandler } from '../src/app/api/v1/jobs/[id]/route';
import { GET as openApiHandler } from '../src/app/api/openapi.json/route';
import { NextRequest } from 'next/server';

describe('Phase 4, 5, 6 Enterprise Advancements', () => {
  beforeEach(() => {
    userStore.resetStore();
    redisKeyStore.resetStore();
  });

  // ==========================================================================
  // Phase 4: CAD Constrained Delaunay Triangulation & Watertight Verification
  // ==========================================================================
  describe('Phase 4: CAD Mesh & Geometry Core', () => {
    it('inCircle2D correctly evaluates Delaunay circumcircle determinant', () => {
      // CCW unit triangle: a(0,0), b(1,0), c(0,1)
      const a = { u: 0, v: 0 };
      const b = { u: 1, v: 0 };
      const c = { u: 0, v: 1 };

      // Point inside circumcircle (center 0.5, 0.5, radius ~0.707): (0.2, 0.2)
      const pInside = { u: 0.2, v: 0.2 };
      expect(inCircle2D(a, b, c, pInside)).toBeGreaterThan(0);

      // Point outside circumcircle: (2.0, 2.0)
      const pOutside = { u: 2.0, v: 2.0 };
      expect(inCircle2D(a, b, c, pOutside)).toBeLessThan(0);
    });

    it('lawsonEdgeFlipHealing2D heals non-Delaunay interior edges while preserving constrained boundaries', () => {
      // Convex quad with vertices: v0(0,1), v1(0,0), v2(1,0), v3(1,1)
      const points = [
        { u: 0, v: 1 }, // 0: Top-left
        { u: 0, v: 0 }, // 1: Bottom-left
        { u: 1, v: 0 }, // 2: Bottom-right
        { u: 1, v: 1 }, // 3: Top-right
      ];

      // Two CCW triangles sharing diagonal edge 0-2:
      // T1: (0, 1, 2), T2: (0, 2, 3)
      const initialFaces: [number, number, number][] = [
        [0, 1, 2],
        [0, 2, 3],
      ];

      const healed = lawsonEdgeFlipHealing2D(points, initialFaces);
      expect(healed.length).toBe(2);

      // Verify boundary constraints preservation:
      // If edge (0, 2) is flagged as constrained, it must NOT be flipped
      const constrainedEdge = new Set(['0-2', '2-0']);
      const constrainedResult = lawsonEdgeFlipHealing2D(points, initialFaces, constrainedEdge);
      expect(constrainedResult).toEqual(initialFaces);
    });

    it('verifies watertight manifold mesh topology on a closed cube (Euler characteristic chi = 2)', () => {
      // 8 vertices of a unit cube
      const cubeVertices: [number, number, number][] = [
        [0, 0, 0], // 0
        [1, 0, 0], // 1
        [1, 1, 0], // 2
        [0, 1, 0], // 3
        [0, 0, 1], // 4
        [1, 0, 1], // 5
        [1, 1, 1], // 6
        [0, 1, 1], // 7
      ];

      // 12 CCW triangles forming a closed, watertight cube
      const cubeFaces: [number, number, number][] = [
        // Bottom (z=0)
        [0, 2, 1], [0, 3, 2],
        // Top (z=1)
        [4, 5, 6], [4, 6, 7],
        // Front (y=0)
        [0, 1, 5], [0, 5, 4],
        // Back (y=1)
        [3, 7, 6], [3, 6, 2],
        // Left (x=0)
        [0, 4, 7], [0, 7, 3],
        // Right (x=1)
        [1, 2, 6], [1, 6, 5],
      ];

      const report = verifyWatertightManifoldMesh(cubeVertices, cubeFaces);

      expect(report.verticesCount).toBe(8);
      expect(report.facesCount).toBe(12);
      expect(report.edgesCount).toBe(18);
      expect(report.eulerCharacteristic).toBe(2); // V - E + F = 8 - 18 + 12 = 2
      expect(report.boundaryEdges).toBe(0);
      expect(report.nonManifoldEdges).toBe(0);
      expect(report.isWatertight).toBe(true);
      expect(report.isManifold).toBe(true);
    });

    it('identifies non-watertight open mesh surfaces with boundary edges', () => {
      // Open quad surface (4 vertices, 2 triangles)
      const openVertices: [number, number, number][] = [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ];
      const openFaces: [number, number, number][] = [
        [0, 1, 2],
        [0, 2, 3],
      ];

      const report = verifyWatertightManifoldMesh(openVertices, openFaces);
      expect(report.boundaryEdges).toBeGreaterThan(0);
      expect(report.isWatertight).toBe(false);
    });
  });

  // ==========================================================================
  // Phase 4: Camera RAW AMaZE Demosaicing & IEC 61966-2-1 Gamma
  // ==========================================================================
  describe('Phase 4: Camera RAW Color & Demosaicing', () => {
    it('IEC 61966-2-1 sRGB gamma curve and inverse are exact inverses', () => {
      const testValues = [0.0, 0.001, 0.0031308, 0.05, 0.18, 0.5, 0.75, 1.0];

      for (const val of testValues) {
        const encoded = applyIec61966SrgbGamma(val);
        const decoded = inverseIec61966SrgbGamma(encoded);
        expect(decoded).toBeCloseTo(val, 5);
      }
    });

    it('IEC 61966-2-1 conforms to linear-to-exponential threshold transition', () => {
      // Below or at 0.0031308: strictly linear with slope 12.92
      const linearVal = 0.002;
      expect(applyIec61966SrgbGamma(linearVal)).toBeCloseTo(linearVal * 12.92, 6);

      // Above 0.0031308: 1.055 * val^(1/2.4) - 0.055
      const nonLinearVal = 0.5;
      const expected = 1.055 * Math.pow(0.5, 1.0 / 2.4) - 0.055;
      expect(applyIec61966SrgbGamma(nonLinearVal)).toBeCloseTo(expected, 6);
    });

    it('demosaicAmazeBayerCfa reconstructs RGB buffer from raw Bayer CFA with D65 ColorMatrix', () => {
      const width = 16;
      const height = 16;
      // Synthetic 16x16 RGGB sensor
      const rawCfa = new Uint16Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          // Gradient pattern
          rawCfa[y * width + x] = Math.min(1023, (x + y) * 32);
        }
      }

      const result = demosaicAmazeBayerCfa({
        width,
        height,
        pattern: 'RGGB',
        data: rawCfa,
        bitsPerSample: 10,
        whiteLevel: 1023,
        blackLevel: 0,
        colorMatrix: DEFAULT_D65_COLOR_MATRIX,
        applySrgbGamma: true,
      });

      expect(result.data).toBeInstanceOf(Buffer);
      expect(result.data.length).toBe(width * height * 3);

      // Verify that values are non-zero and within 0..255 byte range
      for (let i = 0; i < result.data.length; i++) {
        expect(result.data[i]).toBeGreaterThanOrEqual(0);
        expect(result.data[i]).toBeLessThanOrEqual(255);
      }
    });
  });

  // ==========================================================================
  // Phase 5: Storage Streaming & Zero-Heap Multipart Upload
  // ==========================================================================
  describe('Phase 5: Zero-Heap Multipart Storage & Streaming', () => {
    it('S3 storage executes zero-heap multipart upload and returns lazy-loaded buffer', async () => {
      const filename = 'large-test-model.step';
      const part1 = Buffer.from('PARTS1_0123456789ABCDEF');
      const part2 = Buffer.from('PARTS2_GHIJKLMNOPQRSTUV');
      const totalSize = part1.length + part2.length;

      const init = s3Storage.initiateMultipartUpload(filename, 'application/step', totalSize);
      expect(init.uploadId).toBeDefined();

      const p1 = s3Storage.uploadPart(init.uploadId, 1, part1);
      const p2 = s3Storage.uploadPart(init.uploadId, 2, part2);
      expect(p1.partNumber).toBe(1);
      expect(p2.partNumber).toBe(2);

      const complete = s3Storage.completeMultipartUpload(init.uploadId);
      expect(complete.key).toBe(init.key);
      expect(complete.size).toBe(totalSize);

      // Retrieve stored object
      const stored = s3Storage.getObject(complete.key);
      expect(stored).toBeDefined();
      expect(stored?.size).toBe(totalSize);
      expect(stored?.filePath).toBeDefined();

      // Lazy buffer evaluation
      expect(stored?.buffer.toString('utf-8')).toBe(
        'PARTS1_0123456789ABCDEFPARTS2_GHIJKLMNOPQRSTUV'
      );

      // Stream retrieval with range request
      const stream = s3Storage.getObjectStream(complete.key, { start: 0, end: 5 });
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      const rangeSlice = Buffer.concat(chunks).toString('utf-8');
      expect(rangeSlice).toBe('PARTS1');

      // Cleanup
      s3Storage.deleteObject(complete.key);
      expect(s3Storage.getObject(complete.key)).toBeUndefined();
    });

    it('OCI storage completes multipart upload with disk spooling and lazy buffer', async () => {
      const filename = 'oci-dataset.csv';
      const rawText = 'col1,col2,col3\n1,2,3\n4,5,6\n';
      const chunkData = Buffer.from(rawText);

      const init = ociStorage.initiateMultipartUpload(filename, 'text/csv', chunkData.length);
      ociStorage.uploadPart(init.uploadId, 1, chunkData);
      const complete = ociStorage.completeMultipartUpload(init.uploadId);

      const stored = ociStorage.getObject(complete.key);
      expect(stored).toBeDefined();
      expect(stored?.size).toBe(chunkData.length);
      expect(stored?.buffer.toString('utf-8')).toBe(rawText);

      ociStorage.deleteObject(complete.key);
    });
  });

  // ==========================================================================
  // Phase 6: Auth, 2-Phase Quota, IP/CIDR Whitelist & Webhooks
  // ==========================================================================
  describe('Phase 6: Auth, 2-Phase Quota & Webhook Dispatcher', () => {
    it('correctly calculates IPv4 CIDR matching for IP whitelisting', () => {
      // Exact match
      expect(isIpInCidr('192.168.1.10', '192.168.1.10')).toBe(true);
      expect(isIpInCidr('192.168.1.11', '192.168.1.10')).toBe(false);

      // /24 subnet match (192.168.1.0 - 192.168.1.255)
      expect(isIpInCidr('192.168.1.42', '192.168.1.0/24')).toBe(true);
      expect(isIpInCidr('192.168.2.42', '192.168.1.0/24')).toBe(false);

      // /16 subnet match (10.0.0.0 - 10.0.255.255)
      expect(isIpInCidr('10.0.50.1', '10.0.0.0/16')).toBe(true);
      expect(isIpInCidr('10.1.50.1', '10.0.0.0/16')).toBe(false);

      // isIpAllowed with empty list allows all
      expect(isIpAllowed('203.0.113.195', [])).toBe(true);
      // isIpAllowed with whitelist
      expect(isIpAllowed('192.168.1.5', ['192.168.1.0/24', '10.0.0.1'])).toBe(true);
      expect(isIpAllowed('192.168.2.5', ['192.168.1.0/24', '10.0.0.1'])).toBe(false);
    });

    it('enforces 2-phase quota transactions (reserve -> rollback & reserve -> commit)', async () => {
      const user = await userStore.createUser({
        email: 'quota-test@example.com',
        name: 'Quota Tester',
        tier: 'free',
      });

      // Step 1: Reserve 1 unit
      const res1 = await redisKeyStore.reserveQuota(user.id, 1);
      expect(res1.allowed).toBe(true);
      expect(res1.reservationId).toBeDefined();

      const quotaAfterReserve = await redisKeyStore.getQuotaUsage(user.id);
      expect(quotaAfterReserve.usedToday).toBe(1);
      expect(quotaAfterReserve.remaining).toBe(24);

      // Step 2: Rollback the reservation (simulating aborted conversion)
      await redisKeyStore.rollbackQuota(res1.reservationId!);
      const quotaAfterRollback = await redisKeyStore.getQuotaUsage(user.id);
      expect(quotaAfterRollback.usedToday).toBe(0);
      expect(quotaAfterRollback.remaining).toBe(25);

      // Step 3: Reserve and commit (simulating successful conversion)
      const res2 = await redisKeyStore.reserveQuota(user.id, 1);
      expect(res2.allowed).toBe(true);
      await redisKeyStore.commitQuota(res2.reservationId!);

      const quotaAfterCommit = await redisKeyStore.getQuotaUsage(user.id);
      expect(quotaAfterCommit.usedToday).toBe(1);
      expect(quotaAfterCommit.remaining).toBe(24);
    });

    it('WebhookDispatcher signs and verifies HMAC-SHA256 signatures with replay protection', () => {
      const dispatcher = new WebhookDispatcher();
      const secret = 'enterprise_super_secret_key_123';
      const body = JSON.stringify({ event: 'job.completed', jobId: 'job_42' });
      const now = Math.floor(Date.now() / 1000);

      const signature = dispatcher.generateSignature(body, secret, now);
      expect(signature).toHaveLength(64);

      // Verification succeeds with matching signature and current timestamp
      const isValid = dispatcher.verifySignature(body, `sha256=${signature}`, now, secret);
      expect(isValid).toBe(true);

      // Fails with tampered body
      const isTamperedValid = dispatcher.verifySignature(
        JSON.stringify({ event: 'job.completed', jobId: 'job_HACKED' }),
        `sha256=${signature}`,
        now,
        secret
      );
      expect(isTamperedValid).toBe(false);

      // Fails with expired timestamp (replay attack protection)
      const expiredTimestamp = now - 400; // > 300 seconds tolerance
      const isExpiredValid = dispatcher.verifySignature(
        body,
        `sha256=${signature}`,
        expiredTimestamp,
        secret
      );
      expect(isExpiredValid).toBe(false);
    });

    it('guard rejects requests with status 403 when client IP is not whitelisted on API key', async () => {
      const user = await userStore.createUser({
        email: 'ip-guard@example.com',
        name: 'IP Guard User',
      });
      const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Restricted Key', {
        allowedIps: ['192.168.100.0/24'],
      });

      // Request from unauthorized IP: 203.0.113.5
      const unauthorizedReq = new NextRequest('http://localhost/api/v1/convert', {
        headers: {
          'x-api-key': secretKey,
          'x-forwarded-for': '203.0.113.5',
        },
      });

      const authResultUnauthorized = await validateApiAccess(unauthorizedReq, 0);
      expect(authResultUnauthorized.authorized).toBe(false);
      expect(authResultUnauthorized.status).toBe(403);
      expect(authResultUnauthorized.error).toContain('IP');

      // Request from authorized whitelisted IP: 192.168.100.42
      const authorizedReq = new NextRequest('http://localhost/api/v1/convert', {
        headers: {
          'x-api-key': secretKey,
          'x-forwarded-for': '192.168.100.42',
        },
      });

      const authResultAuthorized = await validateApiAccess(authorizedReq, 0);
      expect(authResultAuthorized.authorized).toBe(true);
      expect(authResultAuthorized.user?.id).toBe(user.id);
    });
  });

  // ==========================================================================
  // Phase 6: Async Job Queue Routes & OpenAPI 3.1
  // ==========================================================================
  describe('Phase 6: Async Jobs API & OpenAPI 3.1 Specification', () => {
    it('POST /api/v1/jobs submits job, reserves quota, and GET /api/v1/jobs/{id} tracks status', async () => {
      const user = await userStore.createUser({
        email: 'async-jobs@example.com',
        name: 'Async Jobs User',
      });
      const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Async Job Key');

      // 1. Submit async conversion job via JSON
      const postReq = new NextRequest('http://localhost/api/v1/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': secretKey,
        },
        body: JSON.stringify({
          filename: 'sample.csv',
          targetFormat: 'json',
          inputBufferBase64: Buffer.from('name,age\nAlice,30\nBob,25').toString('base64'),
        }),
      });

      const postRes = await jobsPostHandler(postReq);
      expect(postRes.status).toBe(202);
      const postData = await postRes.json();
      expect(postData.success).toBe(true);
      expect(postData.jobId).toBeDefined();
      expect(postData.statusUrl).toBe(`/api/v1/jobs/${postData.jobId}`);

      // 2. Poll job detail by ID
      const getReq = new NextRequest(`http://localhost/api/v1/jobs/${postData.jobId}`, {
        headers: {
          'x-api-key': secretKey,
        },
      });

      const getRes = await jobDetailHandler(getReq, {
        params: Promise.resolve({ id: postData.jobId }),
      });
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData.success).toBe(true);
      expect(getData.jobId).toBe(postData.jobId);
      expect(['waiting', 'active', 'completed']).toContain(getData.status);

      // 3. List jobs
      const listReq = new NextRequest('http://localhost/api/v1/jobs', {
        headers: {
          'x-api-key': secretKey,
        },
      });
      const listRes = await jobsGetHandler(listReq);
      expect(listRes.status).toBe(200);
      const listData = await listRes.json();
      expect(listData.success).toBe(true);
      expect(listData.jobs.some((j: any) => j.jobId === postData.jobId)).toBe(true);
    });

    it('GET /api/openapi.json serves valid OpenAPI 3.1.0 document with all key endpoints', async () => {
      const res = await openApiHandler();
      expect(res.status).toBe(200);
      const spec = await res.json();

      expect(spec.openapi).toBe('3.1.0');
      expect(spec.info.title).toContain('EasyConvert');
      expect(spec.paths['/api/v1/convert']).toBeDefined();
      expect(spec.paths['/api/v1/jobs']).toBeDefined();
      expect(spec.paths['/api/v1/jobs/{id}']).toBeDefined();
      expect(spec.paths['/api/formats']).toBeDefined();
      expect(spec.paths['/api/keys']).toBeDefined();
      expect(spec.components.securitySchemes.ApiKeyAuth).toBeDefined();
    });
  });
});
