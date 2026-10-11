import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Rewrites the entries of `folders` in the corpus manifest from the files now on disk and leaves every other entry as
 * it is, so a generator of one part of the corpus does not have to regenerate the rest.
 */
export function refreshManifest(corpusDir: string, folders: readonly string[]): void {
  const manifestPath = path.join(corpusDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { totalBytes: number; files: Array<{ file: string; bytes: number; sha256: string }> };
  const entries = manifest.files.filter((entry) => !folders.some((folder) => entry.file.startsWith(`${folder}/`)));
  for (const folder of folders) {
    for (const name of fs.readdirSync(path.join(corpusDir, folder))) {
      const bytes = fs.readFileSync(path.join(corpusDir, folder, name));
      entries.push({ file: `${folder}/${name}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  entries.sort((a, b) => a.file.localeCompare(b.file));
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  fs.writeFileSync(manifestPath, `${JSON.stringify({ totalBytes, files: entries }, null, 2)}\n`);
}
