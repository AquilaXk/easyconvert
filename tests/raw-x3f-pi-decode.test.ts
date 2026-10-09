import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { RawDecodeError } from '../src/lib/types';
import { OracleToolMissingError } from './helpers/differential-oracle';
import { readPiFrame, readX3fContainer } from './helpers/raw-container-oracle';
import { ENABLED, STRICT_MODE, SAMPLES, load, samplePath, type SampleName } from './helpers/raw-sample-set';

/** Hang guard: a hostile header is rejected in milliseconds; decoding the largest real sample takes about ten seconds. */
const HOSTILE_HANG_GUARD_MS = 15_000;

describe('in-process RAW sample files', () => {
  it.skipIf(!STRICT_MODE)('are present in strict mode', () => {
    const missing = SAMPLES.filter((name) => !existsSync(samplePath(name)));
    if (missing.length > 0) throw new OracleToolMissingError('raw-fixtures', `${missing.join(', ')} samples missing. Run npm run fixtures:raw.`);
    expect(missing).toEqual([]);
  });
});

/** Runs a conversion that must fail with a RawDecodeError, quickly. */
async function expectRejected(file: Buffer, format: string, message: RegExp, unrecognized = false): Promise<void> {
  const started = performance.now();
  const error = await dispatchConversion(file, format, 'png', {}, `hostile.${format}`).catch((e: unknown) => e);
  expect(performance.now() - started).toBeLessThan(HOSTILE_HANG_GUARD_MS);
  expect(error).toBeInstanceOf(RawDecodeError);
  expect((error as RawDecodeError).message).toMatch(message);
  // A layout the decoder does not know is reported as unrecognized; a damaged one is not.
  expect((error as RawDecodeError).unrecognized).toBe(unrecognized);
}

describe.skipIf(!ENABLED)('Raspberry Pi RAW hostile input', () => {
  const mutate = (change: (file: Buffer, trailer: number) => Buffer | void): Buffer => {
    const file = Buffer.from(load('raw'));
    const trailer = file.indexOf('BRCM', 0, 'latin1');
    return change(file, trailer) ?? file;
  };
  const OFFSET_STRIDE = 0xa0;
  const OFFSET_WIDTH = 0xd0;
  const OFFSET_HEIGHT = 0xd2;
  const OFFSET_ORDER = 0xf4;
  const OFFSET_WIDTH_COPY = 0x10e;
  const OFFSET_HEIGHT_COPY = 0x110;
  const OFFSET_NAME = 0x10;

  it('rejects sensor data cut in half', async () => {
    await expectRejected(mutate((file, trailer) => file.subarray(0, trailer + 32768 + 3_000_000)), 'raw', /truncated/);
  });

  it('rejects a header block cut short', async () => {
    await expectRejected(mutate((file, trailer) => file.subarray(0, trailer + 1000)), 'raw', /cut short/);
  });

  it('rejects a frame size above the pixel limit', async () => {
    const huge = 65532;
    const file = mutate((buffer, trailer) => {
      buffer.writeUInt16LE(huge, trailer + OFFSET_WIDTH);
      buffer.writeUInt16LE(huge, trailer + OFFSET_HEIGHT);
      buffer.writeUInt16LE(huge, trailer + OFFSET_WIDTH_COPY);
      buffer.writeUInt16LE(huge, trailer + OFFSET_HEIGHT_COPY);
      buffer.writeUInt32LE(81920, trailer + OFFSET_STRIDE);
    });
    await expectRejected(file, 'raw', /larger than/);
  });

  it('rejects disagreeing copies of the frame size', async () => {
    await expectRejected(mutate((file, trailer) => void file.writeUInt16LE(2000, trailer + OFFSET_WIDTH_COPY)), 'raw', /disagree/);
  });

  it('rejects a stride that does not fit the declared width', async () => {
    await expectRejected(mutate((file, trailer) => void file.writeUInt32LE(4000, trailer + OFFSET_STRIDE)), 'raw', /stride/, true);
  });

  it('rejects an unknown Bayer order', async () => {
    await expectRejected(mutate((file, trailer) => void (file[trailer + OFFSET_ORDER] = 9)), 'raw', /Bayer order/);
  });

  it('rejects a sensor without calibration', async () => {
    await expectRejected(mutate((file, trailer) => void file.write('zz9999', trailer + OFFSET_NAME, 'latin1')), 'raw', /no calibration/, true);
  });

  it('rejects an unterminated sensor name', async () => {
    await expectRejected(mutate((file, trailer) => void file.fill(0x41, trailer + OFFSET_NAME, trailer + OFFSET_NAME + 100)), 'raw', /sensor name/);
  });
});

describe.skipIf(!ENABLED)('Sigma X3F hostile input', () => {
  const OFFSET_DIRECTORY_ENTRY_LENGTH = 4;
  const IMAGE_HEADER_BYTES = 28;
  const mutate = (change: (file: Buffer) => Buffer | void): Buffer => {
    const file = Buffer.from(load('x3f'));
    return change(file) ?? file;
  };
  const directoryOf = (file: Buffer) => file.readUInt32LE(file.length - 4);

  it('rejects a file cut after most of its sensor data', async () => {
    await expectRejected(mutate((file) => file.subarray(0, Math.floor(file.length * 0.6))), 'x3f', /malformed/);
  });

  it('rejects a directory pointer past the end of the file', async () => {
    await expectRejected(mutate((file) => void file.writeUInt32LE(file.length + 100, file.length - 4)), 'x3f', /outside the file/);
  });

  it('rejects a section that extends past the end of the file', async () => {
    const file = mutate((buffer) => {
      const entry = directoryOf(buffer) + 12;
      buffer.writeUInt32LE(0xfffffff0, entry + OFFSET_DIRECTORY_ENTRY_LENGTH);
    });
    await expectRejected(file, 'x3f', /outside the file/);
  });

  it('rejects an absurd section count', async () => {
    await expectRejected(mutate((file) => void file.writeUInt32LE(0x7fffffff, directoryOf(file) + 8)), 'x3f', /lists \d+ sections/);
  });

  it('rejects sensor dimensions above the pixel limit before allocating', async () => {
    const container = readX3fContainer(load('x3f'));
    const file = mutate((buffer) => {
      buffer.writeUInt32LE(60000, container.sensorDataOffset - IMAGE_HEADER_BYTES + 16);
      buffer.writeUInt32LE(60000, container.sensorDataOffset - IMAGE_HEADER_BYTES + 20);
    });
    await expectRejected(file, 'x3f', /pixel limit/);
  });

  it('rejects a plane that extends past its section', async () => {
    const container = readX3fContainer(load('x3f'));
    const file = mutate((buffer) => {
      // Plane sizes follow the seeds (8 bytes) and the Huffman table, which ends with a zero length byte.
      let at = container.sensorDataOffset + 8;
      while (buffer[at] !== 0) at += 2;
      buffer.writeUInt32LE(0xffffff00, at + 2);
    });
    await expectRejected(file, 'x3f', /extends past its section/);
  });

  it('rejects a Huffman table that is never terminated', async () => {
    const container = readX3fContainer(load('x3f'));
    const file = mutate((buffer) => {
      buffer.fill(0x41, container.sensorDataOffset + 8, container.sensorDataOffset + 8 + 600);
    });
    await expectRejected(file, 'x3f', /Huffman table/);
  });

  it('rejects a calibration block that claims an enormous decoded size', async () => {
    const file = mutate((buffer) => {
      const directory = directoryOf(buffer);
      const count = buffer.readUInt32LE(directory + 8);
      for (let index = 0; index < count; index += 1) {
        const entry = directory + 12 + index * 12;
        if (buffer.toString('latin1', entry + 8, entry + 12) === 'CAMF') buffer.writeUInt32LE(0xfffffff0, buffer.readUInt32LE(entry) + 12);
      }
    });
    await expectRejected(file, 'x3f', /CAMF/);
  });

  it('rejects a calibration block cut down to its header', async () => {
    const file = mutate((buffer) => {
      const directory = directoryOf(buffer);
      const count = buffer.readUInt32LE(directory + 8);
      for (let index = 0; index < count; index += 1) {
        const entry = directory + 12 + index * 12;
        if (buffer.toString('latin1', entry + 8, entry + 12) === 'CAMF') buffer.writeUInt32LE(40, entry + OFFSET_DIRECTORY_ENTRY_LENGTH);
      }
    });
    await expectRejected(file, 'x3f', /Huffman table/);
  });
});

/** Location of the sensor section of an X3F file, read by the independent container parser. */
function sensorSection(file: Buffer) {
  const container = readX3fContainer(file);
  const start = container.sensorDataOffset - IMAGE_HEADER_BYTES;
  return { start, payload: container.sensorDataOffset, end: start + container.sensorSectionLength, rows: container.sensorHeight };
}
const IMAGE_HEADER_BYTES = 28;
const OFFSET_IMAGE_FORMAT = 12;
const OFFSET_IMAGE_COLUMNS = 16;
const OFFSET_IMAGE_ROWS = 20;

/** Rewrites the length of the directory entry that points at `sectionStart`. */
function setSectionLength(file: Buffer, sectionStart: number, length: number): void {
  const directory = file.readUInt32LE(file.length - 4);
  const count = file.readUInt32LE(directory + 8);
  for (let index = 0; index < count; index += 1) {
    const entry = directory + 12 + index * 12;
    if (file.readUInt32LE(entry) === sectionStart) {
      file.writeUInt32LE(length, entry + 4);
      return;
    }
  }
  throw new Error('no directory entry for the sensor section');
}

describe.skipIf(!ENABLED)('Sigma X3F sensor format hostile input', () => {
  const mutate = (name: SampleName, change: (file: Buffer) => Buffer | void): Buffer => {
    const file = Buffer.from(load(name));
    return change(file) ?? file;
  };

  it.each(['x3f-sd14', 'x3f-merrill', 'x3f-quattro'] as const)('rejects an unknown sensor data format in %s as unrecognized', async (name) => {
    const file = mutate(name, (buffer) => void buffer.writeUInt32LE(0x77, sensorSection(buffer).start + OFFSET_IMAGE_FORMAT));
    await expectRejected(file, 'x3f', /sensor data \(type \d+ format 0x77\) is not supported/, true);
  });

  it('rejects a container version above 4 as unrecognized', async () => {
    const file = mutate('x3f-quattro', (buffer) => void buffer.writeUInt32LE(5 << 16, 4));
    await expectRejected(file, 'x3f', /version 5\.0 is not supported/, true);
  });
});

describe.skipIf(!ENABLED)('Sigma SD14 (Huffman) hostile input', () => {
  const HUFFMAN_TABLE_ENTRIES = 1024;
  const CODE_TABLE_OFFSET = IMAGE_HEADER_BYTES + HUFFMAN_TABLE_ENTRIES * 2;
  const mutate = (change: (file: Buffer, section: ReturnType<typeof sensorSection>) => Buffer | void): Buffer => {
    const file = Buffer.from(load('x3f-sd14'));
    return change(file, sensorSection(file)) ?? file;
  };
  const rowOffsetAt = (section: ReturnType<typeof sensorSection>, row: number) => section.end - section.rows * 4 + row * 4;
  /** Indexes of the used code words (length in the top 5 bits). */
  const usedCodes = (file: Buffer, section: ReturnType<typeof sensorSection>) =>
    Array.from({ length: HUFFMAN_TABLE_ENTRIES }, (_, index) => index).filter((index) => file.readUInt32LE(section.start + CODE_TABLE_OFFSET + index * 4) !== 0);

  it('rejects a file cut after most of its sensor data', async () => {
    await expectRejected(mutate((file) => file.subarray(0, Math.floor(file.length * 0.6))), 'x3f', /malformed/);
  });

  it('rejects a row offset past the end of the data', async () => {
    await expectRejected(mutate((file, section) => void file.writeUInt32LE(0xfffffff0, rowOffsetAt(section, 10))), 'x3f', /lies outside the sensor data/);
  });

  it('rejects row offsets that run backwards', async () => {
    await expectRejected(
      mutate((file, section) => void file.writeUInt32LE(file.readUInt32LE(rowOffsetAt(section, 9)) - 100, rowOffsetAt(section, 10))),
      'x3f',
      /lies outside the sensor data/
    );
  });

  it('rejects a row too short to hold one bit per sample', async () => {
    await expectRejected(
      mutate((file, section) => void file.writeUInt32LE(file.readUInt32LE(rowOffsetAt(section, 4)) + 1, rowOffsetAt(section, 5))),
      'x3f',
      /is too small for \d+ pixels/
    );
  });

  it('rejects a section shorter than its tables', async () => {
    const file = mutate((buffer, section) => setSectionLength(buffer, section.start, CODE_TABLE_OFFSET + 100));
    await expectRejected(file, 'x3f', /shorter than its tables/);
  });

  it('rejects sensor dimensions above the pixel limit before allocating', async () => {
    const file = mutate((buffer, section) => {
      buffer.writeUInt32LE(60000, section.start + OFFSET_IMAGE_COLUMNS);
      buffer.writeUInt32LE(60000, section.start + OFFSET_IMAGE_ROWS);
    });
    await expectRejected(file, 'x3f', /pixel limit/);
  });

  it('rejects two identical code words', async () => {
    const file = mutate((buffer, section) => {
      const [first, second] = usedCodes(buffer, section);
      buffer.writeUInt32LE(buffer.readUInt32LE(section.start + CODE_TABLE_OFFSET + first * 4), section.start + CODE_TABLE_OFFSET + second * 4);
    });
    await expectRejected(file, 'x3f', /overlapping codes/);
  });

  it('rejects a code word that is a prefix of another', async () => {
    const SHORT_PREFIX = (1 << 27) | 0;
    const file = mutate((buffer, section) => {
      const used = usedCodes(buffer, section);
      buffer.writeUInt32LE(SHORT_PREFIX, section.start + CODE_TABLE_OFFSET + used[0] * 4);
      buffer.writeUInt32LE(SHORT_PREFIX, section.start + CODE_TABLE_OFFSET + used[used.length - 1] * 4 + 0);
    });
    await expectRejected(file, 'x3f', /overlapping codes/);
  });

  it('rejects a code word longer than 26 bits', async () => {
    const file = mutate((buffer, section) => void buffer.writeUInt32LE(((31 << 27) | 1) >>> 0, section.start + CODE_TABLE_OFFSET + usedCodes(buffer, section)[0] * 4));
    await expectRejected(file, 'x3f', /bits long/);
  });

  it('rejects data that uses a code the table does not define', async () => {
    const file = mutate((buffer, section) => {
      buffer.fill(0, section.start + CODE_TABLE_OFFSET, section.start + CODE_TABLE_OFFSET + HUFFMAN_TABLE_ENTRIES * 4);
      buffer.writeUInt32LE((1 << 27) | 1, section.start + CODE_TABLE_OFFSET);
    });
    await expectRejected(file, 'x3f', /unassigned Huffman code/);
  });
});

describe.skipIf(!ENABLED)('Sigma Merrill hostile input', () => {
  const mutate = (change: (file: Buffer, section: ReturnType<typeof sensorSection>) => Buffer | void): Buffer => {
    const file = Buffer.from(load('x3f-merrill'));
    return change(file, sensorSection(file)) ?? file;
  };
  const SEED_BYTES = 8;
  /** Offset of the byte after the Huffman table's terminating zero length. */
  const afterTable = (file: Buffer, from: number) => {
    let at = from;
    while (file[at] !== 0) at += 2;
    return at + 2;
  };

  it('rejects a file cut after most of its sensor data', async () => {
    await expectRejected(mutate((file) => file.subarray(0, Math.floor(file.length * 0.6))), 'x3f', /malformed/);
  });

  it('rejects sensor dimensions above the pixel limit before allocating', async () => {
    const file = mutate((buffer, section) => {
      buffer.writeUInt32LE(5000, section.start + OFFSET_IMAGE_COLUMNS);
      buffer.writeUInt32LE(4000, section.start + OFFSET_IMAGE_ROWS);
    });
    await expectRejected(file, 'x3f', /pixel limit/);
  });

  it('rejects a plane that extends past its section', async () => {
    const file = mutate((buffer, section) => void buffer.writeUInt32LE(0xffffff00, afterTable(buffer, section.payload + SEED_BYTES)));
    await expectRejected(file, 'x3f', /extends past its section/);
  });

  it('rejects a plane too small for its samples', async () => {
    const file = mutate((buffer, section) => void buffer.writeUInt32LE(64, afterTable(buffer, section.payload + SEED_BYTES)));
    await expectRejected(file, 'x3f', /too small for 4928x3264 samples/);
  });

  it('rejects a Huffman table that is never terminated', async () => {
    const file = mutate((buffer, section) => void buffer.fill(0x41, section.payload + SEED_BYTES, section.payload + SEED_BYTES + 600));
    await expectRejected(file, 'x3f', /Huffman table/);
  });
});

describe.skipIf(!ENABLED)('Sigma Quattro hostile input', () => {
  const mutate = (change: (file: Buffer, section: ReturnType<typeof sensorSection>) => Buffer | void): Buffer => {
    const file = Buffer.from(load('x3f-quattro'));
    return change(file, sensorSection(file)) ?? file;
  };
  const LAYER_DIMENSION_BYTES = 12;
  const SEED_BYTES = 8;
  const afterTable = (file: Buffer, from: number) => {
    let at = from;
    while (file[at] !== 0) at += 2;
    return at + 2;
  };
  const tableStart = (section: ReturnType<typeof sensorSection>) => section.payload + LAYER_DIMENSION_BYTES + SEED_BYTES;

  it('rejects a file cut after most of its sensor data', async () => {
    await expectRejected(mutate((file) => file.subarray(0, Math.floor(file.length * 0.6))), 'x3f', /malformed/);
  });

  it('rejects a top layer above the pixel limit before allocating', async () => {
    const MAX_U16 = 65535;
    const file = mutate((buffer, section) => {
      buffer.writeUInt16LE(MAX_U16, section.payload + 8);
      buffer.writeUInt16LE(MAX_U16, section.payload + 10);
    });
    await expectRejected(file, 'x3f', /pixel limit/);
  });

  it('rejects a lower layer that is not half the top layer', async () => {
    await expectRejected(mutate((file, section) => void file.writeUInt16LE(100, section.payload)), 'x3f', /does not match half the top layer/);
  });

  it('rejects a lower layer of a single column', async () => {
    const file = mutate((buffer, section) => {
      buffer.writeUInt16LE(1, section.payload);
      buffer.writeUInt16LE(1, section.payload + 4);
    });
    await expectRejected(file, 'x3f', /does not match half the top layer/);
  });

  it('rejects an unknown word between the Huffman table and the plane sizes as unrecognized', async () => {
    const file = mutate((buffer, section) => void buffer.writeUInt32LE(7, afterTable(buffer, tableStart(section))));
    await expectRejected(file, 'x3f', /unknown header word/, true);
  });

  it('rejects a plane that extends past its section', async () => {
    const file = mutate((buffer, section) => void buffer.writeUInt32LE(0xffffff00, afterTable(buffer, tableStart(section)) + 4));
    await expectRejected(file, 'x3f', /extends past its section/);
  });

  it('rejects a plane too small for its samples', async () => {
    const file = mutate((buffer, section) => void buffer.writeUInt32LE(64, afterTable(buffer, tableStart(section)) + 4 + 8));
    await expectRejected(file, 'x3f', /layer 2 is too small for 6272x3672 samples/);
  });

  it('rejects a Huffman table that is never terminated', async () => {
    const file = mutate((buffer, section) => void buffer.fill(0x41, tableStart(section), tableStart(section) + 600));
    await expectRejected(file, 'x3f', /Huffman table/);
  });

  it('rejects a section cut down to its layer sizes', async () => {
    const file = mutate((buffer, section) => setSectionLength(buffer, section.start, IMAGE_HEADER_BYTES + 6));
    await expectRejected(file, 'x3f', /shorter than its header/);
  });
});

describe.skipIf(!ENABLED)('Raspberry Pi imx219 and imx477 hostile input', () => {
  const OFFSET_STRIDE = 0xa0;
  const OFFSET_WIDTH = 0xd0;
  const OFFSET_HEIGHT = 0xd2;
  const OFFSET_BIT_DEPTH = 0xf6;
  const PI_HEADER_BYTES = 32768;
  const OFFSET_WIDTH_COPY = 0x10e;
  const OFFSET_HEIGHT_COPY = 0x110;
  const mutate = (name: SampleName, change: (file: Buffer, trailer: number) => Buffer | void): Buffer => {
    const file = Buffer.from(load(name));
    return change(file, readPiFrame(file).sensorDataOffset - PI_HEADER_BYTES) ?? file;
  };

  it('rejects imx477 sensor data cut in half', async () => {
    await expectRejected(mutate('raw-imx477', (file, trailer) => file.subarray(0, trailer + 32768 + 9_000_000)), 'raw', /truncated/);
  });

  it('rejects an imx477 dump that claims 10 bits per pixel as unrecognized', async () => {
    await expectRejected(mutate('raw-imx477', (file, trailer) => void (file[trailer + OFFSET_BIT_DEPTH] = 10)), 'raw', /10 bits per pixel, not 12/, true);
  });

  it('rejects an imx219 dump that claims 12 bits per pixel as unrecognized', async () => {
    await expectRejected(mutate('raw-imx219', (file, trailer) => void (file[trailer + OFFSET_BIT_DEPTH] = 12)), 'raw', /12 bits per pixel, not 10/, true);
  });

  it('rejects an imx477 stride that does not fit 12-bit rows as unrecognized', async () => {
    const file = mutate('raw-imx477', (buffer, trailer) => void buffer.writeUInt32LE(5152, trailer + OFFSET_STRIDE));
    await expectRejected(file, 'raw', /stride 5152 does not match packed 12-bit rows/, true);
  });

  it('rejects an imx477 frame larger than the sensor array', async () => {
    const file = mutate('raw-imx477', (buffer, trailer) => {
      buffer.writeUInt16LE(4060, trailer + OFFSET_WIDTH);
      buffer.writeUInt16LE(4060, trailer + OFFSET_WIDTH_COPY);
    });
    await expectRejected(file, 'raw', /larger than the 4056x3040 imx477 sensor/);
  });

  it('rejects an imx219 frame larger than the sensor array', async () => {
    const file = mutate('raw-imx219', (buffer, trailer) => {
      buffer.writeUInt16LE(2500, trailer + OFFSET_HEIGHT);
      buffer.writeUInt16LE(2500, trailer + OFFSET_HEIGHT_COPY);
    });
    await expectRejected(file, 'raw', /larger than the 3280x2464 imx219 sensor/);
  });

  it('rejects an imx477 frame width that does not fill whole pixel pairs', async () => {
    const file = mutate('raw-imx477', (buffer, trailer) => {
      buffer.writeUInt16LE(4055, trailer + OFFSET_WIDTH);
      buffer.writeUInt16LE(4055, trailer + OFFSET_WIDTH_COPY);
    });
    await expectRejected(file, 'raw', /unsupported frame size 4055x3040/);
  });
});
