import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { HeadingSlugs, githubSlug } from '../src/lib/conversions/github-slug';

/**
 * The ids of headings against the 78 test vectors of github-slugger 2.0.0 (tests/fixtures/github-slugger), whose expected
 * values are the ids GitHub gives the same headings: ASCII punctuation, Cyrillic, emoji, every Unicode category GitHub
 * removes or keeps, and repeated headings.
 */

interface Vector {
  name: string;
  input: string;
  expected: string;
}

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'github-slugger', 'fixtures.json'), 'utf8')) as Vector[];

describe('the ids of headings are the ones GitHub gives', () => {
  it('slugs the 78 test vectors of github-slugger in order, numbering the repeated ones', () => {
    const slugs = new HeadingSlugs();
    expect(vectors.map((vector) => slugs.slug(vector.input))).toEqual(vectors.map((vector) => vector.expected));
  });

  it('gives a slug without numbering from githubSlug', () => {
    expect([githubSlug('foo'), githubSlug('foo')]).toEqual(['foo', 'foo']);
  });

  it('numbers a heading whose slug is the numbered slug of an earlier one past it, and keeps names such as __proto__', () => {
    const slugs = new HeadingSlugs();
    expect(['echo', 'echo', 'echo 1', 'echo-1', 'echo', '__proto__', '__proto__'].map((text) => slugs.slug(text))).toEqual([
      'echo',
      'echo-1',
      'echo-1-1',
      'echo-1-2',
      'echo-2',
      '__proto__',
      '__proto__-1',
    ]);
  });
});
