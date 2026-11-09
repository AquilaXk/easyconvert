import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCfbfContainer } from '../src/lib/conversions/cfbf-writer';
import { LEGACY_IMPORT_FILTER_NAMES, officeInputFilterArgs } from '../src/lib/conversions/office/legacy-import-filter';
import { isOracleToolAvailable } from './helpers/differential-oracle';
import { skipUnless } from './helpers/strict-skip';

/**
 * The legacy binary Office formats and the Palm databases are opened with the import filter of the generation found in the file, never
 * with the filter of the newest generation (which refuses an older file) and never with a guess of the suite. The generations the suite can
 * still write (Word, Excel and PowerPoint 97, their templates and slide shows) are made by the suite and read back with the filter
 * named; Word 6.0 and 95, Excel 5.0/95 and the Palm databases are compound files and headers built here, since nothing writes them any more.
 */

let directory = '';
let counter = 0;

beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'office-legacy-filters-'));
});

afterAll(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function file(name: string, bytes: Buffer): string {
  const target = path.join(directory, `${counter++}-${name}`);
  fs.writeFileSync(target, bytes);
  return target;
}

function wordDocument(nFib: number): Buffer {
  const stream = Buffer.alloc(4096);
  stream.writeUInt16LE(0xa5ec, 0);
  stream.writeUInt16LE(nFib, 2);
  return buildCfbfContainer([{ name: 'WordDocument', data: stream }]);
}

const compound = (...streams: string[]): Buffer => buildCfbfContainer(streams.map((name) => ({ name, data: Buffer.alloc(4096, 1) })));

function palmDatabase(typeAndCreator: string): Buffer {
  const header = Buffer.alloc(78);
  header.write(typeAndCreator, 60, 'latin1');
  return header;
}

describe('the import filter of a legacy binary file', () => {
  it('is the filter of the Word generation found in the document stream', () => {
    const readFileSpy = fs.readFileSync;
    let fullFileReads = 0;
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      fullFileReads += 1;
      return readFileSpy(...args);
    }) as typeof fs.readFileSync;
    try {
      expect(officeInputFilterArgs('doc', file('a.doc', wordDocument(0x0101)))).toEqual(['--infilter=MS Word 97']);
      expect(officeInputFilterArgs('doc', file('b.doc', wordDocument(104)))).toEqual(['--infilter=MS Word 95']);
      expect(officeInputFilterArgs('doc', file('c.doc', wordDocument(101)))).toEqual(['--infilter=MS WinWord 6.0']);
      expect(officeInputFilterArgs('dot', file('w6.dot', wordDocument(101)))).toEqual(['--infilter=MS WinWord 6.0']);
      expect(officeInputFilterArgs('dot', file('d.dot', wordDocument(104)))).toEqual(['--infilter=MS Word 95 Vorlage']);
      expect(officeInputFilterArgs('dot', file('e.dot', wordDocument(0x0101)))).toEqual(['--infilter=MS Word 97 Vorlage']);
      expect(officeInputFilterArgs('wps', file('f.wps', wordDocument(0x0101)))).toEqual(['--infilter=MS Word 97']);
      expect(fullFileReads).toBe(0);
    } finally {
      fs.readFileSync = readFileSpy;
    }
    expect(new Set(LEGACY_IMPORT_FILTER_NAMES).size).toBe(LEGACY_IMPORT_FILTER_NAMES.length);
  });

  it('is the filter of the Excel generation found in the stream names, and of its template', () => {
    expect(officeInputFilterArgs('xls', file('a.xls', compound('Workbook')))).toEqual(['--infilter=MS Excel 97']);
    expect(officeInputFilterArgs('xls', file('b.xls', compound('Book')))).toEqual(['--infilter=MS Excel 5.0/95']);
    expect(officeInputFilterArgs('xlt', file('c.xlt', compound('Workbook')))).toEqual(['--infilter=MS Excel 97 Vorlage/Template']);
    expect(officeInputFilterArgs('xlt', file('d.xlt', compound('Book')))).toEqual(['--infilter=MS Excel 5.0/95 Vorlage/Template']);
  });

  it('is the filter of PowerPoint 97 for a presentation, a slide show and a template', () => {
    const presentation = compound('PowerPoint Document');
    expect(officeInputFilterArgs('ppt', file('a.ppt', presentation))).toEqual(['--infilter=MS PowerPoint 97']);
    expect(officeInputFilterArgs('pps', file('b.pps', presentation))).toEqual(['--infilter=MS PowerPoint 97 AutoPlay']);
    expect(officeInputFilterArgs('pot', file('c.pot', presentation))).toEqual(['--infilter=MS PowerPoint 97 Vorlage']);
  });

  it('is the filter of the Palm database type: text and Plucker', () => {
    expect(officeInputFilterArgs('pdb', file('a.pdb', palmDatabase('TEXtREAd')))).toEqual(['--infilter=Palm_Text_Document']);
    expect(officeInputFilterArgs('pdb', file('b.pdb', palmDatabase('DataPlkr')))).toEqual(['--infilter=Plucker eBook']);
  });

  it('is none for a file whose generation is not recognised, which the suite detects as before', () => {
    expect(officeInputFilterArgs('pdb', file('c.pdb', palmDatabase('BOOKMOBI')))).toEqual([]);
    expect(officeInputFilterArgs('pdb', file('d.pdb', Buffer.alloc(10)))).toEqual([]);
    expect(officeInputFilterArgs('doc', file('e.doc', Buffer.from('{\\rtf1 not a compound file}')))).toEqual([]);
    expect(officeInputFilterArgs('doc', file('f.doc', wordDocument(7)))).toEqual([]);
    expect(officeInputFilterArgs('doc', file('g.doc', compound('Other')))).toEqual([]);
    expect(officeInputFilterArgs('xls', file('h.xls', Buffer.from('<html></html>')))).toEqual([]);
    expect(officeInputFilterArgs('wps', file('i.wps', Buffer.from('works document')))).toEqual([]);
  });

  it('is the filter of the declared format for every other format', () => {
    expect(officeInputFilterArgs('docx', '/unused')).toEqual(['--infilter=MS Word 2007 XML']);
    expect(officeInputFilterArgs('txt', '/unused')).toEqual([]);
  });
});

const sofficeMissing = skipUnless('soffice', isOracleToolAvailable('soffice'));

describe.skipIf(sofficeMissing)('the generations the office suite writes, opened with the filter named for them', () => {
  const profile = () => `-env:UserInstallation=file://${path.join(directory, 'profile')}`;
  const soffice = (args: string[]): void => {
    execFileSync('soffice', ['--headless', '--norestore', profile(), ...args], { cwd: directory, stdio: 'pipe', timeout: 120_000 });
  };

  // [extension, filter the suite writes it with, text file it is made from, filter the test expects to be named]
  const FAMILIES = [
    ['doc', 'MS Word 97', 'word.txt', 'MS Word 97'],
    ['dot', 'MS Word 97 Vorlage', 'word.txt', 'MS Word 97 Vorlage'],
    ['xls', 'MS Excel 97', 'sheet.csv', 'MS Excel 97'],
    ['xlt', 'MS Excel 97 Vorlage/Template', 'sheet.csv', 'MS Excel 97 Vorlage/Template'],
  ] as const;

  for (const [extension, writeFilter, source, expected] of FAMILIES) {
    it(`.${extension}: names ${expected} and the suite converts the file with it`, () => {
      fs.writeFileSync(path.join(directory, 'word.txt'), 'legacy filter words\n');
      fs.writeFileSync(path.join(directory, 'sheet.csv'), 'legacy,filter\n1,2\n');
      soffice(['--convert-to', `${extension}:${writeFilter}`, '--outdir', path.join(directory, 'made'), path.join(directory, source)]);
      const made = path.join(directory, 'made', `${path.parse(source).name}.${extension}`);
      const input = path.join(directory, `run-${extension}`, `input.${extension}`);
      fs.mkdirSync(path.dirname(input), { recursive: true });
      fs.copyFileSync(made, input);
      const args = officeInputFilterArgs(extension, input);
      expect(args).toEqual([`--infilter=${expected}`]);
      soffice([...args, '--convert-to', extension.startsWith('x') ? 'csv' : 'txt:Text', '--outdir', path.dirname(input), input]);
      const converted = fs.readFileSync(path.join(path.dirname(input), `input.${extension.startsWith('x') ? 'csv' : 'txt'}`), 'utf-8');
      expect(converted).toContain(extension.startsWith('x') ? 'legacy' : 'legacy filter words');
    }, 150_000);
  }

  it('.ppt, .pps and .pot: name the PowerPoint 97 filters and the suite converts the file with them', () => {
    fs.writeFileSync(path.join(directory, 'slides.fodp'), SLIDES);
    for (const [extension, writeFilter, expected] of [
      ['ppt', 'MS PowerPoint 97', 'MS PowerPoint 97'],
      ['pps', 'MS PowerPoint 97 AutoPlay', 'MS PowerPoint 97 AutoPlay'],
      ['pot', 'MS PowerPoint 97 Vorlage', 'MS PowerPoint 97 Vorlage'],
    ] as const) {
      soffice(['--convert-to', `${extension}:${writeFilter}`, '--outdir', path.join(directory, 'made'), path.join(directory, 'slides.fodp')]);
      const input = path.join(directory, `run-${extension}`, `input.${extension}`);
      fs.mkdirSync(path.dirname(input), { recursive: true });
      fs.copyFileSync(path.join(directory, 'made', `slides.${extension}`), input);
      const args = officeInputFilterArgs(extension, input);
      expect(args, extension).toEqual([`--infilter=${expected}`]);
      soffice([...args, '--convert-to', 'fodp', '--outdir', path.dirname(input), input]);
      expect(fs.readFileSync(path.join(path.dirname(input), 'input.fodp'), 'utf-8'), extension).toContain('legacy slide words');
    }
  }, 300_000);

  it('.pdb: the text database is opened with the filter named for its type', () => {
    const text = Buffer.from('legacy palm words\r');
    const record0 = Buffer.alloc(16);
    record0.writeUInt16BE(1, 0);
    record0.writeUInt32BE(text.length, 4);
    record0.writeUInt16BE(1, 8);
    record0.writeUInt16BE(text.length, 10);
    const header = palmDatabase('TEXtREAd');
    header.write('test', 0, 'latin1');
    header.writeUInt16BE(2, 76);
    const records = Buffer.alloc(18);
    const firstRecord = header.length + records.length;
    records.writeUInt32BE(firstRecord, 0);
    records.writeUInt32BE(firstRecord + record0.length, 8);
    records.writeUInt8(1, 12);
    const input = path.join(directory, 'run-pdb', 'input.pdb');
    fs.mkdirSync(path.dirname(input), { recursive: true });
    fs.writeFileSync(input, Buffer.concat([header, records, record0, text]));
    const args = officeInputFilterArgs('pdb', input);
    expect(args).toEqual(['--infilter=Palm_Text_Document']);
    soffice([...args, '--convert-to', 'txt:Text', '--outdir', path.dirname(input), input]);
    expect(fs.readFileSync(path.join(path.dirname(input), 'input.txt'), 'utf-8')).toContain('legacy palm words');
  }, 150_000);
});

const SLIDES = `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.presentation">
<office:body><office:presentation><draw:page draw:name="one"><draw:frame svg:x="1cm" svg:y="1cm" svg:width="10cm" svg:height="3cm"><draw:text-box><text:p>legacy slide words</text:p></draw:text-box></draw:frame></draw:page></office:presentation></office:body></office:document>`;

describe('the filter names this module chooses', () => {
  const registryDirectories = ['/Applications/LibreOffice.app/Contents/Resources/registry', '/usr/lib/libreoffice/share/registry', '/usr/lib64/libreoffice/share/registry', '/opt/libreoffice/share/registry'];
  const registryDirectory = registryDirectories.find((candidate) => fs.existsSync(path.join(candidate, 'main.xcd')));
  const registryMissing = skipUnless('the registry of the installed office suite (share/registry/main.xcd)', registryDirectory !== undefined);

  it.skipIf(registryMissing)('are all import filters of the installed suite', () => {
    const text = fs.readdirSync(registryDirectory!).filter((name) => name.endsWith('.xcd')).map((name) => fs.readFileSync(path.join(registryDirectory!, name), 'utf-8')).join('');
    const unknown = LEGACY_IMPORT_FILTER_NAMES.filter((name) => !new RegExp(`<node oor:name="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*oor:op="replace">`).test(text));
    expect(unknown).toEqual([]);
    expect(LEGACY_IMPORT_FILTER_NAMES).toContain('Palm_Text_Document');
  });
});
