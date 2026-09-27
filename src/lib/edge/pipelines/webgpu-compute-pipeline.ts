/**
 * WebGPU WGSL Compute Pipeline (Level 1A - L1A)
 *
 * Implements high-performance GPU-accelerated image transformations using WGSL compute shaders:
 * 1. Color space transformations (Grayscale, Invert, Brightness, Sepia)
 * 2. 2D Gaussian blur convolution kernel with dynamic radius and sigma
 * 3. Color quantization shader with channel-level discretization
 * 4. Graceful cascade fallback to L2 Wasm SIMD when WebGPU is unavailable
 */

export interface WebGpuColorTransformOptions {
  mode: 'grayscale' | 'invert' | 'brightness' | 'sepia';
  param?: number; // delta for brightness, factor for sepia
}

export interface WebGpuBlurOptions {
  radius?: number; // convolution radius (default: 3)
  sigma?: number;  // gaussian standard deviation (default: 1.5)
}

export interface WebGpuQuantizeOptions {
  rLevels?: number;
  gLevels?: number;
  bLevels?: number;
}

export type WebGpuComputeTask =
  | { type: 'color-transform'; options: WebGpuColorTransformOptions }
  | { type: 'gaussian-blur'; options?: WebGpuBlurOptions }
  | { type: 'quantize'; options?: WebGpuQuantizeOptions };

export interface WebGpuComputePayload {
  width: number;
  height: number;
  data: Uint8Array; // RGBA pixel buffer
  task: WebGpuComputeTask;
}

export interface WebGpuComputeResult {
  width: number;
  height: number;
  data: Uint8Array; // Transformed RGBA buffer
  gpuTimeMs?: number;
}

/**
 * WGSL Shader: Color Space Transformation
 */
export const COLOR_TRANSFORM_WGSL = /* wgsl */ `
struct Uniforms {
  width: u32,
  height: u32,
  mode: u32,       // 0: grayscale, 1: invert, 2: brightness, 3: sepia
  param: f32,      // delta or factor
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> inPixels: array<u32>;
@group(0) @binding(2) var<storage, read_write> outPixels: array<u32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = id.x;
  let y = id.y;
  if (x >= u.width || y >= u.height) {
    return;
  }

  let index = y * u.width + x;
  let pixel = inPixels[index];

  let r = f32(pixel & 0xFFu);
  let g = f32((pixel >> 8u) & 0xFFu);
  let b = f32((pixel >> 16u) & 0xFFu);
  let a = (pixel >> 24u) & 0xFFu;

  var outR = r;
  var outG = g;
  var outB = b;

  if (u.mode == 0u) {
    // Standard Luminance Grayscale: Y = 0.299R + 0.587G + 0.114B
    let gray = 0.299 * r + 0.587 * g + 0.114 * b;
    outR = gray;
    outG = gray;
    outB = gray;
  } else if (u.mode == 1u) {
    // Invert
    outR = 255.0 - r;
    outG = 255.0 - g;
    outB = 255.0 - b;
  } else if (u.mode == 2u) {
    // Brightness adjustment with clamp
    outR = clamp(r + u.param, 0.0, 255.0);
    outG = clamp(g + u.param, 0.0, 255.0);
    outB = clamp(b + u.param, 0.0, 255.0);
  } else if (u.mode == 3u) {
    // Sepia tone matrix
    outR = clamp(0.393 * r + 0.769 * g + 0.189 * b, 0.0, 255.0);
    outG = clamp(0.349 * r + 0.686 * g + 0.168 * b, 0.0, 255.0);
    outB = clamp(0.272 * r + 0.534 * g + 0.131 * b, 0.0, 255.0);
  }

  let finalR = u32(round(outR));
  let finalG = u32(round(outG));
  let finalB = u32(round(outB));

  outPixels[index] = finalR | (finalG << 8u) | (finalB << 16u) | (a << 24u);
}
`;

/**
 * WGSL Shader: 2D Gaussian Blur Convolution
 */
export const GAUSSIAN_BLUR_WGSL = /* wgsl */ `
struct BlurUniforms {
  width: u32,
  height: u32,
  radius: i32,
  sigma: f32,
};

@group(0) @binding(0) var<uniform> u: BlurUniforms;
@group(0) @binding(1) var<storage, read> inPixels: array<u32>;
@group(0) @binding(2) var<storage, read_write> outPixels: array<u32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = i32(id.x);
  let y = i32(id.y);
  let w = i32(u.width);
  let h = i32(u.height);

  if (x >= w || y >= h) {
    return;
  }

  var sumR: f32 = 0.0;
  var sumG: f32 = 0.0;
  var sumB: f32 = 0.0;
  var totalWeight: f32 = 0.0;
  let rad = u.radius;
  let twoSigmaSq = 2.0 * u.sigma * u.sigma;

  for (var dy = -rad; dy <= rad; dy = dy + 1) {
    let py = clamp(y + dy, 0, h - 1);
    for (var dx = -rad; dx <= rad; dx = dx + 1) {
      let px = clamp(x + dx, 0, w - 1);
      let distSq = f32(dx * dx + dy * dy);
      let weight = exp(-distSq / twoSigmaSq);

      let pix = inPixels[u32(py * w + px)];
      sumR = sumR + f32(pix & 0xFFu) * weight;
      sumG = sumG + f32((pix >> 8u) & 0xFFu) * weight;
      sumB = sumB + f32((pix >> 16u) & 0xFFu) * weight;
      totalWeight = totalWeight + weight;
    }
  }

  let finalR = u32(clamp(round(sumR / totalWeight), 0.0, 255.0));
  let finalG = u32(clamp(round(sumG / totalWeight), 0.0, 255.0));
  let finalB = u32(clamp(round(sumB / totalWeight), 0.0, 255.0));
  let origA = (inPixels[u32(y * w + x)] >> 24u) & 0xFFu;

  outPixels[u32(y * w + x)] = finalR | (finalG << 8u) | (finalB << 16u) | (origA << 24u);
}
`;

/**
 * WGSL Shader: Color Quantization
 */
export const QUANTIZE_WGSL = /* wgsl */ `
struct QuantizeUniforms {
  width: u32,
  height: u32,
  rLevels: u32,
  gLevels: u32,
  bLevels: u32,
  pad: u32,
};

@group(0) @binding(0) var<uniform> u: QuantizeUniforms;
@group(0) @binding(1) var<storage, read> inPixels: array<u32>;
@group(0) @binding(2) var<storage, read_write> outPixels: array<u32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = id.x;
  let y = id.y;
  if (x >= u.width || y >= u.height) {
    return;
  }

  let idx = y * u.width + x;
  let pix = inPixels[idx];

  let r = f32(pix & 0xFFu);
  let g = f32((pix >> 8u) & 0xFFu);
  let b = f32((pix >> 16u) & 0xFFu);
  let a = (pix >> 24u) & 0xFFu;

  let rStep = 255.0 / f32(max(1u, u.rLevels - 1u));
  let gStep = 255.0 / f32(max(1u, u.gLevels - 1u));
  let bStep = 255.0 / f32(max(1u, u.bLevels - 1u));

  let qr = u32(clamp(round(round(r / rStep) * rStep), 0.0, 255.0));
  let qg = u32(clamp(round(round(g / gStep) * gStep), 0.0, 255.0));
  let qb = u32(clamp(round(round(b / bStep) * bStep), 0.0, 255.0));

  outPixels[idx] = qr | (qg << 8u) | (qb << 16u) | (a << 24u);
}
`;

let cachedDevice: any = null;

/**
 * Checks whether WebGPU Compute is available and functional in current runtime.
 */
export function isWebGpuComputeSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'gpu' in navigator &&
    Boolean((navigator as any).gpu?.requestAdapter)
  );
}

/**
 * Gets or requests a singleton GPUDevice instance.
 */
export async function getWebGpuDevice(): Promise<any | null> {
  if (cachedDevice) {
    return cachedDevice;
  }
  if (!isWebGpuComputeSupported()) {
    return null;
  }

  try {
    const gpu = (navigator as any).gpu;
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      return null;
    }
    cachedDevice = await adapter.requestDevice();
    return cachedDevice;
  } catch {
    return null;
  }
}

/**
 * Executes WebGPU Compute Pipeline for image filtering.
 * Returns null if WebGPU is unsupported or hardware execution fails.
 */
export async function executeWebGpuCompute(
  payload: WebGpuComputePayload
): Promise<WebGpuComputeResult | null> {
  const device = await getWebGpuDevice();
  if (!device) {
    return null;
  }

  const { width, height, data, task } = payload;
  const pixelCount = width * height;
  const bufferByteSize = pixelCount * 4;

  if (data.byteLength < bufferByteSize) {
    throw new Error('WebGPU compute payload data buffer smaller than dimensions');
  }

  try {
    let shaderCode: string;
    let uniformData: ArrayBuffer;

    if (task.type === 'color-transform') {
      shaderCode = COLOR_TRANSFORM_WGSL;
      const modeInt =
        task.options.mode === 'grayscale'
          ? 0
          : task.options.mode === 'invert'
          ? 1
          : task.options.mode === 'brightness'
          ? 2
          : 3; // sepia
      const paramVal = task.options.param ?? (task.options.mode === 'brightness' ? 25.0 : 1.0);

      const uBuf = new ArrayBuffer(16);
      const uView = new DataView(uBuf);
      uView.setUint32(0, width, true);
      uView.setUint32(4, height, true);
      uView.setUint32(8, modeInt, true);
      uView.setFloat32(12, paramVal, true);
      uniformData = uBuf;
    } else if (task.type === 'gaussian-blur') {
      shaderCode = GAUSSIAN_BLUR_WGSL;
      const radius = task.options?.radius ?? 3;
      const sigma = task.options?.sigma ?? 1.5;

      const uBuf = new ArrayBuffer(16);
      const uView = new DataView(uBuf);
      uView.setUint32(0, width, true);
      uView.setUint32(4, height, true);
      uView.setInt32(8, radius, true);
      uView.setFloat32(12, sigma, true);
      uniformData = uBuf;
    } else {
      shaderCode = QUANTIZE_WGSL;
      const rLevels = task.options?.rLevels ?? 8;
      const gLevels = task.options?.gLevels ?? 8;
      const bLevels = task.options?.bLevels ?? 4;

      const uBuf = new ArrayBuffer(24);
      const uView = new DataView(uBuf);
      uView.setUint32(0, width, true);
      uView.setUint32(4, height, true);
      uView.setUint32(8, rLevels, true);
      uView.setUint32(12, gLevels, true);
      uView.setUint32(16, bLevels, true);
      uView.setUint32(20, 0, true);
      uniformData = uBuf;
    }

    const shaderModule = device.createShaderModule({ code: shaderCode });

    // 1. Uniform Buffer
    const uniformBuffer = device.createBuffer({
      size: uniformData.byteLength,
      usage: 0x0040 | 0x0008, // GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    // 2. Storage Input Buffer
    const inputBuffer = device.createBuffer({
      size: bufferByteSize,
      usage: 0x0080 | 0x0008, // GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    device.queue.writeBuffer(inputBuffer, 0, data.buffer, data.byteOffset, bufferByteSize);

    // 3. Storage Output Buffer
    const outputBuffer = device.createBuffer({
      size: bufferByteSize,
      usage: 0x0080 | 0x0004, // GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });

    // 4. Staging Readback Buffer
    const readbackBuffer = device.createBuffer({
      size: bufferByteSize,
      usage: 0x0001 | 0x0008, // GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });

    const computePipeline = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: shaderModule,
        entryPoint: 'main',
      },
    });

    const bindGroup = device.createBindGroup({
      layout: computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: { buffer: inputBuffer } },
        { binding: 2, resource: { buffer: outputBuffer } },
      ],
    });

    const commandEncoder = device.createCommandEncoder();
    const passEncoder = commandEncoder.beginComputePass();
    passEncoder.setPipeline(computePipeline);
    passEncoder.setBindGroup(0, bindGroup);

    const workgroupsX = Math.ceil(width / 16);
    const workgroupsY = Math.ceil(height / 16);
    passEncoder.dispatchWorkgroups(workgroupsX, workgroupsY);
    passEncoder.end();

    commandEncoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, bufferByteSize);
    device.queue.submit([commandEncoder.finish()]);

    await readbackBuffer.mapAsync(1); // GPUMapMode.READ
    const copyArrayBuffer = readbackBuffer.getMappedRange(0, bufferByteSize);
    const resultArray = new Uint8Array(copyArrayBuffer.slice(0));
    readbackBuffer.unmap();

    // Release GPU buffers
    uniformBuffer.destroy();
    inputBuffer.destroy();
    outputBuffer.destroy();
    readbackBuffer.destroy();

    return {
      width,
      height,
      data: resultArray,
    };
  } catch {
    return null;
  }
}
