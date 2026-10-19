import { describe, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { oracleTest } from './helpers/oracle-test';
import { buildStoredRar4 } from './helpers/rar4-stored';

/**
 * An archive that cannot be converted is refused with a typed answer that names the limit of the file, not with 7-Zip's
 * "malformed or unsupported". Each file below is a few hundred bytes made for the case: a RAR first volume written by hand
 * to the RAR 4.x layout, disk images that are all signature and zeros, and a real cabinet with one byte of data flipped.
 */

const ENGINE_TIMEOUT_MS = 120_000;
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'archive-sources');
const CLASSIC_HFS_SIGNATURE_OFFSET = 1024;
const IMAGE_BYTES = 4096;

async function failureOf(source: Buffer, format: string, name: string): Promise<Error> {
  const failure = await dispatchConversion(source, format, 'zip', {}, name).then(
    () => {
      throw new Error('Expected a typed refusal but the conversion completed');
    },
    (err: unknown) => err
  );
  return failure as Error;
}

describe('the refusals that name the limit of the file', () => {
  oracleTest(
    'the first volume of a multi-volume RAR set says the other parts are missing',
    ['7z'],
    async () => {
      const firstVolume = buildStoredRar4(
        [
          { name: 'a.txt', data: Buffer.from('first file') },
          { name: 'vols/big.txt', data: Buffer.alloc(4000, 0x41) },
        ],
        { firstVolume: true }
      );
      const failure = await failureOf(firstVolume, 'rar', 'part1.rar');
      expect(failure).toMatchObject({ name: 'UnreadableArchiveError' });
      expect(failure.message).toBe(
        'Could not read the archive: it is the first part of a multi-volume set and the next volume, part1.r00, is not part of the upload; upload all parts together as one archive.'
      );
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'a classic HFS volume is named as one',
    ['7z'],
    async () => {
      const volume = Buffer.alloc(IMAGE_BYTES);
      volume.write('BD', CLASSIC_HFS_SIGNATURE_OFFSET, 'latin1');
      const failure = await failureOf(volume, 'img', 'classic.img');
      expect(failure).toMatchObject({ name: 'UnreadableArchiveError' });
      expect(failure.message).toBe(
        'Could not read the archive: it is a classic HFS volume (the Mac OS 8 and earlier format), which is not supported; HFS+ and other current file systems are.'
      );
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'a disk image with no file system 7-Zip reads says so',
    ['7z'],
    async () => {
      for (const fill of [0x00, 0xf6]) {
        const failure = await failureOf(Buffer.alloc(IMAGE_BYTES, fill), 'img', 'blank.img');
        expect(failure, `fill ${fill}`).toMatchObject({ name: 'UnreadableArchiveError' });
        expect(failure.message, `fill ${fill}`).toBe(
          'Could not read the archive: the disk image holds no file system that can be read (it may be blank, unformatted or use an unsupported file system).'
        );
      }
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'an entry whose data does not decode is named',
    ['7z'],
    async () => {
      const cabinet = Buffer.from(fs.readFileSync(path.join(FIXTURE_DIR, 'probe.cab')));
      cabinet[cabinet.length - 30] ^= 0xff;
      const failure = await failureOf(cabinet, 'cab', 'damaged.cab');
      expect(failure).toMatchObject({ name: 'UnreadableArchiveError' });
      expect(failure.message).toBe("Could not read the archive: the data of 'hello.txt' is damaged (7-Zip reports a data error).");
    },
    ENGINE_TIMEOUT_MS
  );
});
