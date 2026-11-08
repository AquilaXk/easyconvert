import { describe, expect, it } from 'vitest';
import { toolAccepts } from '../src/hooks/useToolRun';
import { resultNameOf } from '../src/lib/tools/tool-client';
import { defaultToolOptions, TOOLS_WITH_OPTIONS, WEB_TOOLS } from '../src/lib/tools/tool-names';
import { parseConverterSlug } from '../src/lib/slug-parser';

describe('the files a tool page takes', () => {
  it.each([
    ['merge', 'a.PDF', true],
    ['merge', 'a.docx', false],
    ['split', 'book.pdf', true],
    ['rotate', 'photo.png', false],
    ['archive-extract', 'bundle.tar.gz', true],
    ['archive-extract', 'bundle.7z', true],
    ['archive-extract', 'notes.txt', false],
    ['archive-create', 'anything.xyz', true],
  ] as const)('%s takes %s: %s', (tool, name, accepted) => {
    expect(toolAccepts(tool, name)).toBe(accepted);
  });
});

describe('what a tool run is called and starts with', () => {
  it('names each download as the server names it', () => {
    expect(resultNameOf('merge', 'a.pdf', {})).toBe('merged.pdf');
    expect(resultNameOf('archive-create', 'a.txt', { format: '7z' })).toBe('archive.7z');
    expect(resultNameOf('archive-create', 'a.txt', {})).toBe('archive.zip');
    expect(resultNameOf('split', 'book.pdf', {})).toBe('book-split.zip');
    expect(resultNameOf('rotate', 'book.pdf', {})).toBe('book-rotated.pdf');
  });

  it('starts every tool with options its route accepts', () => {
    expect(defaultToolOptions('archive-create')).toEqual({ format: 'zip' });
    expect(defaultToolOptions('rotate')).toEqual({ rotate: { rotation: 90 } });
    expect(defaultToolOptions('split')).toEqual({});
    expect([...TOOLS_WITH_OPTIONS].sort()).toEqual(['archive-create', 'rotate', 'split']);
  });

  it('has a page for each tool at its own path', () => {
    const paths = ['merge-pdf', 'create-zip-archive', 'extract-zip-archive', 'split-pdf', 'rotate-pdf'].map((slug) => parseConverterSlug(slug)?.canonicalPath);
    expect(paths).toEqual(['/merge-pdf', '/create-zip-archive', '/extract-zip-archive', '/split-pdf', '/rotate-pdf']);
    expect(WEB_TOOLS).toHaveLength(paths.length);
  });
});
