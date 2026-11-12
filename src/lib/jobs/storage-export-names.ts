import path from 'node:path';
import { sanitizeNodeOutputFilename } from '@/lib/queue/graph/node-jobs';
import { joinRemotePath } from '@/lib/storage/customer-storage-paths';

/**
 * The names an `export.s3` or `export.sftp` node writes its inputs under, and where each lands: one rule for the node that writes
 * and for the report of the task that wrote, so the report names exactly the files the node put.
 */

/** The name of each input as it is written: its file name, with `-<n>` before the extension where an earlier input has the name. */
export function exportedFileNames(inputNames: readonly string[]): string[] {
  const taken = new Set<string>();
  return inputNames.map((raw, index) => {
    const name = sanitizeNodeOutputFilename(raw, `export_${index}.bin`);
    const { name: stem, ext } = path.posix.parse(name);
    let candidate = name;
    for (let n = 2; taken.has(candidate); n++) candidate = `${stem}-${n}${ext}`;
    taken.add(candidate);
    return candidate;
  });
}

/**
 * Where the file `name` lands in the customer's store: an S3 prefix is literal (`out/` is a folder, `out/report-` a name prefix),
 * and an SFTP directory is joined with a slash.
 */
export function exportDestination(op: string, prefixOrDirectory: string | undefined, name: string): string {
  const base = prefixOrDirectory ?? '';
  return op === 'export.s3' ? `${base}${name}` : joinRemotePath(base, name);
}
