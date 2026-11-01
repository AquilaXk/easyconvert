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
    family: 'InstrumentSans',
    file: 'InstrumentSans-latin.woff2',
    project: 'Instrument Sans',
    copyright: 'Copyright 2022 The Instrument Sans Project Authors (https://github.com/Instrument/instrument-sans)',
  },
  {
    family: 'InstrumentSerif',
    file: 'InstrumentSerif-latin.woff2',
    project: 'Instrument Serif',
    copyright: 'Copyright 2022 The Instrument Serif Project Authors (https://github.com/Instrument/instrument-serif)',
  },
  {
    family: 'NotoSerifKR',
    file: 'NotoSerifKR-hangul-display.woff2',
    project: 'Noto Serif KR',
    copyright: 'Copyright 2012 Google Inc. All Rights Reserved.',
  },
];

describe('Served web fonts carry their OFL text', () => {
  for (const { family, file, project, copyright } of FONTS) {
    it(`ships the ${project} licence beside the served font`, () => {
      expect(node_fs.existsSync(node_path.join(FONT_DIR, file)), 'font file').toBe(true);
      const licencePath = node_path.join(LICENSE_DIR, `${family}-OFL.txt`);
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

  it('covers every Hangul syllable the Korean messages use, so no heading mixes two faces', () => {
    const koreanMessages = node_fs.readFileSync(node_path.join(REPO_ROOT, 'messages', 'ko.json'), 'utf8');
    const covered = new Set(node_fs.readFileSync(node_path.join(FONT_DIR, 'NotoSerifKR-hangul-display.txt'), 'utf8'));
    const used = new Set(koreanMessages.match(/[\uac00-\ud7a3]/g) ?? []);
    const missing = [...used].filter((syllable) => !covered.has(syllable));
    expect(missing, 'rerun scripts/subset-hangul-display-font.py').toEqual([]);
  });
});
