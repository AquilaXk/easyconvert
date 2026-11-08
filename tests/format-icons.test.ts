import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FormatIcon } from '../src/components/workbench/FormatIcon';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { config } from '../src/middleware';

const ICON_DIR = path.join(__dirname, '..', 'public', 'format-icons');
const iconOf = (format: string): string | null => /src="\/format-icons\/([\w-]+)\.svg"/.exec(renderToStaticMarkup(React.createElement(FormatIcon, { format, className: 'size-5' })))?.[1] ?? null;

describe('the file icons of the formats', () => {
  it('give every format of the registry an icon file that is served beside its licence', () => {
    for (const id of Object.keys(FORMAT_REGISTRY)) {
      const name = iconOf(id);
      expect(name, id).not.toBeNull();
      expect(fs.existsSync(path.join(ICON_DIR, `${name}.svg`)), `${id} -> ${name}`).toBe(true);
    }
    expect(fs.readFileSync(path.join(ICON_DIR, 'LICENSE'), 'utf8')).toMatch(/MIT License/);
  });

  it('tell a PDF from the Word file and the spreadsheet beside it', () => {
    expect(new Set([iconOf('pdf'), iconOf('docx'), iconOf('xlsx'), iconOf('pptx')]).size).toBe(4);
  });

  it('hold no script or event attribute', () => {
    for (const file of fs.readdirSync(ICON_DIR).filter((name) => name.endsWith('.svg'))) {
      const svg = fs.readFileSync(path.join(ICON_DIR, file), 'utf8');
      expect(svg, file).not.toMatch(/<script|\son[a-z]+=|javascript:/i);
    }
  });

  it('are served as files, not routed through the locale middleware', () => {
    const page = new RegExp(`^${config.matcher[1].replace('/(', '/(?:').replace(/^\//, '\\/')}$`);
    expect(page.test('/format-icons/pdf.svg')).toBe(false);
    expect(page.test('/ko/docx-to-pdf')).toBe(true);
  });

  it('keep a stack for the tile of any format', () => {
    expect(renderToStaticMarkup(React.createElement(FormatIcon, { format: 'any', className: 'size-5' }))).toMatch(/^<svg/);
  });
});
