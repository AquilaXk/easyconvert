import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('the origins of the pinned corpus files', () => {
  const ROOT = path.resolve(__dirname, '..');
  const addresses = (node: unknown): string[] => {
    if (Array.isArray(node)) return node.flatMap(addresses);
    if (node === null || typeof node !== 'object') return [];
    return Object.entries(node).flatMap(([key, value]) => (typeof value === 'string' && (key === 'url' || key === 'archive') ? [value] : addresses(value)));
  };
  const origins = (...manifests: string[]): string[] => manifests.flatMap((manifest) => addresses(JSON.parse(fs.readFileSync(path.join(ROOT, manifest), 'utf8'))));
  const all = origins('bench/realworld/manifest.json', 'bench/corpus/remote-manifest.json');

  it('read a dated copy or a versioned address wherever the host rebuilds the file in place', () => {
    // Each host below rebuilt a pinned file under the same address and failed a nightly run on its digest, or sent the address
    // through a rate-limited front host (entry 143 of docs/policy-decisions.md).
    const rebuiltInPlace = [/^https:\/\/boot\.ipxe\.org\//, /^https:\/\/www\.gutenberg\.org\/cache\//, /^https:\/\/chroniclingamerica\.loc\.gov\//];
    expect(all.filter((url) => rebuiltInPlace.some((pattern) => pattern.test(url)))).toEqual([]);
  });

  it('name the dated copy of a web archive only in its raw form, which serves the original bytes', () => {
    const captures = all.filter((url) => url.startsWith('https://web.archive.org/'));
    expect(captures.length).toBeGreaterThan(0);
    for (const url of captures) expect(url, url).toMatch(/^https:\/\/web\.archive\.org\/web\/\d{14}id_\/https:\/\//);
  });

  it('list the original address of a web-archive file only as a mirror, so the archive is always tried first', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/corpus/remote-manifest.json'), 'utf8')) as unknown;
    const mirrored = (node: unknown): Array<{ url: string; mirrors: string[] }> => {
      if (Array.isArray(node)) return node.flatMap(mirrored);
      if (node === null || typeof node !== 'object') return [];
      const record = node as { url?: string; mirrors?: string[] };
      return [...(record.mirrors === undefined ? [] : [{ url: record.url ?? '', mirrors: record.mirrors }]), ...Object.values(node).flatMap(mirrored)];
    };
    const found = mirrored(manifest);
    expect(found.length).toBeGreaterThan(0);
    for (const { url, mirrors } of found) {
      expect(mirrors, url).toEqual([url.replace(/^https:\/\/web\.archive\.org\/web\/\d{14}id_\//, '')]);
    }
  });
});
