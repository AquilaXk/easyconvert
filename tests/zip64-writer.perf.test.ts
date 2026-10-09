import { describe } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeZipFile } from '../src/lib/conversions/zip-writer';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { proseText, SeededRandom } from './helpers/archive-corpus';
import { expectNoSlowerThanReference } from './helpers/timing';

/**
 * Timing-ratio checks moved out of zip64-writer.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 */

// skip-ok: explicit opt-out (ARCHIVE_SKIP_TIMING=1) of the timing ratios on a slow shared runner, never set in CI.
const SKIP_TIMING = process.env.ARCHIVE_SKIP_TIMING === '1';
const TEST_TIMEOUT_MS = 180_000;

function scratchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zip-writer-'));
}

describe.skipIf(SKIP_TIMING)('ZIP writer throughput', () => {
  oracleTest(
    'writes a mixed corpus in no more than 1.25x the time of `zip -6`',
    ['zip'],
    async () => {
      const zip = getOracleToolPath('zip')!;
      const dir = scratchDir();
      const files: Array<{ name: string; data: Buffer }> = [];
      const jpeg = fs.readFileSync(path.join(__dirname, '..', 'bench', 'corpus', 'photo-a.jpg'));
      for (let i = 0; i < 12; i++) files.push({ name: `text${i}.txt`, data: proseText(1_500_000, 100 + i) });
      for (let i = 0; i < 6; i++) files.push({ name: `noise${i}.bin`, data: new SeededRandom(200 + i).bytes(1_000_000) });
      for (let i = 0; i < 6; i++) files.push({ name: `photo${i}.jpg`, data: jpeg });
      for (const f of files) fs.writeFileSync(path.join(dir, f.name), f.data);
      const names = files.map((f) => f.name);
      const referenceFile = path.join(dir, 'reference.zip');
      const oursFile = path.join(dir, 'ours.zip');
      await expectNoSlowerThanReference(
        'zip writer against zip -6',
        () => {
          fs.rmSync(referenceFile, { force: true });
          execFileSync(zip, ['-6', '-q', '-X', referenceFile, ...names], { cwd: dir });
        },
        async () => {
          await writeZipFile(oursFile, files.map((f) => ({ name: f.name, data: fs.readFileSync(path.join(dir, f.name)), level: 6 })));
        },
        { maxRatio: 1.25, passes: 5 }
      );
      execFileSync(getOracleToolPath('unzip')!, ['-tq', oursFile]);
    },
    TEST_TIMEOUT_MS
  );
});
