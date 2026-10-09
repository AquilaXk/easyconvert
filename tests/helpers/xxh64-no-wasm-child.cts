/**
 * Run by tests/xxh64-wasm.test.ts in a Node process started with --no-expose-wasm, so that `WebAssembly` does not exist:
 * the zstd content checksum must still be computed (by the script implementation). Prints one JSON line.
 */
const { computeZstdChecksum, compressZstd, decompressZstd } = require('../../src/lib/conversions/zstd');
const { xxh64Wasm, xxh64WasmSupported } = require('../../src/lib/conversions/wasm/xxh64');

const data = Buffer.alloc(5000);
for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 3)) & 0xff;
const restored = decompressZstd(compressZstd(data, { level: 3 }));
console.log(
  JSON.stringify({
    webassembly: typeof WebAssembly,
    supported: xxh64WasmSupported(),
    wasmHash: xxh64Wasm(data),
    checksum: computeZstdChecksum(data),
    roundTrip: restored.equals(data),
  })
);
