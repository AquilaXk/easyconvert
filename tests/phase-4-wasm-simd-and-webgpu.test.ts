import { describe, it, expect, vi } from 'vitest';
import {
  WASM_SIMD_BYTECODE_BASE64,
  getWasmSimdBytecode,
  getCompiledSimdModule,
  instantiateSimdEngine,
} from '../src/lib/edge/workers/simd-bytecode';
import {
  WasmEngine,
  createBoundedWasmMemory,
} from '../src/lib/edge/workers/wasm-engine.worker';
import {
  COLOR_TRANSFORM_WGSL,
  GAUSSIAN_BLUR_WGSL,
  QUANTIZE_WGSL,
  isWebGpuComputeSupported,
  executeWebGpuCompute,
} from '../src/lib/edge/pipelines/webgpu-compute-pipeline';
import path from 'node:path';
import ts from 'typescript';
import { parseSource } from './helpers/ts-source';
import { parseWgsl, scalarStructByteSize, uniformFieldsUsed } from './helpers/wgsl-lite';
import {
  checkWasmSimdSupport,
  resolveConversionTier,
} from '../src/lib/edge/tier-router';

describe('Phase 4: Edge Wasm SIMD Binaries & WebGPU WGSL Compute Pipelines', () => {
  // ==========================================================================
  // 1. Precompiled WebAssembly SIMD-128 Binary Engine
  // ==========================================================================
  describe('Wasm SIMD-128 Binary Bytecode & Native Instantiation', () => {
    it('verifies SIMD bytecode magic header and compilation', () => {
      const bytes = getWasmSimdBytecode();
      expect(bytes.length).toBeGreaterThan(100);
      // \0asm magic header: 0x00, 0x61, 0x73, 0x6d, version: 0x01, 0x00, 0x00, 0x00
      expect(bytes[0]).toBe(0x00);
      expect(bytes[1]).toBe(0x61);
      expect(bytes[2]).toBe(0x73);
      expect(bytes[3]).toBe(0x6d);
      expect(bytes[4]).toBe(0x01);

      const module = getCompiledSimdModule();
      expect(module).toBeInstanceOf(WebAssembly.Module);
      expect(WebAssembly.Module.exports(module)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'rgba_invert', kind: 'function' }),
          expect.objectContaining({ name: 'rgba_grayscale', kind: 'function' }),
          expect.objectContaining({ name: 'rgba_brightness', kind: 'function' }),
          expect.objectContaining({ name: 'rgba_quantize', kind: 'function' }),
        ])
      );
    });

    it('executes rgba_invert with exact alpha preservation via Wasm SIMD instance', () => {
      const memory = new WebAssembly.Memory({ initial: 1 });
      const { exports } = instantiateSimdEngine(memory);

      const view = new Uint8Array(memory.buffer);
      // Pixel 1: R=100, G=150, B=200, A=255
      // Pixel 2: R=0,   G=255, B=128, A=180
      view[0] = 100; view[1] = 150; view[2] = 200; view[3] = 255;
      view[4] = 0;   view[5] = 255; view[6] = 128; view[7] = 180;

      exports.rgba_invert(0, 8);

      expect(view[0]).toBe(155); // 255 - 100
      expect(view[1]).toBe(105); // 255 - 150
      expect(view[2]).toBe(55);  // 255 - 200
      expect(view[3]).toBe(255); // Alpha preserved

      expect(view[4]).toBe(255); // 255 - 0
      expect(view[5]).toBe(0);   // 255 - 255
      expect(view[6]).toBe(127); // 255 - 128
      expect(view[7]).toBe(180); // Alpha preserved
    });

    it('executes rgba_grayscale with standard luminance weights', () => {
      const memory = new WebAssembly.Memory({ initial: 1 });
      const { exports } = instantiateSimdEngine(memory);

      const view = new Uint8Array(memory.buffer);
      // Pixel: R=200, G=100, B=50, A=200
      // Gray = (77 * 200 + 150 * 100 + 29 * 50) >> 8 = (15400 + 15000 + 1450) >> 8 = 31850 >> 8 = 124
      view[0] = 200; view[1] = 100; view[2] = 50; view[3] = 200;

      exports.rgba_grayscale(0, 4);

      expect(view[0]).toBe(124);
      expect(view[1]).toBe(124);
      expect(view[2]).toBe(124);
      expect(view[3]).toBe(200); // Alpha preserved
    });

    it('executes rgba_brightness with clamped delta addition', () => {
      const memory = new WebAssembly.Memory({ initial: 1 });
      const { exports } = instantiateSimdEngine(memory);

      const view = new Uint8Array(memory.buffer);
      // Pixel: R=240, G=10, B=100, A=255
      view[0] = 240; view[1] = 10; view[2] = 100; view[3] = 255;

      exports.rgba_brightness(0, 4, 30);

      expect(view[0]).toBe(255); // Clamped to 255 (240 + 30)
      expect(view[1]).toBe(40);  // 10 + 30
      expect(view[2]).toBe(130); // 100 + 30
      expect(view[3]).toBe(255); // Alpha preserved
    });

    it('executes rgba_quantize across multi-channel color steps', () => {
      const memory = new WebAssembly.Memory({ initial: 1 });
      const { exports } = instantiateSimdEngine(memory);

      const view = new Uint8Array(memory.buffer);
      // 4 levels -> step = 255 / 3 = 85
      view[0] = 100; view[1] = 120; view[2] = 200; view[3] = 255;

      exports.rgba_quantize(0, 4, 4, 4, 2);

      expect(view[0]).toBe(85);
      expect(view[1]).toBe(85);
      expect(view[2]).toBe(255);
      expect(view[3]).toBe(255);
    });
  });

  // ==========================================================================
  // 2. Wasm Engine Executor & Memory Bounding
  // ==========================================================================
  describe('WasmEngine Runtime Integration', () => {
    it('executes tasks through WasmEngine and verifies worker stats', async () => {
      const engine = new WasmEngine();
      const input = new Uint8Array([50, 100, 150, 255, 200, 150, 100, 255]);

      const result = await engine.executeTask({
        jobId: 'test-job-simd',
        task: 'rgba-invert',
        buffer: input.buffer.slice(0),
      });

      expect(result.jobId).toBe('test-job-simd');
      expect(result.bytesProcessed).toBe(8);

      const outView = new Uint8Array(result.buffer);
      expect(outView[0]).toBe(205);
      expect(outView[1]).toBe(155);
      expect(outView[2]).toBe(105);
      expect(outView[3]).toBe(255);

      const stats = engine.getStats();
      expect(stats.tasksCompleted).toBe(1);
      expect(stats.cumulativeBytes).toBe(8);
      expect(stats.currentHeapPages).toBeGreaterThan(0);
    });

    it('correctly handles memory capacity bounds up to 1GB', () => {
      const mem = createBoundedWasmMemory(1, 16384);
      expect(mem.buffer.byteLength).toBe(65536);
      mem.grow(1);
      expect(mem.buffer.byteLength).toBe(131072);
    });
  });

  // ==========================================================================
  // 3. WebGPU WGSL Compute Pipeline
  // ==========================================================================
  describe('WebGPU WGSL Compute Shaders & Pipeline', () => {
    // No WGSL validator is available on a test shard, so the shaders are checked against the host code that
    // drives them: what the host binds, writes and dispatches must be exactly what the shader declares.
    describe('WGSL shaders against the host that drives them', () => {
      const HOST_SOURCE = path.join(process.cwd(), 'src/lib/edge/pipelines/webgpu-compute-pipeline.ts');
      const shaders = [
        { name: 'color transform', code: COLOR_TRANSFORM_WGSL, uniformStruct: 'Uniforms', fields: ['width', 'height', 'mode', 'param'] },
        { name: 'gaussian blur', code: GAUSSIAN_BLUR_WGSL, uniformStruct: 'BlurUniforms', fields: ['width', 'height', 'radius', 'sigma'] },
        { name: 'quantize', code: QUANTIZE_WGSL, uniformStruct: 'QuantizeUniforms', fields: ['width', 'height', 'rLevels', 'gLevels', 'bLevels', 'pad'] },
      ];

      /** The uniform buffers the host builds, in source order: size and the typed writes into each. */
      function hostUniformLayouts(): Array<{ size: number; writes: Array<{ method: string; offset: number }> }> {
        const sf = parseSource(HOST_SOURCE);
        const layouts: Array<{ position: number; size: number; writes: Array<{ method: string; offset: number }> }> = [];
        const visit = (node: ts.Node): void => {
          if (ts.isNewExpression(node) && node.expression.getText(sf) === 'ArrayBuffer' && node.arguments?.length === 1) {
            layouts.push({ position: node.getStart(sf), size: Number(node.arguments[0].getText(sf)), writes: [] });
          }
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && /^set(?:Uint32|Int32|Float32)$/.test(node.expression.name.text)) {
            const owner = layouts[layouts.length - 1];
            owner.writes.push({ method: node.expression.name.text, offset: Number(node.arguments[0].getText(sf)) });
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
        return layouts.map(({ size, writes }) => ({ size, writes }));
      }

      const SETTER_FOR_TYPE: Record<string, string> = { u32: 'setUint32', i32: 'setInt32', f32: 'setFloat32' };

      it.each(shaders)('$name: balanced, one 16 x 16 compute entry point and three bindings in group 0', ({ code }) => {
        const shader = parseWgsl(code);
        expect(shader.entryPoints).toEqual([{ stage: 'compute', name: 'main', workgroupSize: [16, 16] }]);
        expect(shader.bindings.map((binding) => [binding.group, binding.binding, binding.addressSpace, binding.access, binding.name, binding.type])).toEqual([
          [0, 0, 'uniform', '', 'u', expect.stringMatching(/^(?:Uniforms|BlurUniforms|QuantizeUniforms)$/)],
          [0, 1, 'storage', 'read', 'inPixels', 'array<u32>'],
          [0, 2, 'storage', 'read_write', 'outPixels', 'array<u32>'],
        ]);
      });

      it('the host binds exactly the three bindings every shader declares and dispatches 16 x 16 workgroups', () => {
        const sf = parseSource(HOST_SOURCE);
        const text = sf.getFullText();
        const boundIndices = [...text.matchAll(/\{\s*binding:\s*(\d+),\s*resource:/g)].map((match) => Number(match[1]));
        expect(boundIndices).toEqual([0, 1, 2]);
        expect(text).toContain('Math.ceil(width / 16)');
        expect(text).toContain('Math.ceil(height / 16)');
      });

      it('each uniform struct matches the buffer the host writes: size, field order, offsets and types', () => {
        const layouts = hostUniformLayouts();
        expect(layouts).toHaveLength(shaders.length);
        shaders.forEach(({ name, code, uniformStruct, fields }, index) => {
          const shader = parseWgsl(code);
          const struct = shader.structs.find((candidate) => candidate.name === uniformStruct);
          expect(struct?.fields.map((field) => field.name), name).toEqual(fields);
          expect(scalarStructByteSize(struct as NonNullable<typeof struct>), name).toBe(layouts[index].size);
          // Member i sits at offset 4 * i and is written with the setter of its WGSL type.
          expect(layouts[index].writes, name).toEqual(
            (struct as NonNullable<typeof struct>).fields.map((field, fieldIndex) => ({ method: SETTER_FOR_TYPE[field.type], offset: fieldIndex * 4 }))
          );
          // Every uniform member the shader reads exists in the struct.
          for (const used of uniformFieldsUsed(shader.code, 'u')) expect(fields, `${name}: u.${used}`).toContain(used);
        });
      });

      it('uses the published luma weights (ITU-R BT.601), the sepia matrix and the quantizer step formula', () => {
        const color = parseWgsl(COLOR_TRANSFORM_WGSL).code.replace(/\s+/g, ' ');
        expect(color).toContain('let gray = 0.299 * r + 0.587 * g + 0.114 * b;');
        // Weights of one channel sum to 1, so a grey stays grey; each sepia row is the usual tone matrix.
        expect(0.299 + 0.587 + 0.114).toBeCloseTo(1, 12);
        const sepiaRows = [...color.matchAll(/out([RGB]) = clamp\((\d\.\d+) \* r \+ (\d\.\d+) \* g \+ (\d\.\d+) \* b, 0\.0, 255\.0\);/g)].map((match) =>
          match.slice(2).map(Number)
        );
        expect(sepiaRows).toEqual([
          [0.393, 0.769, 0.189],
          [0.349, 0.686, 0.168],
          [0.272, 0.534, 0.131],
        ]);
        const quantize = parseWgsl(QUANTIZE_WGSL).code.replace(/\s+/g, ' ');
        // Levels L give L - 1 steps over 0..255; a level count of 1 must not divide by zero (max(1u, L - 1u)).
        expect(quantize).toContain('let rStep = 255.0 / f32(max(1u, u.rLevels - 1u));');
        expect(quantize).toContain('round(round(r / rStep) * rStep)');
      });
    });

    it('probes WebGPU availability and gracefully handles headless test environment', async () => {
      const isSupported = isWebGpuComputeSupported();
      expect(typeof isSupported).toBe('boolean');

      const res = await executeWebGpuCompute({
        width: 4,
        height: 4,
        data: new Uint8Array(4 * 4 * 4),
        task: { type: 'color-transform', options: { mode: 'grayscale' } },
      });

      // In Node.js environment without GPU, returns null for graceful L2 Wasm cascade
      expect(res).toBeNull();
    });

    it('routes L1A tier when WebGPU is requested and capabilities permit', () => {
      const resolution = resolveConversionTier('png', 'png', 1024, {
        useWebGpu: true,
      }, {
        hasWebCodecsVideo: false,
        hasWebCodecsAudio: false,
        hasOpfsSyncAccess: true,
        hasWasmSimd: true,
        hasCanvas: true,
        isCrossOriginIsolated: false,
        hardwareConcurrency: 8,
        supportedVideoEncoders: [],
        supportedAudioEncoders: [],
        hasWebGpu: true,
      });

      expect(resolution.tier).toBe('L1A');
      expect(resolution.tierName).toBe('Edge L1A (WebGPU Compute)');
      expect(resolution.isClientEdge).toBe(true);
    });

    it('validates checkWasmSimdSupport returns boolean deterministically', () => {
      const simdSupported = checkWasmSimdSupport();
      expect(typeof simdSupported).toBe('boolean');
      expect(simdSupported).toBe(true);
    });
  });
});
