import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { runWebTool } from '../src/lib/tools/web-tools';
import { ARCHIVE_CREATE_FORMATS } from '../src/lib/jobs/graph-operations';

/**
 * Files of different folders arrive with the same name (a browser gives a file its name, not its folder). An archive of them is
 * made, each name kept once, rather than refused with a collision.
 */
describe('an archive made of files that share a name', () => {
  const same = [
    { name: 'notes.txt', buffer: Buffer.from('first') },
    { name: 'notes.txt', buffer: Buffer.from('second') },
    { name: 'notes.txt', buffer: Buffer.from('third') },
  ];

  it.each([...ARCHIVE_CREATE_FORMATS])('is made in %s', async (format) => {
    const output = await runWebTool('archive-create', same, { format });
    expect(output.kind).toBe('file');
  });

  it('holds each file once under its own name in a ZIP', async () => {
    const output = await runWebTool('archive-create', same, { format: 'zip' });
    if (output.kind !== 'file') throw new Error('a file was expected');
    const zip = await JSZip.loadAsync(output.buffer);
    const names = Object.keys(zip.files).sort();
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
    expect(names).toContain('notes.txt');
    const contents = await Promise.all(names.map(async (name) => zip.file(name)!.async('string')));
    expect(contents.sort()).toEqual(['first', 'second', 'third']);
  });
});
