/**
 * Independent Redis Cluster key slot calculation, written from the cluster specification:
 * HASH_SLOT = CRC16(key) mod 16384, where CRC16 is CRC-16/XMODEM (poly 0x1021, init 0) and
 * only the substring inside the first non-empty `{...}` hash tag is hashed.
 */

const CRC16_POLY = 0x1021;
const CRC16_MASK = 0xffff;
const CLUSTER_SLOTS = 16384;

export function crc16Xmodem(input: string): number {
  let crc = 0;
  for (const byte of Buffer.from(input, 'utf-8')) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ CRC16_POLY) & CRC16_MASK : (crc << 1) & CRC16_MASK;
    }
  }
  return crc;
}

export function clusterKeySlot(key: string): number {
  const open = key.indexOf('{');
  if (open !== -1) {
    const close = key.indexOf('}', open + 1);
    if (close > open + 1) {
      return crc16Xmodem(key.slice(open + 1, close)) % CLUSTER_SLOTS;
    }
  }
  return crc16Xmodem(key) % CLUSTER_SLOTS;
}
