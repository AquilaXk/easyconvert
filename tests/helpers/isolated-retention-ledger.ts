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
const isolatedLedger = new FileRetentionLedger(ledgerDir);
setRetentionLedger(isolatedLedger);

/**
 * Puts the ledger of this test file back after a test replaced it. `setRetentionLedger(undefined)` would select the
 * shared default under `.easyconvert/storage` for the rest of the file.
 */
export function restoreIsolatedRetentionLedger(): void {
  setRetentionLedger(isolatedLedger);
}

afterAll(() => {
  setRetentionLedger(undefined);
  fs.rmSync(ledgerDir, { recursive: true, force: true });
});
