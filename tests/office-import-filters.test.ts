import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OFFICE_IMPORT_FILTERS, officeImportFilter, officeImportFilterArgs } from '../src/lib/conversions/office/office-suite-sources';
import { skipUnless } from './helpers/strict-skip';

/**
 * The import filters the worker names (`--infilter`) and the settings of the fixed profile are checked against the registry of the
 * installed office suite (`registry/*.xcd`), which is what the suite itself reads: a name it does not know would make every file of
 * that format fail to open, and a setting it does not know would be ignored without a word.
 */

const REGISTRY_CANDIDATES = [
  '/usr/lib/libreoffice/share/registry',
  '/usr/lib64/libreoffice/share/registry',
  '/opt/libreoffice/share/registry',
  '/Applications/LibreOffice.app/Contents/Resources/registry',
];

function findRegistry(): string | null {
  const fromBinary = process.env.SOFFICE_PATH ? [path.join(path.dirname(fs.realpathSync(process.env.SOFFICE_PATH)), '..', 'share', 'registry')] : [];
  return [...fromBinary, ...REGISTRY_CANDIDATES].find((candidate) => fs.existsSync(path.join(candidate, 'main.xcd'))) ?? null;
}

const registryDirectory = findRegistry();
const registryMissing = skipUnless('the registry of the installed office suite (share/registry/main.xcd)', registryDirectory !== null);

interface Registry {
  /** Import filter name to the name of its type. */
  filters: Map<string, string>;
  /** Type name to the extensions it lists. */
  extensions: Map<string, string[]>;
  text: string;
}

function readRegistry(directory: string): Registry {
  const filters = new Map<string, string>();
  const extensions = new Map<string, string[]>();
  let all = '';
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.xcd'))) {
    const text = fs.readFileSync(path.join(directory, file), 'utf-8');
    all += text;
    for (const node of text.matchAll(/<node oor:name="([^"]+)"[^>]*oor:op="replace">([\s\S]*?)<\/node>/g)) {
      const flags = /<prop oor:name="Flags"[^>]*>\s*<value>([^<]*)<\/value>/.exec(node[2])?.[1];
      const type = /<prop oor:name="Type"[^>]*>\s*<value>([^<]*)<\/value>/.exec(node[2])?.[1];
      const listed = /<prop oor:name="Extensions"[^>]*>\s*<value[^>]*>([^<]*)<\/value>/.exec(node[2])?.[1];
      if (flags?.includes('IMPORT') && type) filters.set(node[1], type);
      if (listed) extensions.set(node[1], listed.toLowerCase().split(/\s+/));
    }
  }
  return { filters, extensions, text: all };
}

describe.skipIf(registryMissing)('the office suite registry', () => {
  const registry = registryDirectory === null ? null : readRegistry(registryDirectory);

  it('knows every import filter the worker names, as an import filter', () => {
    const unknown = Object.entries(OFFICE_IMPORT_FILTERS).filter(([, filter]) => !registry!.filters.has(filter));
    expect(unknown).toEqual([]);
  });

  it('lists the extension of a format among those of its filter, for the formats that are not variants of another', () => {
    const own = ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'odg', 'rtf', 'sxw', 'sxc', 'sxi', 'sxd', 'wpd', 'lwp', 'abw', 'zabw', 'pages', 'numbers', 'key', 'vsd', 'cdr', 'pub', 'lrf', 'dotx', 'xltx', 'potx', 'ppsx', 'ott', 'ots', 'otp'];
    const mismatched = own.filter((format) => {
      const type = registry!.filters.get(OFFICE_IMPORT_FILTERS[format]);
      return type === undefined || !registry!.extensions.get(type)?.includes(format);
    });
    expect(mismatched).toEqual([]);
  });

  it('has every setting of the fixed profile, with the type it is written as', () => {
    const group = (name: string, component: string) => {
      const start = registry!.text.indexOf(`<oor:component-schema`, registry!.text.search(new RegExp(`<oor:component-schema[^>]*oor:name="${component}"`)));
      const groupAt = registry!.text.indexOf(`<group oor:name="${name}"`, start);
      return registry!.text.slice(groupAt, groupAt + 12000);
    };
    expect(group('Scripting', 'Common')).toMatch(/<prop oor:name="MacroSecurityLevel" oor:type="xs:int"/);
    expect(group('Scripting', 'Common')).toMatch(/<prop oor:name="DisableMacrosExecution" oor:type="xs:boolean"/);
    expect(group('Scripting', 'Common')).toMatch(/<prop oor:name="DisableActiveContent" oor:type="xs:boolean"/);
    expect(group('Scripting', 'Common')).toMatch(/<prop oor:name="BlockUntrustedRefererLinks" oor:type="xs:boolean"/);
    expect(group('Update', 'Calc')).toMatch(/<prop oor:name="Link" oor:type="xs:int"/);
    expect(group('Update', 'Writer')).toMatch(/<prop oor:name="Link" oor:type="xs:int"/);
  });
});

describe('officeImportFilter', () => {
  it('names a filter for a declared format, in any letter case, and none for a format the suite detects itself', () => {
    expect(officeImportFilter('DOCX')).toBe('MS Word 2007 XML');
    expect(officeImportFilterArgs('odp')).toEqual(['--infilter=impress8']);
    for (const detected of ['txt', 'csv', 'html', 'emf', 'constructor', '__proto__']) {
      expect(officeImportFilterArgs(detected), detected).toEqual([]);
    }
  });
});
