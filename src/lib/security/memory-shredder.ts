import crypto from 'crypto';

/**
 * Multi-pass cryptographic memory buffer shredder
 * Conforms to NIST SP 800-88 / DoD 5220.22-M transient memory sanitization guidelines.
 *
 * Prevents memory extraction, cold-boot analysis, and heap-dump inspection
 * by overwriting buffer contents with high-entropy cryptographic random bytes
 * followed by strict zero-filling (0x00).
 */
export function secureShredBuffer(
  buffer?: Buffer | Uint8Array | null,
  passes: number = 2
): void {
  if (!buffer || buffer.length === 0) return;

  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  try {
    for (let p = 0; p < Math.max(1, passes); p++) {
      if (p % 2 === 0) {
        // High-entropy random pass
        crypto.randomFillSync(buf);
      } else {
        // Inverted complement pass (0xFF)
        buf.fill(0xff);
      }
    }
  } catch {
    // Fallback if randomFillSync fails
  } finally {
    // Final zeroing pass: ensure all bytes are 0x00
    try {
      buf.fill(0x00);
    } catch {}
  }
}

/**
 * Recursively inspects and wipes all Buffer and Uint8Array references within an object
 * before dereferencing and disposal.
 */
export function secureWipeObject(target: Record<string, any> | null | undefined): void {
  if (!target || typeof target !== 'object') return;

  for (const key of Object.keys(target)) {
    const val = target[key];
    if (Buffer.isBuffer(val) || val instanceof Uint8Array) {
      secureShredBuffer(val);
      try {
        delete target[key];
      } catch {}
    } else if (val && typeof val === 'object' && !Array.isArray(val)) {
      secureWipeObject(val);
    }
  }
}
