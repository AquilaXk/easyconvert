import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { FileRetentionLedger, setRetentionLedger } from '../../src/lib/storage/retention-ledger';

/**
 * Gives every test file its own retention ledger. Several tests submit jobs on a fixed upload key, and a hold on it
 * that no job ended would otherwise stay in the ledger under `.easyconvert/storage` and count against the cap of
 * holds on one file in the next run, or in a test file that sweeps.
 */
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-test-ledger-'));
setRetentionLedger(new FileRetentionLedger(ledgerDir));

afterAll(() => {
  setRetentionLedger(undefined);
  fs.rmSync(ledgerDir, { recursive: true, force: true });
});
