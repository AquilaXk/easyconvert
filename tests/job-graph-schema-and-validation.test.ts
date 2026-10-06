import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  validateGraph,
  assertValidGraph,
  GraphValidationError,
  linearTasksToGraph,
  type JobGraph,
} from '@/lib/queue/graph';
import { POST as createJobHandler } from '@/app/api/v1/jobs/route';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { redisUserStore } from '@/lib/auth/redis-user-store';
import { s3Storage } from '@/lib/storage/s3-storage';
import type { ApiKeyScope } from '@/lib/api-keys/types';

async function createTestUserWithKey(opts: {
  userId?: string;
  scopes?: ApiKeyScope[];
  tier?: 'free' | 'pro' | 'enterprise';
} = {}) {
  const userId = opts.userId || `user_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const user = await redisUserStore.createUser({
    id: userId,
    email: `${userId}@example.com`,
    name: `Test User ${userId}`,
    tier: opts.tier || 'pro',
    provider: 'email',
    passwordHash: 'dummy_hash',
    salt: 'dummy_salt',
  });
  const key = await redisKeyStore.generateApiKey(user.id, `Key for ${user.id}`, {
    scopes: opts.scopes || ['convert:write', 'convert:read'],
  });
  return { user, key };
}

describe('WP-30: Job Graph Schema, Kahn Topological Sort, Validation & Linear Adapter', () => {
  beforeEach(() => {
    redisKeyStore.resetStore();
    redisUserStore.resetStore();
    vi.restoreAllMocks();
  });

  describe('1. Cycle Detection & Path Tracing (Kahn + DFS Cycle Tracer)', () => {
    it('detects and rejects direct 2-node cycle (A -> B -> A) reporting the exact cycle path', () => {
      const graph: JobGraph = {
        nodes: {
          src: { op: 'import.upload', storageKey: 'uploads/file.csv' },
          step_a: { op: 'convert', input: 'step_b', targetFormat: 'json' },
          step_b: { op: 'convert', input: 'step_a', targetFormat: 'yaml' },
          out: { op: 'export.internal', input: 'step_b' },
        },
      };

      const result = validateGraph(graph);
      expect(result.valid).toBe(false);
      const cycleError = result.errors.find((e) => e.code === 'CYCLE_DETECTED');
      expect(cycleError).toBeDefined();
      expect(cycleError?.message).toMatch(/Cycle detected in job graph: (step_a -> step_b -> step_a|step_b -> step_a -> step_b)/);
    });

    it('detects and rejects multi-node cycle (A -> B -> C -> A) reporting cycle loop', () => {
      const graph: JobGraph = {
        nodes: {
          src: { op: 'import.upload', storageKey: 'uploads/doc.pdf' },
          step_a: { op: 'convert', input: 'step_c', targetFormat: 'png' },
          step_b: { op: 'convert', input: 'step_a', targetFormat: 'jpg' },
          step_c: { op: 'convert', input: 'step_b', targetFormat: 'webp' },
          out: { op: 'export.internal', input: 'step_c' },
        },
      };

      const result = validateGraph(graph);
      expect(result.valid).toBe(false);
      const cycleError = result.errors.find((e) => e.code === 'CYCLE_DETECTED');
      expect(cycleError).toBeDefined();
      expect(cycleError?.message).toContain('step_a');
      expect(cycleError?.message).toContain('step_b');
      expect(cycleError?.message).toContain('step_c');
    });

    it('detects self-loop cycle (A -> A)', () => {
      const graph: JobGraph = {
        nodes: {
          src: { op: 'import.upload', storageKey: 'uploads/doc.pdf' },
          step_self: { op: 'convert', input: 'step_self', targetFormat: 'png' },
          out: { op: 'export.internal', input: 'step_self' },
        },
      };

      const result = validateGraph(graph);
      expect(result.valid).toBe(false);
      const selfError = result.errors.find((e) => e.code === 'SELF_CYCLE_DETECTED');
      expect(selfError).toBeDefined();
      expect(selfError?.message).toContain('Cycle detected: step_self -> step_self');
    });
  });

  describe('2. Input Reference Integrity & Node ID Grammar', () => {
    it('rejects references to non-existent input nodes with NON_EXISTENT_INPUT', () => {
      const graph: JobGraph = {
        nodes: {
          src: { op: 'import.upload', storageKey: 'uploads/data.csv' },
          step_1: { op: 'convert', input: 'phantom_node_404', targetFormat: 'json' },
          out: { op: 'export.internal', input: 'step_1' },
        },
      };

      const result = validateGraph(graph);
      expect(result.valid).toBe(false);
      const notFoundErr = result.errors.find((e) => e.code === 'NON_EXISTENT_INPUT');
      expect(notFoundErr).toBeDefined();
      expect(notFoundErr?.message).toContain('phantom_node_404');
    });

    it('rejects invalid nodeId naming format violating ^[a-z][a-z0-9_-]{0,63}$', () => {
      const graph: JobGraph = {
        nodes: {
          '123_invalid_start_with_number': { op: 'import.upload', storageKey: 'uploads/f.csv' },
          'INVALID_UPPERCASE': { op: 'convert', input: '123_invalid_start_with_number', targetFormat: 'json' },
          out: { op: 'export.internal', input: 'INVALID_UPPERCASE' },
        },
      };

      const result = validateGraph(graph);
      expect(result.valid).toBe(false);
      const invalidIdErrors = result.errors.filter((e) => e.code === 'INVALID_NODE_ID');
      expect(invalidIdErrors.length).toBeGreaterThanOrEqual(2);
    });

    it('rejects export node being referenced as input to other processing nodes', () => {
      const graph: JobGraph = {
        nodes: {
          src: { op: 'import.upload', storageKey: 'uploads/f.csv' },
          out_1: { op: 'export.internal', input: 'src' },
          illegal_step: { op: 'convert', input: 'out_1', targetFormat: 'json' },
          out_2: { op: 'export.internal', input: 'illegal_step' },
        },
      };

      const result = validateGraph(graph);
      expect(result.valid).toBe(false);
      const exportInputErr = result.errors.find((e) => e.code === 'EXPORT_USED_AS_INPUT');
      expect(exportInputErr).toBeDefined();
      expect(exportInputErr?.message).toContain('cannot use terminal export node "out_1" as an input');
    });
  });

  describe('3. Fan-out & Graph Depth Boundaries', () => {
    it('enforces single-node fan-out <= 16 ceiling (17 child branches rejected)', () => {
      const nodes: JobGraph['nodes'] = {
        src: { op: 'import.upload', storageKey: 'uploads/archive.zip' },
        extract_root: { op: 'archive.extract', input: 'src' },
      };

      // Create 17 downstream convert nodes connected to extract_root
      for (let i = 1; i <= 17; i++) {
        nodes[`branch_${i}`] = { op: 'convert', input: 'extract_root', targetFormat: 'pdf' };
      }

      nodes.out = {
        op: 'archive.create',
        input: Array.from({ length: 17 }, (_, i) => `branch_${i + 1}`),
        targetFormat: 'zip',
      };
      nodes.final_export = { op: 'export.internal', input: 'out' };

      const result = validateGraph({ nodes });
      expect(result.valid).toBe(false);
      const fanOutErr = result.errors.find((e) => e.code === 'FAN_OUT_LIMIT_EXCEEDED');
      expect(fanOutErr).toBeDefined();
      expect(fanOutErr?.message).toContain('Single node fan-out exceeds limit of 16');
      expect(fanOutErr?.message).toContain('node "extract_root" has 17 outgoing connections');
    });

    it('accepts exact boundary single-node fan-out of 16', () => {
      const nodes: JobGraph['nodes'] = {
        src: { op: 'import.upload', storageKey: 'uploads/archive.zip' },
        extract_root: { op: 'archive.extract', input: 'src' },
      };

      for (let i = 1; i <= 16; i++) {
        nodes[`branch_${i}`] = { op: 'convert', input: 'extract_root', targetFormat: 'pdf' };
      }

      nodes.out = {
        op: 'archive.create',
        input: Array.from({ length: 16 }, (_, i) => `branch_${i + 1}`),
        targetFormat: 'zip',
      };
      nodes.final_export = { op: 'export.internal', input: 'out' };

      const result = validateGraph({ nodes });
      if (!result.valid) console.error(result.errors);
      if (!result.valid) console.log(JSON.stringify(result.errors, null, 2));
      expect(result.valid).toBe(true);
    });

    it('enforces graph depth <= 8 ceiling (depth 9 rejected)', () => {
      // Build a sequential chain of 9 nodes: import -> c1 -> c2 -> c3 -> c4 -> c5 -> c6 -> c7 -> export (depth 9)
      const nodes: JobGraph['nodes'] = {
        n1: { op: 'import.upload', storageKey: 'uploads/data.csv' },
        n2: { op: 'convert', input: 'n1', targetFormat: 'json' },
        n3: { op: 'convert', input: 'n2', targetFormat: 'yaml' },
        n4: { op: 'convert', input: 'n3', targetFormat: 'json' },
        n5: { op: 'convert', input: 'n4', targetFormat: 'yaml' },
        n6: { op: 'convert', input: 'n5', targetFormat: 'json' },
        n7: { op: 'convert', input: 'n6', targetFormat: 'yaml' },
        n8: { op: 'convert', input: 'n7', targetFormat: 'json' },
        n9: { op: 'export.internal', input: 'n8' },
      };

      const result = validateGraph({ nodes });
      expect(result.valid).toBe(false);
      const depthErr = result.errors.find((e) => e.code === 'DEPTH_LIMIT_EXCEEDED');
      expect(depthErr).toBeDefined();
      expect(depthErr?.message).toContain('Graph depth exceeds limit of 8 (found depth 9)');
    });

    it('accepts exact boundary graph depth of 8', () => {
      // 8 sequential nodes: n1(depth 1) -> n2(2) -> n3(3) -> n4(4) -> n5(5) -> n6(6) -> n7(7) -> n8(8)
      const nodes: JobGraph['nodes'] = {
        n1: { op: 'import.upload', storageKey: 'uploads/data.csv' },
        n2: { op: 'convert', input: 'n1', targetFormat: 'json' },
        n3: { op: 'convert', input: 'n2', targetFormat: 'yaml' },
        n4: { op: 'convert', input: 'n3', targetFormat: 'json' },
        n5: { op: 'convert', input: 'n4', targetFormat: 'yaml' },
        n6: { op: 'convert', input: 'n5', targetFormat: 'json' },
        n7: { op: 'convert', input: 'n6', targetFormat: 'yaml' },
        n8: { op: 'export.internal', input: 'n7' },
      };

      const result = validateGraph({ nodes });
      if (!result.valid) console.log(JSON.stringify(result.errors, null, 2));
      expect(result.valid).toBe(true);
      expect(result.depth).toBe(8);
    });
  });

  describe('4. Tier-Specific Node Ceilings', () => {
    it('rejects free tier graphs exceeding 8 nodes (9 nodes rejected)', () => {
      const nodes: JobGraph['nodes'] = {
        import_src: { op: 'import.upload', storageKey: 'uploads/doc.pdf' },
      };
      for (let i = 1; i <= 7; i++) {
        nodes[`step_${i}`] = { op: 'convert', targetFormat: 'pdf', input: i === 1 ? 'import_src' : `step_${i - 1}` };
      }
      nodes.out = { op: 'export.internal', input: 'step_7' }; // Total 9 nodes

      const result = validateGraph({ nodes }, { userTier: 'free' });
      expect(result.valid).toBe(false);
      const limitErr = result.errors.find((e) => e.code === 'GRAPH_NODE_LIMIT_EXCEEDED');
      expect(limitErr).toBeDefined();
      expect(limitErr?.message).toContain('allowed limit of 8 for tier "free"');
    });

    it('accepts free tier graph with exactly 8 nodes', () => {
      const nodes: JobGraph['nodes'] = {
        import_src: { op: 'import.upload', storageKey: 'uploads/doc.pdf' },
      };
      for (let i = 1; i <= 6; i++) {
        nodes[`step_${i}`] = { op: 'metadata', input: i === 1 ? 'import_src' : `step_${i - 1}` };
      }
      nodes.out = { op: 'export.internal', input: 'step_6' }; // Total 8 nodes

      const result = validateGraph({ nodes }, { userTier: 'free' });
      if (!result.valid) console.log(JSON.stringify(result.errors, null, 2));
      expect(result.valid).toBe(true);
    });
  });

  describe('5. Format Compatibility Verification', () => {
    it('detects and rejects incompatible format transitions (e.g. mp3 -> docx)', () => {
      const graph: JobGraph = {
        nodes: {
          src: { op: 'import.upload', storageKey: 'audio/sample.mp3' },
          invalid_conv: { op: 'convert', input: 'src', targetFormat: 'docx' },
          out: { op: 'export.internal', input: 'invalid_conv' },
        },
      };

      const result = validateGraph(graph, { sourceFormat: 'mp3' });
      expect(result.valid).toBe(false);
      const formatErr = result.errors.find((e) => e.code === 'INCOMPATIBLE_FORMAT_CONVERSION');
      expect(formatErr).toBeDefined();
      expect(formatErr?.message).toContain('Incompatible conversion from "mp3" to "docx"');
      expect(formatErr?.message).toContain('between node "src" and node "invalid_conv"');
    });

    it('accepts fully compatible multi-stage conversion graph (csv -> json -> yaml)', () => {
      const graph: JobGraph = {
        nodes: {
          src: { op: 'import.upload', storageKey: 'data/records.csv' },
          to_json: { op: 'convert', input: 'src', targetFormat: 'json' },
          to_yaml: { op: 'convert', input: 'to_json', targetFormat: 'yaml' },
          out: { op: 'export.internal', input: 'to_yaml' },
        },
      };

      const result = validateGraph(graph, { sourceFormat: 'csv' });
      if (!result.valid) console.log(JSON.stringify(result.errors, null, 2));
      expect(result.valid).toBe(true);
      expect(result.topologicalOrder).toEqual(['src', 'to_json', 'to_yaml', 'out']);
    });

    it('supports fan-in archive.create bundling multiple parallel image renders into zip', () => {
      const graph: JobGraph = {
        nodes: {
          src: { op: 'import.upload', storageKey: 'slides/presentation.pdf' },
          render_png: { op: 'convert', input: 'src', targetFormat: 'png' },
          render_jpg: { op: 'convert', input: 'src', targetFormat: 'jpg' },
          render_txt: { op: 'convert', input: 'src', targetFormat: 'txt' },
          bundle_zip: {
            op: 'archive.create',
            input: ['render_png', 'render_jpg', 'render_txt'],
            targetFormat: 'zip',
          },
          out: { op: 'export.internal', input: 'bundle_zip' },
        },
      };

      const result = validateGraph(graph, { sourceFormat: 'pdf' });
      if (!result.valid) console.log(JSON.stringify(result.errors, null, 2));
      expect(result.valid).toBe(true);
      expect(result.topologicalOrder).toContain('src');
      expect(result.topologicalOrder?.indexOf('bundle_zip')).toBeGreaterThan(result.topologicalOrder?.indexOf('render_png')!);
      expect(result.topologicalOrder?.indexOf('bundle_zip')).toBeGreaterThan(result.topologicalOrder?.indexOf('render_jpg')!);
      expect(result.topologicalOrder?.indexOf('bundle_zip')).toBeGreaterThan(result.topologicalOrder?.indexOf('render_txt')!);
      expect(result.topologicalOrder?.indexOf('out')).toBeGreaterThan(result.topologicalOrder?.indexOf('bundle_zip')!);
    });
  });

  describe('6. Linear Tasks to Graph Adapter (Backward Compatibility)', () => {
    it('converts sequential tasks into DAG whose topological order matches the original array order', () => {
      const tasks = [
        { name: 'csv-to-json', operation: 'convert' as const, targetFormat: 'json' },
        { name: 'json-to-yaml', operation: 'convert' as const, targetFormat: 'yaml' },
        { name: 'compress', operation: 'archive' as const, targetFormat: 'zip' },
      ];

      const graph = linearTasksToGraph(
        { storageKey: 'uploads/inventory.csv', sourceFormat: 'csv', filename: 'inventory.csv' },
        tasks
      );

      expect(graph.nodes.import_source).toBeDefined();
      expect(graph.nodes.task_1_convert).toBeDefined();
      expect(graph.nodes.task_2_convert).toBeDefined();
      expect(graph.nodes.task_3_archive).toBeDefined();
      expect(graph.nodes.export_terminal).toBeDefined();

      const validation = validateGraph(graph, { sourceFormat: 'csv' });
      expect(validation.valid).toBe(true);
      expect(validation.topologicalOrder).toEqual([
        'import_source',
        'task_1_convert',
        'task_2_convert',
        'task_3_archive',
        'export_terminal',
      ]);
    });
  });

  describe('7. API Integration (POST /api/v1/jobs)', () => {
    it('accepts valid JobGraph in POST /api/v1/jobs, enqueueing job with graph and returning 202', async () => {
      const { user, key } = await createTestUserWithKey({ tier: 'pro' });

      // Staging object in S3
      const fakeCsv = Buffer.from('id,name\n1,Alice\n2,Bob');
      const staged = s3Storage.saveObject(`uploads/${user.id}/data.csv`, fakeCsv, 'text/csv', 'data.csv', 3600000);

      const jobGraph: JobGraph = {
        nodes: {
          in_data: { op: 'import.upload', storageKey: staged.key },
          stage_json: { op: 'convert', input: 'in_data', targetFormat: 'json' },
          stage_yaml: { op: 'convert', input: 'stage_json', targetFormat: 'yaml' },
          out_result: { op: 'export.internal', input: 'stage_yaml' },
        },
      };

      const req = new NextRequest('https://easyconvert.app/api/v1/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key.secretKey}`,
        },
        body: JSON.stringify({
          filename: 'data.csv',
          graph: jobGraph,
        }),
      });

      const res = await createJobHandler(req);
      expect(res.status).toBe(202);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.jobId).toBeDefined();
      expect(json.graph).toBeDefined();
      expect(json.graph.nodes.in_data).toBeDefined();
      expect(json.graph.nodes.stage_yaml.targetFormat).toBe('yaml');
    });

    it('rejects cyclic JobGraph with 422 Unprocessable Entity and detailed problem details', async () => {
      const { user, key } = await createTestUserWithKey({ tier: 'pro' });

      const fakeCsv = Buffer.from('id,val\n1,100');
      const staged = s3Storage.saveObject(`uploads/${user.id}/cyclic.csv`, fakeCsv, 'text/csv', 'cyclic.csv', 3600000);

      const cyclicGraph: JobGraph = {
        nodes: {
          src: { op: 'import.upload', storageKey: staged.key },
          node_a: { op: 'convert', input: 'node_b', targetFormat: 'json' },
          node_b: { op: 'convert', input: 'node_a', targetFormat: 'yaml' },
          out: { op: 'export.internal', input: 'node_b' },
        },
      };

      const req = new NextRequest('https://easyconvert.app/api/v1/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key.secretKey}`,
        },
        body: JSON.stringify({
          filename: 'cyclic.csv',
          graph: cyclicGraph,
        }),
      });

      const res = await createJobHandler(req);
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.status).toBe(422);
      expect(json.detail).toContain('Graph validation failed');
      expect(json.detail).toContain('Cycle detected in job graph');
    });

    it('rejects graph with incompatible conversion with 422 Unprocessable Entity', async () => {
      const { user, key } = await createTestUserWithKey({ tier: 'pro' });

      const fakeMp3 = Buffer.from('RIFF1234WAVEfmt ');
      const staged = s3Storage.saveObject(`uploads/${user.id}/song.mp3`, fakeMp3, 'audio/mpeg', 'song.mp3', 3600000);

      const incompatibleGraph: JobGraph = {
        nodes: {
          src: { op: 'import.upload', storageKey: staged.key },
          step_bad: { op: 'convert', input: 'src', targetFormat: 'docx' },
          out: { op: 'export.internal', input: 'step_bad' },
        },
      };

      const req = new NextRequest('https://easyconvert.app/api/v1/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key.secretKey}`,
        },
        body: JSON.stringify({
          filename: 'song.mp3',
          graph: incompatibleGraph,
        }),
      });

      const res = await createJobHandler(req);
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.status).toBe(422);
      expect(json.detail).toContain('Incompatible conversion from "mp3" to "docx"');
    });
  });
});
