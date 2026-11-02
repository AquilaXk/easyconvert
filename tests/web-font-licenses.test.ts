import { describe, expect, it } from 'vitest';
import node_fs from 'node:fs';
import node_path from 'node:path';

/**
 * OFL-1.1 clause 2 requires every copy of a font to carry the copyright notice and the licence text. The web image copies
 * `public/` (Dockerfile.web) and the server serves it, so the two texts live in `public/fonts/licenses/`: a client reads
 * them at `/fonts/licenses/` and an operator finds them in the image.
 */

const REPO_ROOT = process.cwd();
const LICENSE_DIR = node_path.join(REPO_ROOT, 'public', 'fonts', 'licenses');
const FONT_DIR = node_path.join(REPO_ROOT, 'src', 'app', 'fonts');
const LICENSE_HEADING = 'SIL OPEN FONT LICENSE Version 1.1';
const LICENSE_SECTIONS = ['PREAMBLE', 'DEFINITIONS', 'PERMISSION & CONDITIONS', 'TERMINATION', 'DISCLAIMER'];

const FONTS = [
  {
    licence: 'Pretendard-OFL.txt',
    file: 'EasyConvertSans-subset.woff2',
    project: 'Pretendard',
    copyright: 'Copyright (c) 2021, Kil Hyung-jin (https://github.com/orioncactus/pretendard)',
  },
];
/** The one font file the interface ships; a fixed budget keeps a page's first paint light (113 KB on 2026-11-02). */
const FONT_BUDGET_BYTES = 128 * 1024;

describe('Served web fonts carry their OFL text', () => {
  for (const { licence, file, project, copyright } of FONTS) {
    it(`ships the ${project} licence beside the served font`, () => {
      expect(node_fs.existsSync(node_path.join(FONT_DIR, file)), 'font file').toBe(true);
      const licencePath = node_path.join(LICENSE_DIR, licence);
      expect(node_fs.existsSync(licencePath), licencePath).toBe(true);
      const text = node_fs.readFileSync(licencePath, 'utf8');
      expect(text.startsWith(copyright)).toBe(true);
      expect(text).toContain(LICENSE_HEADING);
      for (const section of LICENSE_SECTIONS) expect(text, section).toContain(section);
    });
  }

  it('is copied into the web image with the rest of public/', () => {
    const dockerfile = node_fs.readFileSync(node_path.join(REPO_ROOT, 'Dockerfile.web'), 'utf8');
    expect(dockerfile).toMatch(/COPY --from=webbuilder [^\n]*\/app\/public \.\/public/);
  });

  it('covers every character the messages use, so no heading mixes two faces', () => {
    const covered = new Set(node_fs.readFileSync(node_path.join(FONT_DIR, 'EasyConvertSans-subset.txt'), 'utf8'));
    const used = new Set(
      ['ko', 'en'].flatMap((locale) => {
        const messages = node_fs.readFileSync(node_path.join(REPO_ROOT, 'messages', `${locale}.json`), 'utf8');
        return messages.match(/[^\u0000-\u007f]/g) ?? [];
      }),
    );
    const missing = [...used].filter((character) => !covered.has(character));
    expect(missing, 'rerun scripts/subset-web-font.py').toEqual([]);
  });

  it('ships one font file within the size budget', () => {
    const files = node_fs.readdirSync(FONT_DIR).filter((name) => name.endsWith('.woff2'));
    expect(files).toEqual(['EasyConvertSans-subset.woff2']);
    const bytes = node_fs.statSync(node_path.join(FONT_DIR, files[0])).size;
    expect(bytes).toBeLessThanOrEqual(FONT_BUDGET_BYTES);
    const font = node_fs.readFileSync(node_path.join(FONT_DIR, files[0]));
    expect(font.subarray(0, 4).toString('latin1')).toBe('wOF2');
  });
});
