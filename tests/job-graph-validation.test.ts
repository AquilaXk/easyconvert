import { describe, it, expect } from 'vitest';
import {
  validateJobGraph,
  assertValidJobGraph,
  JobGraphValidationError,
  linearTasksToJobGraph,
  type JobGraph,
} from '@/lib/jobs/graph';
import type { PipelineTask } from '@/lib/types';

describe('WP-30 / Phase 3-B: Job Graph Specification & Kahn Topological Validation', () => {
  describe('1. Cycle Detection & Path Tracing (Kahn + DFS Cycle Tracer)', () => {
    it('detects and rejects direct 2-node cycle (A -> B -> A) reporting the exact cycle path', () => {
      const graph: JobGraph = {
        nodes: {
          src: { id: 'src', operation: 'import.upload', storageKey: 'uploads/file.csv' },
          step_a: { id: 'step_a', operation: 'convert', dependencies: ['step_b'], targetFormat: 'json' },
          step_b: { id: 'step_b', operation: 'convert', dependencies: ['step_a'], targetFormat: 'yaml' },
          out: { id: 'out', operation: 'export.internal', dependencies: ['step_b'] },
        },
      };

      const result = validateJobGraph(graph);
      expect(result.valid).toBe(false);
      const cycleError = result.errors.find((e) => e.code === 'CYCLE_DETECTED');
      expect(cycleError).toBeDefined();
      expect(cycleError?.message).toMatch(/Cycle detected in job graph: (step_a -> step_b -> step_a|step_b -> step_a -> step_b)/);
    });

    it('detects and rejects multi-node cycle (A -> B -> C -> A) reporting cycle loop', () => {
      const graph: JobGraph = {
        nodes: {
          src: { id: 'src', operation: 'import.upload', storageKey: 'uploads/doc.pdf' },
          step_a: { id: 'step_a', operation: 'convert', dependencies: ['step_c'], targetFormat: 'png' },
          step_b: { id: 'step_b', operation: 'convert', dependencies: ['step_a'], targetFormat: 'jpg' },
          step_c: { id: 'step_c', operation: 'convert', dependencies: ['step_b'], targetFormat: 'webp' },
          out: { id: 'out', operation: 'export.internal', dependencies: ['step_c'] },
        },
      };

      const result = validateJobGraph(graph);
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
          src: { id: 'src', operation: 'import.upload', storageKey: 'uploads/doc.pdf' },
          step_self: { id: 'step_self', operation: 'convert', dependencies: ['step_self'], targetFormat: 'png' },
          out: { id: 'out', operation: 'export.internal', dependencies: ['step_self'] },
        },
      };

      const result = validateJobGraph(graph);
      expect(result.valid).toBe(false);
      const selfError = result.errors.find((e) => e.code === 'SELF_CYCLE_DETECTED');
      expect(selfError).toBeDefined();
      expect(selfError?.message).toContain('Cycle detected: step_self -> step_self');
    });

    it('assertValidJobGraph throws JobGraphValidationError when cycle is present', () => {
      const graph: JobGraph = {
        nodes: {
          src: { id: 'src', operation: 'import.upload', storageKey: 'uploads/doc.pdf' },
          loop_a: { id: 'loop_a', operation: 'convert', dependencies: ['loop_b'], targetFormat: 'png' },
          loop_b: { id: 'loop_b', operation: 'convert', dependencies: ['loop_a'], targetFormat: 'jpg' },
          out: { id: 'out', operation: 'export.internal', dependencies: ['loop_b'] },
        },
      };

      expect(() => assertValidJobGraph(graph)).toThrowError(JobGraphValidationError);
    });
  });

  describe('2. Input Reference Integrity & Dangling Dependency Rejection', () => {
    it('rejects references to non-existent input nodes with NON_EXISTENT_INPUT', () => {
      const graph: JobGraph = {
        nodes: {
          src: { id: 'src', operation: 'import.upload', storageKey: 'uploads/doc.pdf' },
          convert_step: { id: 'convert_step', operation: 'convert', dependencies: ['non_existent_node'], targetFormat: 'png' },
          out: { id: 'out', operation: 'export.internal', dependencies: ['convert_step'] },
        },
      };

      const result = validateJobGraph(graph);
      expect(result.valid).toBe(false);
      const notFoundError = result.errors.find((e) => e.code === 'NON_EXISTENT_INPUT');
      expect(notFoundError).toBeDefined();
      expect(notFoundError?.message).toContain('references non-existent input node "non_existent_node"');
    });

    it('rejects using terminal export nodes as input to downstream operations', () => {
      const graph: JobGraph = {
        nodes: {
          src: { id: 'src', operation: 'import.upload', storageKey: 'uploads/doc.pdf' },
          out_first: { id: 'out_first', operation: 'export.internal', dependencies: ['src'] },
          step_after_export: { id: 'step_after_export', operation: 'convert', dependencies: ['out_first'], targetFormat: 'png' },
          out_final: { id: 'out_final', operation: 'export.internal', dependencies: ['step_after_export'] },
        },
      };

      const result = validateJobGraph(graph);
      expect(result.valid).toBe(false);
      const exportInputErr = result.errors.find((e) => e.code === 'EXPORT_USED_AS_INPUT');
      expect(exportInputErr).toBeDefined();
      expect(exportInputErr?.message).toContain('cannot use terminal export node "out_first" as an input');
    });
  });

  describe('3. Node Limits, Fan-In Caps, Fan-Out Caps, and Depth Caps', () => {
    it('enforces tier node count limits for free tier (max 8 nodes)', () => {
      const nodes: JobGraph['nodes'] = {
        src: { id: 'src', operation: 'import.upload', storageKey: 'uploads/doc.pdf' },
      };

      for (let i = 1; i <= 8; i++) {
        const prev = i === 1 ? 'src' : `step_${i - 1}`;
        nodes[`step_${i}`] = {
          id: `step_${i}`,
          operation: 'convert',
          dependencies: [prev],
          targetFormat: 'png',
        };
      }
      nodes['out'] = { id: 'out', operation: 'export.internal', dependencies: ['step_8'] };

      const result = validateJobGraph({ nodes }, { userTier: 'free' });
      expect(result.valid).toBe(false);
      const limitErr = result.errors.find((e) => e.code === 'GRAPH_NODE_LIMIT_EXCEEDED');
      expect(limitErr).toBeDefined();
      expect(limitErr?.message).toContain('exceeds the allowed limit of 8 for tier "free"');
    });

    it('enforces fan-in limit (maximum 16 incoming dependencies per task)', () => {
      const nodes: JobGraph['nodes'] = {
        src: { id: 'src', operation: 'import.upload', storageKey: 'uploads/doc.pdf' },
      };

      const upstreamIds: string[] = [];
      for (let i = 1; i <= 17; i++) {
        const id = `branch_${i}`;
        nodes[id] = { id, operation: 'convert', dependencies: ['src'], targetFormat: 'png' };
        upstreamIds.push(id);
      }

      nodes['bundle'] = {
        id: 'bundle',
        operation: 'archive/create',
        dependencies: upstreamIds, // 17 incoming dependencies > limit of 16
        targetFormat: 'zip',
      };
      nodes['out'] = { id: 'out', operation: 'export.internal', dependencies: ['bundle'] };

      const result = validateJobGraph({ nodes }, { maxFanIn: 16 });
      expect(result.valid).toBe(false);
      const fanInErr = result.errors.find((e) => e.code === 'FAN_IN_LIMIT_EXCEEDED');
      expect(fanInErr).toBeDefined();
      expect(fanInErr?.message).toContain('Single task fan-in exceeds limit of 16 (task "bundle" has 17 incoming dependencies)');
    });

    it('enforces fan-out limit (maximum 16 outgoing dependents per task)', () => {
      const nodes: JobGraph['nodes'] = {
        src: { id: 'src', operation: 'import.upload', storageKey: 'uploads/doc.pdf' },
      };

      for (let i = 1; i <= 17; i++) {
        nodes[`fan_${i}`] = {
          id: `fan_${i}`,
          operation: 'convert',
          dependencies: ['src'],
          targetFormat: 'png',
        };
      }
      nodes['out'] = { id: 'out', operation: 'export.internal', dependencies: ['fan_1'] };

      const result = validateJobGraph({ nodes }, { maxFanOut: 16 });
      expect(result.valid).toBe(false);
      const fanOutErr = result.errors.find((e) => e.code === 'FAN_OUT_LIMIT_EXCEEDED');
      expect(fanOutErr).toBeDefined();
      expect(fanOutErr?.message).toContain('Single node fan-out exceeds limit of 16 (node "src" has 17 outgoing connections)');
    });

    it('enforces maximum DAG depth limit of 8 stages', () => {
      const nodes: JobGraph['nodes'] = {
        src: { id: 'src', operation: 'import.upload', storageKey: 'uploads/doc.pdf' },
      };

      let prev = 'src';
      for (let i = 1; i <= 8; i++) {
        const id = `chain_${i}`;
        nodes[id] = { id, operation: 'convert', dependencies: [prev], targetFormat: 'png' };
        prev = id;
      }
      nodes['out'] = { id: 'out', operation: 'export.internal', dependencies: [prev] };

      const result = validateJobGraph({ nodes }, { userTier: 'enterprise', maxDepth: 8 });
      expect(result.valid).toBe(false);
      const depthErr = result.errors.find((e) => e.code === 'DEPTH_LIMIT_EXCEEDED');
      expect(depthErr).toBeDefined();
      expect(depthErr?.message).toContain('Graph depth exceeds limit of 8');
    });
  });

  describe('4. Format Transition Matrix Validation', () => {
    it('rejects incompatible format conversion between tasks (audio mp3 -> docx document)', () => {
      const graph: JobGraph = {
        nodes: {
          src: { id: 'src', operation: 'import.upload', storageKey: 'uploads/audio.mp3' },
          to_doc: { id: 'to_doc', operation: 'convert', dependencies: ['src'], targetFormat: 'docx' },
          out: { id: 'out', operation: 'export.internal', dependencies: ['to_doc'] },
        },
      };

      const result = validateJobGraph(graph, { sourceFilename: 'audio.mp3' });
      expect(result.valid).toBe(false);
      const incompErr = result.errors.find((e) => e.code === 'INCOMPATIBLE_FORMAT_CONVERSION');
      expect(incompErr).toBeDefined();
      expect(incompErr?.message).toContain('Incompatible conversion from "mp3" to "docx" between node "src" and node "to_doc"');
    });

    it('accepts valid multi-stage conversion path (docx -> pdf -> png)', () => {
      const graph: JobGraph = {
        nodes: {
          src: { id: 'src', operation: 'import.upload', storageKey: 'uploads/document.docx' },
          render_pdf: { id: 'render_pdf', operation: 'convert', dependencies: ['src'], targetFormat: 'pdf' },
          render_png: { id: 'render_png', operation: 'convert', dependencies: ['render_pdf'], targetFormat: 'png' },
          out: { id: 'out', operation: 'export.internal', dependencies: ['render_png'] },
        },
      };

      const result = validateJobGraph(graph, { sourceFilename: 'document.docx' });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.topologicalOrder).toEqual(['src', 'render_pdf', 'render_png', 'out']);
    });
  });

  describe('5. Backwards Compatibility: Legacy Linear Tasks Adapter', () => {
    it('transparently transforms linear tasks array into a DAG preserving topological sequence', () => {
      const legacyTasks: PipelineTask[] = [
        { name: 'Convert to PDF', operation: 'convert', targetFormat: 'pdf' },
        { name: 'Extract Thumbnail', operation: 'thumbnail', targetFormat: 'jpg' },
        { name: 'Bundle to ZIP', operation: 'archive', targetFormat: 'zip' },
      ];

      const graph = linearTasksToJobGraph(
        { filename: 'source.docx', storageKey: 'uploads/source.docx' },
        legacyTasks
      );

      const result = validateJobGraph(graph, { sourceFilename: 'source.docx' });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);

      // Verify that topological order strictly reproduces the sequential execution order
      expect(result.topologicalOrder).toEqual([
        'import_source',
        'task_1_convert',
        'task_2_thumbnail',
        'task_3_archive',
        'export_terminal',
      ]);
    });
  });

  describe('6. Strict Operation & Target Format Whitelist Validation', () => {
    it('rejects unsupported task operations with UNSUPPORTED_OPERATION', () => {
      const graph: JobGraph = {
        nodes: {
          src: { id: 'src', operation: 'import.upload', storageKey: 'uploads/doc.pdf' },
          bad_step: { id: 'bad_step', operation: 'arbitrary_unsupported_op', dependencies: ['src'] },
          out: { id: 'out', operation: 'export.internal', dependencies: ['bad_step'] },
        },
      };

      const result = validateJobGraph(graph);
      expect(result.valid).toBe(false);
      const opError = result.errors.find((e) => e.code === 'UNSUPPORTED_OPERATION');
      expect(opError).toBeDefined();
      expect(opError?.message).toContain('Unsupported task operation "arbitrary_unsupported_op"');
    });

    it('rejects unknown target format in convert node with UNKNOWN_TARGET_FORMAT', () => {
      const graph: JobGraph = {
        nodes: {
          src: { id: 'src', operation: 'import.upload', storageKey: 'uploads/doc.pdf' },
          convert_step: { id: 'convert_step', operation: 'convert', dependencies: ['src'], targetFormat: 'nonexistent_xyz_format' },
          out: { id: 'out', operation: 'export.internal', dependencies: ['convert_step'] },
        },
      };

      const result = validateJobGraph(graph, { sourceFilename: 'doc.pdf' });
      expect(result.valid).toBe(false);
      const targetError = result.errors.find((e) => e.code === 'UNKNOWN_TARGET_FORMAT');
      expect(targetError).toBeDefined();
      expect(targetError?.message).toContain('Unknown or unsupported target format "nonexistent_xyz_format"');
    });
  });
});
