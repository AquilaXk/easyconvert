import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LibreOfficePoolManager } from '../src/worker/libreoffice-pool';
import { resolveLocalStagingDir } from '../src/lib/storage/storage-config';

const made: string[] = [];
afterEach(() => {
  for (const p of made.splice(0)) fs.rmSync(p, { force: true, recursive: true });
});

describe('an office pool output without a caller path', () => {
  it('is staged in the swept staging folder, not a folder of its own under the system temp directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-staged-'));
    made.push(dir);
    const produced = path.join(dir, 'out.pdf');
    fs.writeFileSync(produced, '%PDF-1.7\n');

    const pool = new LibreOfficePoolManager({ enabled: false, maxWorkers: 1, minWorkers: 0 });
    const result = (pool as any).buildPersistedResult(produced, 'pdf', 'doc', Date.now(), Buffer.alloc(0), {});
    made.push(result.filePath);

    expect(path.dirname(result.filePath)).toBe(path.resolve(resolveLocalStagingDir()));
    expect(path.basename(result.filePath)).toMatch(/^easyconvert-out-\d{13,}-[0-9a-f-]+\.pdf$/);
    expect(fs.readFileSync(result.filePath, 'utf8')).toBe('%PDF-1.7\n');
  });
});
