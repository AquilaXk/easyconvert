/**
 * Independent Ogg (RFC 3533) page reader for tests: it checks every page's CRC with its own table and returns the
 * pages with their flags, granule positions, sequence numbers and complete packets. Shares no code with the
 * muxer under test.
 */

const CRC_POLYNOMIAL = 0x04c11db7;
const HEADER_BYTES = 27;
const MAX_PAGES = 1_000_000;

const CRC_TABLE: number[] = Array.from({ length: 256 }, (_, index) => {
  let register = index * 2 ** 24;
  for (let bit = 0; bit < 8; bit++) {
    register = (register & 0x80000000) !== 0 ? ((register << 1) ^ CRC_POLYNOMIAL) >>> 0 : (register << 1) >>> 0;
  }
  return register >>> 0;
});

function checksum(page: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < page.length; i++) {
    // The checksum field itself counts as zero
    const byte = i >= 22 && i < 26 ? 0 : page[i];
    crc = (((crc << 8) >>> 0) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  }
  return crc;
}

export interface OggPage {
  flags: number;
  granule: bigint;
  serial: number;
  sequence: number;
  crcValid: boolean;
  /** Packets that end on this page, in order; a packet continued from an earlier page is not rejoined. */
  packets: Uint8Array[];
}

export function walkOggPages(data: Uint8Array): OggPage[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pages: OggPage[] = [];
  let offset = 0;
  while (offset < data.length) {
    if (offset + HEADER_BYTES > data.length) throw new Error(`truncated Ogg page header at ${offset}`);
    const magic = String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
    if (magic !== 'OggS') throw new Error(`no OggS capture pattern at ${offset}`);
    if (data[offset + 4] !== 0) throw new Error('unsupported Ogg stream structure version');
    const segmentCount = data[offset + 26];
    const table = data.subarray(offset + HEADER_BYTES, offset + HEADER_BYTES + segmentCount);
    const payloadLength = table.reduce((sum, value) => sum + value, 0);
    const end = offset + HEADER_BYTES + segmentCount + payloadLength;
    if (end > data.length) throw new Error(`Ogg page at ${offset} overruns the file`);

    const packets: Uint8Array[] = [];
    let cursor = offset + HEADER_BYTES + segmentCount;
    let packetStart = cursor;
    for (const segment of table) {
      cursor += segment;
      if (segment < 255) {
        packets.push(data.slice(packetStart, cursor));
        packetStart = cursor;
      }
    }

    pages.push({
      flags: data[offset + 5],
      granule: view.getBigInt64(offset + 6, true),
      serial: view.getUint32(offset + 14, true),
      sequence: view.getUint32(offset + 18, true),
      crcValid: checksum(data.subarray(offset, end)) === view.getUint32(offset + 22, true),
      packets,
    });
    offset = end;
    if (pages.length > MAX_PAGES) throw new Error('too many Ogg pages');
  }
  return pages;
}
