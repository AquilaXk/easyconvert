/**
 * Run by tests/audio-resampler-simd.test.ts in a Node process started with --no-expose-wasm, so that `WebAssembly` does
 * not exist: reports the kernel the resampler picks and what a forced SIMD request does. Prints one JSON line.
 */
const { resampleInterleavedInt16 } = require('../../src/lib/conversions/audio-resampler');
const { macKernelSupported } = require('../../src/lib/conversions/wasm/resampler-mac');

const report: { kernel?: string } = {};
const data = new Int16Array(4000).map((_, i) => Math.round(1000 * Math.sin(i / 7)));
const scalar = resampleInterleavedInt16(data, 44100, 48000, 2, { kernel: 'scalar' });
const automatic = resampleInterleavedInt16(data, 44100, 48000, 2, { report });
let forced = 'no error';
try {
  resampleInterleavedInt16(data, 44100, 48000, 2, { kernel: 'simd' });
} catch (error) {
  forced = (error as Error).name;
}
console.log(
  JSON.stringify({
    webassembly: typeof WebAssembly,
    supported: macKernelSupported(),
    kernel: report.kernel,
    sameSamples: scalar.length === automatic.length && scalar.every((value: number, index: number) => value === automatic[index]),
    forced,
  })
);
