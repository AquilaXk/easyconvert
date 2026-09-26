/**
 * Pure TypeScript Bzip2 Compressor and Decompressor
 * Strictly zero external dependencies, in-memory ephemeral stream compliant.
 */

// Bzip2 CRC-32 table (polynomial 0x04C11DB7)
const BZ_CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i << 24;
  for (let j = 0; j < 8; j++) {
    c = (c & 0x80000000) ? ((c << 1) ^ 0x04c11db7) : (c << 1);
  }
  BZ_CRC_TABLE[i] = c >>> 0;
}

export function updateBzCrc(crc: number, val: number): number {
  return ((crc << 8) ^ BZ_CRC_TABLE[((crc >>> 24) ^ val) & 0xff]) >>> 0;
}

export function computeBzBlockCrc(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = updateBzCrc(crc, buf[i]);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

class BitWriter {
  private buffer: Buffer;
  private bytePos = 0;
  private bitPos = 0; // 0 to 7 (MSB first)

  constructor(initialCapacity = 65536) {
    this.buffer = Buffer.alloc(initialCapacity);
  }

  private ensureCapacity(neededBytes: number) {
    if (this.bytePos + neededBytes >= this.buffer.length) {
      const newBuf = Buffer.alloc(Math.max(this.buffer.length * 2, this.buffer.length + neededBytes + 1024));
      this.buffer.copy(newBuf, 0, 0, this.bytePos + 1);
      this.buffer = newBuf;
    }
  }

  writeBits(val: number, numBits: number) {
    this.ensureCapacity(Math.ceil(numBits / 8) + 2);
    for (let i = numBits - 1; i >= 0; i--) {
      const bit = (val >>> i) & 1;
      this.buffer[this.bytePos] |= (bit << (7 - this.bitPos));
      this.bitPos++;
      if (this.bitPos === 8) {
        this.bitPos = 0;
        this.bytePos++;
      }
    }
  }

  writeByte(val: number) {
    this.writeBits(val, 8);
  }

  writeBytes(bytes: Uint8Array) {
    for (let i = 0; i < bytes.length; i++) {
      this.writeByte(bytes[i]);
    }
  }

  finish(): Buffer {
    let len = this.bytePos;
    if (this.bitPos > 0) {
      len++; // partial byte has already been written
    }
    return this.buffer.subarray(0, len);
  }
}

class BitReader {
  private buffer: Uint8Array;
  private bytePos = 0;
  private bitPos = 0;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
  }

  readBits(numBits: number): number {
    let res = 0;
    for (let i = 0; i < numBits; i++) {
      if (this.bytePos >= this.buffer.length) {
        throw new Error('Unexpected EOF in Bzip2 bitstream.');
      }
      const bit = (this.buffer[this.bytePos] >>> (7 - this.bitPos)) & 1;
      res = (res << 1) | bit;
      this.bitPos++;
      if (this.bitPos === 8) {
        this.bitPos = 0;
        this.bytePos++;
      }
    }
    return res >>> 0;
  }

  readBit(): number {
    return this.readBits(1);
  }
}

/**
 * Compresses an input buffer to standard bzip2 format.
 */
export function compressBzip2(input: Buffer): Buffer {
  if (input.length === 0) {
    // Empty bzip2 stream
    const bw = new BitWriter(64);
    bw.writeByte(0x42); // 'B'
    bw.writeByte(0x5a); // 'Z'
    bw.writeByte(0x68); // 'h'
    bw.writeByte(0x39); // '9' (block size 900k)
    // End of stream magic: 0x177245385090
    bw.writeByte(0x17);
    bw.writeByte(0x72);
    bw.writeByte(0x45);
    bw.writeByte(0x38);
    bw.writeByte(0x50);
    bw.writeByte(0x90);
    bw.writeBits(0, 32); // stream CRC
    return bw.finish();
  }

  const bw = new BitWriter(input.length + 1024);
  bw.writeByte(0x42); // 'B'
  bw.writeByte(0x5a); // 'Z'
  bw.writeByte(0x68); // 'h'
  bw.writeByte(0x39); // '9'

  let combinedCrc = 0;

  // Process in blocks up to 900,000 bytes
  const blockSize = 900000;
  for (let offset = 0; offset < input.length; offset += blockSize) {
    const chunk = input.subarray(offset, Math.min(input.length, offset + blockSize));
    const blockCrc = computeBzBlockCrc(chunk);
    combinedCrc = (((combinedCrc << 1) | (combinedCrc >>> 31)) ^ blockCrc) >>> 0;

    // 1. Burrows-Wheeler Transform (BWT)
    const n = chunk.length;
    // Indices 0..n-1
    const indices = new Int32Array(n);
    for (let i = 0; i < n; i++) indices[i] = i;

    // Suffix / cyclic shift comparison
    indices.sort((a, b) => {
      let i = a;
      let j = b;
      for (let k = 0; k < n; k++) {
        const byteA = chunk[i];
        const byteB = chunk[j];
        if (byteA !== byteB) return byteA - byteB;
        i = (i + 1) % n;
        j = (j + 1) % n;
      }
      return 0;
    });

    let origPtr = 0;
    const lColumn = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const idx = indices[i];
      if (idx === 0) origPtr = i;
      lColumn[i] = chunk[(idx + n - 1) % n];
    }

    // 2. Identify in-use symbols
    const inUse = new Uint8Array(256);
    for (let i = 0; i < n; i++) inUse[lColumn[i]] = 1;

    const inUse16 = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j < 16; j++) {
        if (inUse[i * 16 + j]) {
          inUse16[i] = 1;
          break;
        }
      }
    }

    // Symbol map (0..numSymbols-1)
    const symMap: number[] = [];
    for (let i = 0; i < 256; i++) {
      if (inUse[i]) symMap.push(i);
    }
    const numSymbols = symMap.length;

    // 3. Move-To-Front (MTF) transform
    const mtfList = [...symMap];
    const mtfValues: number[] = [];
    for (let i = 0; i < n; i++) {
      const b = lColumn[i];
      const pos = mtfList.indexOf(b);
      mtfValues.push(pos);
      if (pos > 0) {
        mtfList.splice(pos, 1);
        mtfList.unshift(b);
      }
    }

    // 4. Run-length encoding of zeros (RUNA/RUNB)
    // RUNA = 0, RUNB = 1, symbol + 2
    const rleSymbols: number[] = [];
    let zeroCount = 0;
    for (let i = 0; i < mtfValues.length; i++) {
      const val = mtfValues[i];
      if (val === 0) {
        zeroCount++;
      } else {
        if (zeroCount > 0) {
          // Output zeroCount using RUNA (0) and RUNB (1)
          let z = zeroCount;
          while (z > 0) {
            if (z % 2 === 1) {
              rleSymbols.push(0); // RUNA
              z = (z - 1) / 2;
            } else {
              rleSymbols.push(1); // RUNB
              z = (z - 2) / 2;
            }
          }
          zeroCount = 0;
        }
        rleSymbols.push(val + 1);
      }
    }
    if (zeroCount > 0) {
      let z = zeroCount;
      while (z > 0) {
        if (z % 2 === 1) {
          rleSymbols.push(0);
          z = (z - 1) / 2;
        } else {
          rleSymbols.push(1);
          z = (z - 2) / 2;
        }
      }
    }
    // End of block symbol: numSymbols + 1
    const eobSymbol = numSymbols + 1;
    rleSymbols.push(eobSymbol);

    const alphaSize = numSymbols + 2;

    // 5. Build Canonical Huffman Tree
    // Frequency counts
    const freqs = new Int32Array(alphaSize);
    for (const sym of rleSymbols) freqs[sym]++;

    // Simple length calculation (Package-Merge or priority queue)
    interface Node {
      sym?: number;
      freq: number;
      depth: number;
      left?: Node;
      right?: Node;
    }
    const nodes: Node[] = [];
    for (let i = 0; i < alphaSize; i++) {
      nodes.push({ sym: i, freq: Math.max(1, freqs[i]), depth: 0 });
    }

    while (nodes.length > 1) {
      nodes.sort((a, b) => a.freq - b.freq);
      const left = nodes.shift()!;
      const right = nodes.shift()!;
      nodes.push({
        freq: left.freq + right.freq,
        depth: 0,
        left,
        right,
      });
    }

    const codeLengths = new Uint8Array(alphaSize);
    function assignDepths(node: Node, depth: number) {
      if (node.sym !== undefined) {
        codeLengths[node.sym] = Math.min(20, Math.max(1, depth));
        return;
      }
      if (node.left) assignDepths(node.left, depth + 1);
      if (node.right) assignDepths(node.right, depth + 1);
    }
    assignDepths(nodes[0], 0);

    // Generate canonical codes from codeLengths
    const codes = new Uint32Array(alphaSize);
    let code = 0;
    for (let len = 1; len <= 20; len++) {
      for (let i = 0; i < alphaSize; i++) {
        if (codeLengths[i] === len) {
          codes[i] = code++;
        }
      }
      code <<= 1;
    }

    // 6. Write block header
    // Block magic: 0x314159265359 (PI)
    bw.writeByte(0x31);
    bw.writeByte(0x41);
    bw.writeByte(0x59);
    bw.writeByte(0x26);
    bw.writeByte(0x53);
    bw.writeByte(0x59);

    // Block CRC (32 bits)
    bw.writeBits(blockCrc, 32);

    // Randomized bit (0)
    bw.writeBits(0, 1);

    // OrigPtr (24 bits)
    bw.writeBits(origPtr, 24);

    // InUse bitmaps
    for (let i = 0; i < 16; i++) {
      bw.writeBits(inUse16[i], 1);
    }
    for (let i = 0; i < 16; i++) {
      if (inUse16[i]) {
        for (let j = 0; j < 16; j++) {
          bw.writeBits(inUse[i * 16 + j], 1);
        }
      }
    }

    // Number of trees: minimum 2 trees required by bzip2 format
    const numTrees = 2;
    bw.writeBits(numTrees, 3);

    // Number of selectors
    const numGroups = Math.ceil(rleSymbols.length / 50);
    bw.writeBits(numGroups, 15);

    // Write selectors: all select tree 0 (MTF value 0 -> unary 0)
    for (let i = 0; i < numGroups; i++) {
      bw.writeBits(0, 1); // 0 in unary
    }

    // Write code lengths for each tree
    for (let t = 0; t < numTrees; t++) {
      let curLen = codeLengths[0];
      bw.writeBits(curLen, 5);
      for (let i = 0; i < alphaSize; i++) {
        const targetLen = codeLengths[i];
        while (curLen < targetLen) {
          bw.writeBits(0b10, 2); // increment
          curLen++;
        }
        while (curLen > targetLen) {
          bw.writeBits(0b11, 2); // decrement
          curLen--;
        }
        bw.writeBits(0, 1); // end of symbol
      }
    }

    // Write encoded symbols
    for (const sym of rleSymbols) {
      bw.writeBits(codes[sym], codeLengths[sym]);
    }
  }

  // End of stream header: 0x177245385090
  bw.writeByte(0x17);
  bw.writeByte(0x72);
  bw.writeByte(0x45);
  bw.writeByte(0x38);
  bw.writeByte(0x50);
  bw.writeByte(0x90);

  // Combined stream CRC (32 bits)
  bw.writeBits(combinedCrc, 32);

  return bw.finish();
}

/**
 * Decompresses a standard bzip2 buffer.
 */
export function decompressBzip2(input: Buffer): Buffer {
  if (input.length < 14) {
    throw new Error('Invalid Bzip2 file: buffer too short.');
  }

  if (
    input[0] !== 0x42 || // 'B'
    input[1] !== 0x5a || // 'Z'
    input[2] !== 0x68    // 'h'
  ) {
    throw new Error('Invalid Bzip2 file signature.');
  }

  const reader = new BitReader(input.subarray(4));
  const outputChunks: Buffer[] = [];

  while (true) {
    // Check next 48 bits for block magic or stream end magic
    const b0 = reader.readBits(8);
    const b1 = reader.readBits(8);
    const b2 = reader.readBits(8);
    const b3 = reader.readBits(8);
    const b4 = reader.readBits(8);
    const b5 = reader.readBits(8);

    if (b0 === 0x17 && b1 === 0x72 && b2 === 0x45 && b3 === 0x38 && b4 === 0x50 && b5 === 0x90) {
      // End of stream
      break;
    }

    if (b0 !== 0x31 || b1 !== 0x41 || b2 !== 0x59 || b3 !== 0x26 || b4 !== 0x53 || b5 !== 0x59) {
      throw new Error(`Invalid Bzip2 block header: ${b0.toString(16)} ${b1.toString(16)}...`);
    }

    const blockCrc = reader.readBits(32);
    const randomized = reader.readBit();
    if (randomized !== 0) {
      throw new Error('Bzip2 randomized blocks are not supported.');
    }

    const origPtr = reader.readBits(24);

    // Read in-use bitmap
    const inUse16 = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      inUse16[i] = reader.readBit();
    }

    const inUse = new Uint8Array(256);
    for (let i = 0; i < 16; i++) {
      if (inUse16[i]) {
        for (let j = 0; j < 16; j++) {
          inUse[i * 16 + j] = reader.readBit();
        }
      }
    }

    const symMap: number[] = [];
    for (let i = 0; i < 256; i++) {
      if (inUse[i]) symMap.push(i);
    }
    const numSymbols = symMap.length;
    const alphaSize = numSymbols + 2;

    const numTrees = reader.readBits(3);
    const numSelectors = reader.readBits(15);

    // MTF list of trees 0..numTrees-1
    const mtfTrees = Array.from({ length: numTrees }, (_, i) => i);
    const selectors = new Uint8Array(numSelectors);
    for (let i = 0; i < numSelectors; i++) {
      let count = 0;
      while (reader.readBit() !== 0) count++;
      const tree = mtfTrees[count];
      mtfTrees.splice(count, 1);
      mtfTrees.unshift(tree);
      selectors[i] = tree;
    }

    // Read code lengths for each tree
    const treeLengths: Uint8Array[] = [];
    for (let t = 0; t < numTrees; t++) {
      const lengths = new Uint8Array(alphaSize);
      let curLen = reader.readBits(5);
      for (let i = 0; i < alphaSize; i++) {
        while (reader.readBit() !== 0) {
          if (reader.readBit() === 0) {
            curLen++;
          } else {
            curLen--;
          }
        }
        lengths[i] = curLen;
      }
      treeLengths.push(lengths);
    }

    // Build decoding tables for each tree
    interface HuffmanTable {
      minLen: number;
      maxLen: number;
      base: Int32Array;
      limit: Int32Array;
      perm: Int32Array;
      permOffset: Int32Array;
    }

    const tables: HuffmanTable[] = treeLengths.map((lengths) => {
      let minLen = 32;
      let maxLen = 0;
      for (let i = 0; i < alphaSize; i++) {
        if (lengths[i] > maxLen) maxLen = lengths[i];
        if (lengths[i] < minLen && lengths[i] > 0) minLen = lengths[i];
      }

      const base = new Int32Array(maxLen + 2);
      const limit = new Int32Array(maxLen + 2);
      const perm = new Int32Array(alphaSize);
      const permOffset = new Int32Array(maxLen + 2);

      let pp = 0;
      for (let len = minLen; len <= maxLen; len++) {
        permOffset[len] = pp;
        for (let i = 0; i < alphaSize; i++) {
          if (lengths[i] === len) {
            perm[pp++] = i;
          }
        }
      }

      let code = 0;
      for (let len = minLen; len <= maxLen; len++) {
        base[len] = code;
        const count = lengths.filter((l) => l === len).length;
        code += count;
        limit[len] = code - 1;
        code <<= 1;
      }

      return { minLen, maxLen, base, limit, perm, permOffset };
    });

    // Decode symbols
    const mtfList = [...symMap];
    let groupIdx = 0;
    let groupCount = 0;
    let curTable = tables[selectors[0]];

    const eob = numSymbols + 1;
    const decodedBytes: number[] = [];

    while (true) {
      if (groupCount === 50) {
        groupIdx++;
        groupCount = 0;
        curTable = tables[selectors[groupIdx]];
      }
      groupCount++;

      // Read symbol using curTable
      let len = curTable.minLen;
      let code = reader.readBits(len);
      while (len <= curTable.maxLen && code > curTable.limit[len]) {
        len++;
        code = (code << 1) | reader.readBit();
      }

      const sym = curTable.perm[curTable.permOffset[len] + (code - curTable.base[len])];
      if (sym === eob) break;

      if (sym === 0 || sym === 1) {
        // RLE of zero
        let run = 0;
        let mult = 1;
        let s = sym;
        while (true) {
          if (s === 0) run += 1 * mult;
          else if (s === 1) run += 2 * mult;
          mult <<= 1;

          // Peek ahead
          if (groupCount === 50) {
            groupIdx++;
            groupCount = 0;
            curTable = tables[selectors[groupIdx]];
          }
          groupCount++;

          len = curTable.minLen;
          code = reader.readBits(len);
          while (len <= curTable.maxLen && code > curTable.limit[len]) {
            len++;
            code = (code << 1) | reader.readBit();
          }
          s = curTable.perm[curTable.permOffset[len] + (code - curTable.base[len])];
          if (s !== 0 && s !== 1) {
            // Non-zero symbol found, stop run
            break;
          }
        }
        const b = mtfList[0];
        for (let r = 0; r < run; r++) decodedBytes.push(b);
        if (s === eob) break;
        // Process s
        const val = s - 1;
        const bReal = mtfList[val];
        decodedBytes.push(bReal);
        mtfList.splice(val, 1);
        mtfList.unshift(bReal);
      } else {
        const val = sym - 1;
        const b = mtfList[val];
        decodedBytes.push(b);
        mtfList.splice(val, 1);
        mtfList.unshift(b);
      }
    }


    // Inverse BWT
    const n = decodedBytes.length;
    const lCol = new Uint8Array(decodedBytes);

    // Compute frequency counts for each byte
    const count = new Int32Array(256);
    for (let i = 0; i < n; i++) count[lCol[i]]++;

    // Cumulative sum
    const base = new Int32Array(256);
    let sum = 0;
    for (let i = 0; i < 256; i++) {
      base[i] = sum;
      sum += count[i];
    }

    const tt = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const b = lCol[i];
      tt[base[b]++] = i;
    }

    // Reconstruct block
    const outBuf = Buffer.alloc(n);
    let ptr = origPtr;
    for (let i = 0; i < n; i++) {
      ptr = tt[ptr];
      outBuf[i] = lCol[ptr];
    }

    // Verify block CRC
    const actualCrc = computeBzBlockCrc(outBuf);
    if (actualCrc !== blockCrc) {
      throw new Error(`Bzip2 CRC mismatch: expected 0x${blockCrc.toString(16)}, got 0x${actualCrc.toString(16)}`);
    }

    outputChunks.push(outBuf);
  }

  return Buffer.concat(outputChunks);
}
