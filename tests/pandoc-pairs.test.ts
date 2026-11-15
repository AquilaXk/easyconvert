import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import { parse } from 'parse5';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { requiresNativeEngine } from '../src/lib/conversions/native-engine-pairs';
import { isPandocPair } from '../src/lib/conversions/pandoc-pairs';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { assertNotSpoofedFile } from '../src/lib/security/file-guard';
import { ConversionFailedError, CpuTaskTimeoutError, EngineUnavailableError, InvalidConversionOutputError, PayloadLimitError } from '../src/lib/types';
import { enginesForPair } from '../src/worker/engine-registry';
import { convertWithPandoc, type PandocRequest } from '../src/worker/pandoc-route';
import { getOracleToolPath } from './helpers/differential-oracle';
import { withMissingBinary } from './helpers/native-tools';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipUnless } from './helpers/strict-skip';
import { runWithoutFileConfinement } from './helpers/unconfined-files';

/**
 * Markdown, plain text and HTML to LaTeX, and Markdown to reStructuredText, written by pandoc 3.1.11 (docs/policy-decisions.md, "Markdown, plain
 * text and HTML to LaTeX and reStructuredText"): the registry and the engine table, the answer of a worker without the program, the route against
 * stand-in programs (arguments, environment, limits, refusals), and the real program on real files. The oracles are not pandoc: the words of the
 * source come from markdown-it (Markdown), parse5 (HTML) or the text itself, and the output is read by a reader written here from the two
 * formats' layout (LaTeX: braces and environments balance, the words of the commands are dropped; reStructuredText: every adornment is one
 * character as long as its title).
 */

const pandocBinary = getOracleToolPath('pandoc');
const pandocMissing = skipUnless('pandoc', pandocBinary !== null);
if (pandocBinary !== null && !process.env.PANDOC_PATH) process.env.PANDOC_PATH = pandocBinary;
const REAL_TIMEOUT_MS = 120_000;
const NOT_SPOOFED = (): void => undefined;
const MARKDOWN = Buffer.from('# Title\n\nA paragraph with *emphasis*, a [link](https://example.com/a) and `code`.\n\n- one\n- two\n', 'utf-8');
const PAIRS = [
  ['md', 'tex'],
  ['md', 'rst'],
  ['html', 'tex'],
  ['txt', 'tex'],
] as const;

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function recall(expected: readonly string[], actual: readonly string[]): number {
  const held = new Set(actual);
  const wanted = [...new Set(expected)];
  return wanted.filter((word) => held.has(word)).length / wanted.length;
}

/** The words of a Markdown file as markdown-it renders it: the text of the HTML, without tags. */
function wordsOfMarkdown(markdown: string): string[] {
  const html = new MarkdownIt({ html: true }).render(markdown);
  return wordsOf(html.replace(/<[^>]*>/g, ' ').replace(/&(amp|lt|gt|quot|#39|nbsp);/g, ' '));
}

interface Parse5Node {
  nodeName: string;
  value?: string;
  childNodes?: Parse5Node[];
}

/** The words of the text nodes of an HTML document, scripts and style sheets left out. */
function wordsOfHtml(html: string): string[] {
  const words: string[] = [];
  const visit = (node: Parse5Node): void => {
    if (node.nodeName === 'script' || node.nodeName === 'style') return;
    if (node.nodeName === '#text') words.push(...wordsOf(node.value ?? ''));
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(parse(html) as unknown as Parse5Node);
  return words;
}

/**
 * Reads LaTeX: checks that braces and environments balance, and returns the words of the text with the commands, their environment names and the
 * comments dropped.
 */
function readLatex(tex: string): string[] {
  const environments: string[] = [];
  let depth = 0;
  const body = tex
    .replace(/(^|[^\\])%.*$/gm, '$1')
    .replace(/\\(begin|end)\{([^}]*)\}/g, (_all, kind: string, name: string) => {
      if (kind === 'begin') environments.push(name);
      else expect(environments.pop(), `\\end{${name}} closes the environment that is open`).toBe(name);
      return ' ';
    })
    .replace(/\\[{}]/g, ' ');
  for (const character of body) {
    if (character === '{') depth += 1;
    if (character === '}') depth -= 1;
    expect(depth, 'no closing brace without an opening one').toBeGreaterThanOrEqual(0);
  }
  expect(depth, 'every brace is closed').toBe(0);
  expect(environments, 'every environment is closed').toEqual([]);
  return wordsOf(body.replace(/\\[A-Za-z]+\*?/g, ' ').replace(/\\./g, ' '));
}

/** Reads reStructuredText: every adornment line is one repeated character at least as long as the title it underlines, and the words are returned. */
function readRestructuredText(rst: string): string[] {
  const lines = rst.split('\n');
  lines.forEach((line, index) => {
    if (!/^([=\-~^"'`#*+<>_:.])\1{2,}$/.test(line) || index === 0) return;
    const title = lines[index - 1];
    if (title.trim() !== '' && !/^([=\-~^"'`#*+<>_:.])\1{2,}$/.test(title)) expect(line.length, `the adornment under "${title}"`).toBeGreaterThanOrEqual(title.length);
  });
  return wordsOf(rst.replace(/``?|\.\. [a-z-]+::|:[a-z]+:|__?/g, ' '));
}

describe('the pairs pandoc converts', () => {
  it.each(PAIRS)('%s -> %s is offered, and pandoc is its only engine', (source, target) => {
    expect(FORMAT_REGISTRY[source].targetFormats).toContain(target);
    expect(isPandocPair(source, target)).toBe(true);
    expect(requiresNativeEngine(source, target)).toBe(true);
    expect(enginesForPair(source, target)).toEqual([{ id: 'pandoc', default: true }]);
  });

  it('offers no HTML or plain text to reStructuredText, which the reference does not list', () => {
    for (const source of ['html', 'txt']) expect(FORMAT_REGISTRY[source].targetFormats).not.toContain('rst');
    expect(isPandocPair('html', 'rst')).toBe(false);
  });

  it.each(PAIRS)('%s -> %s answers an unavailable engine on a worker without pandoc, and never writes a file of its own', async (source, target) => {
    const run = withMissingBinary('PANDOC_PATH', () => dispatchConversion(MARKDOWN, source, target, {}, `book.${source}`));
    await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toMatchObject({ engineName: 'pandoc' });
  });

  it.each(PAIRS)('%s -> %s has no in-process writer', async (source, target) => {
    const failure = await convertFile(MARKDOWN, source, target, {}, `book.${source}`).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EngineUnavailableError);
    expect((failure as Error).message).toBe(`Engine 'pandoc' is unavailable: Converting .${source} to .${target} needs the native pandoc engine; the in-process engine has no writer for it.`);
  });

  it.each(['md', 'txt', 'html'])('refuses a ZIP named .%s before pandoc is asked', (source) => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(() => assertNotSpoofedFile(zip, source, `book.${source}`)).toThrow(/^File spoofing rejected for file "book\./);
  });
});

describe('the pandoc route against a stand-in program', () => {
  runWithoutFileConfinement();
  let workDir: string;
  let logPath: string;
  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandoc-route-test-'));
    logPath = path.join(workDir, 'runs.jsonl');
  });
  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  /** A stand-in for `pandoc`: it logs how it was started, then runs `behavior`, a body that sees `args`, `source`, `output` and `fs`. */
  function fakePandoc(behavior: string): string {
    const program = path.join(workDir, 'pandoc');
    const script = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const output = args[args.indexOf('--output') + 1];
const source = args[args.length - 1];
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'HTTPS_PROXY', 'SECRET_TOKEN'].map((name) => [name, process.env[name]]));
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, cwd: process.cwd(), env, sourceBytes: fs.readFileSync(source).toString('hex') }) + '\\n');
${behavior}
`;
    fs.writeFileSync(program, script, { mode: 0o755 });
    return program;
  }

  const runs = (): Array<{ args: string[]; cwd: string; env: Record<string, string | undefined>; sourceBytes: string }> =>
    fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line)) : [];

  const request = (src: string, tgt: string, input: Buffer = MARKDOWN, options: PandocRequest['options'] = {}): PandocRequest => ({ input, src, tgt, options, originalFilename: `book.${src}` });
  const WRITES_TEXT = `fs.writeFileSync(output, '\\\\section{Title}\\n');`;

  it.each([
    ['md', 'tex', 'markdown', 'latex'],
    ['md', 'rst', 'markdown', 'rst'],
    ['txt', 'tex', 'markdown', 'latex'],
    ['html', 'tex', 'html', 'latex'],
  ])('starts pandoc for .%s to .%s as --from %s --to %s with --sandbox and the source as a file of the job', async (src, tgt, reader, writer) => {
    const result = await convertWithPandoc(request(src, tgt), fakePandoc(WRITES_TEXT), NOT_SPOOFED);
    const [run] = runs();
    expect(runs()).toHaveLength(1);
    expect(run.args).toEqual(['--sandbox', '--from', reader, '--to', writer, '--output', expect.stringMatching(new RegExp(`converted\\.${tgt}$`)), expect.stringMatching(/source\.txt$/)]);
    expect(result.engineUsed).toBe('native-pandoc');
    expect(result.filename).toBe(`book.${tgt}`);
    expect(result.buffer.toString('utf-8')).toBe('\\section{Title}\n');
    fs.rmSync(result.filePath as string, { force: true });
  });

  it('runs in a directory of the job, with its own home and temporary directories, no network and no secret of the worker', async () => {
    process.env.SECRET_TOKEN = 'must-not-reach-pandoc';
    try {
      const result = await convertWithPandoc(request('md', 'tex'), fakePandoc(WRITES_TEXT), NOT_SPOOFED);
      const [run] = runs();
      expect(path.basename(run.cwd)).toMatch(/^easyconvert-pandoc-/);
      for (const name of ['HOME', 'TMPDIR'] as const) expect(run.env[name]?.startsWith(run.cwd + path.sep), name).toBe(true);
      expect(run.env.LANG).toBe('C.UTF-8');
      expect(run.env.HTTPS_PROXY).toBe('http://127.0.0.1:0');
      expect(run.env.SECRET_TOKEN).toBeUndefined();
      expect(fs.existsSync(run.cwd)).toBe(false);
      fs.rmSync(result.filePath as string, { force: true });
    } finally {
      delete process.env.SECRET_TOKEN;
    }
  });

  it('hands pandoc the text as UTF-8, also when the source is UTF-16 with a byte order mark', async () => {
    const text = '# 제목\n\n안녕하세요 *세계*.\n';
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    const result = await convertWithPandoc(request('md', 'tex', utf16), fakePandoc(WRITES_TEXT), NOT_SPOOFED);
    expect(Buffer.from(runs()[0].sourceBytes, 'hex').toString('utf-8')).toBe(text);
    fs.rmSync(result.filePath as string, { force: true });
  });

  it('refuses a source that is a container or holds null bytes before pandoc starts', async () => {
    const failure = await convertWithPandoc(request('txt', 'tex', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])), fakePandoc(WRITES_TEXT), NOT_SPOOFED).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toMatch(/binary\/compressed container for format '\.txt'/);
    expect(runs()).toEqual([]);
  });

  it('refuses a source of more than 32 MiB with the payload limit before pandoc starts', async () => {
    const huge = path.join(workDir, 'huge.md');
    fs.writeFileSync(huge, '');
    fs.truncateSync(huge, 33 * 1024 * 1024);
    const failure = await convertWithPandoc({ ...request('md', 'tex'), input: { inputPath: huge } }, fakePandoc(WRITES_TEXT), NOT_SPOOFED).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PayloadLimitError);
    expect(runs()).toEqual([]);
  });

  it('answers a failed run with a typed error that names the last line pandoc printed and not the job directory', async () => {
    const program = fakePandoc(`process.stderr.write('pandoc: Cannot decode byte at ' + source + '\\n'); process.exit(64);`);
    const failure = await convertWithPandoc(request('md', 'tex'), program, NOT_SPOOFED).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toMatch(/^pandoc could not convert the \.md file to \.tex: pandoc: Cannot decode byte at <tmp>\/source\.txt$/);
  });

  it('refuses a run that wrote no file, and a file with a null byte', async () => {
    const quiet = await convertWithPandoc(request('md', 'tex'), fakePandoc('process.exit(0);'), NOT_SPOOFED).catch((error: unknown) => error);
    expect(quiet).toBeInstanceOf(ConversionFailedError);
    expect((quiet as Error).message).toBe('pandoc wrote no .tex file for the .md file.');
    const binary = await convertWithPandoc(request('md', 'rst'), fakePandoc(`fs.writeFileSync(output, Buffer.from([0x41, 0, 0x42]));`), NOT_SPOOFED).catch((error: unknown) => error);
    expect(binary).toBeInstanceOf(InvalidConversionOutputError);
    expect((binary as Error).message).toBe('The conversion of the .md file to .rst produced bytes that are not a .rst file.');
  });

  it('stops a run that outlasts its limit with the typed 422 error', async () => {
    const failure = await convertWithPandoc(request('md', 'tex', MARKDOWN, { timeoutMs: 1000 }), fakePandoc('setInterval(() => undefined, 1000);'), NOT_SPOOFED).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CpuTaskTimeoutError);
    expect((failure as Error).message).toBe('The .md to .tex conversion task exceeded its 1000 ms time limit');
  }, 30_000);

  it('answers an unavailable engine before it reads the source when the program is not installed', async () => {
    const failure = await convertWithPandoc(request('md', 'tex', Buffer.from([0x50, 0x4b, 0x03, 0x04])), null, NOT_SPOOFED).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EngineUnavailableError);
    expect(failure).toMatchObject({ engineName: 'pandoc' });
    expect((failure as Error).message).toBe("Engine 'pandoc' is unavailable: pandoc is not installed or not in PATH");
  });

  it('checks the declared format against the bytes before it looks for the program', async () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    const failure = await convertWithPandoc(request('md', 'tex', zip), null, (input, src, name) => assertNotSpoofedFile(input as Buffer, src, name)).catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(EngineUnavailableError);
    expect((failure as Error).message).toMatch(/^File spoofing rejected for file "book\.md"/);
  });
});

describe.skipIf(pandocMissing)('the real pandoc on real files', () => {
  async function convert(bytes: Buffer, src: string, tgt: string, name: string): Promise<string> {
    const result = await dispatchConversion(bytes, src, tgt, {}, name);
    expect(result.engineUsed).toBe('native-pandoc');
    expect(result.filename).toBe(`${name.replace(/\.[a-z]+$/, '')}.${tgt}`);
    return result.buffer.toString('utf-8');
  }

  it('writes LaTeX with its structure and a reStructuredText with its adornments from a small Markdown file', async () => {
    const tex = await convert(MARKDOWN, 'md', 'tex', 'book.md');
    expect(tex.split('\n')[0]).toBe('\\section{Title}\\label{title}');
    expect(tex).toContain('\\emph{emphasis}');
    expect(tex).toContain('\\href{https://example.com/a}{link}');
    expect(tex).toContain('\\begin{itemize}');
    expect(readLatex(tex)).toEqual(expect.arrayContaining(['title', 'paragraph', 'emphasis', 'link', 'code', 'one', 'two']));
    const rst = await convert(MARKDOWN, 'md', 'rst', 'book.md');
    expect(rst.split('\n').slice(0, 2)).toEqual(['Title', '=====']);
    expect(readRestructuredText(rst)).toEqual(expect.arrayContaining(['title', 'paragraph', 'emphasis', 'link', 'code', 'one', 'two']));
  }, REAL_TIMEOUT_MS);

  describe.each(['cc-readme.md', 'office-readme.md', 'tika-readme.md'])('the real Markdown file %s', (id) => {
    it('has its words in the LaTeX and the reStructuredText', async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      const expected = wordsOfMarkdown(bytes.toString('utf-8'));
      expect(expected.length).toBeGreaterThan(100);
      expect(recall(expected, readLatex(await convert(bytes, 'md', 'tex', id))), `${id} to tex`).toBeGreaterThan(0.97);
      expect(recall(expected, readRestructuredText(await convert(bytes, 'md', 'rst', id))), `${id} to rst`).toBeGreaterThan(0.97);
    }, REAL_TIMEOUT_MS);
  });

  describe.each(['govdocs1-001792.html', 'govdocs1-000414.html', 'govdocs1-001843.html'])('the real HTML page %s', (id) => {
    it('has its words in the LaTeX', async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      const expected = wordsOfHtml(bytes.toString('latin1'));
      expect(expected.length).toBeGreaterThan(50);
      expect(recall(expected, readLatex(await convert(bytes, 'html', 'tex', id))), id).toBeGreaterThan(0.95);
    }, REAL_TIMEOUT_MS);
  });

  describe.each(['govdocs1-000485.txt', 'govdocs1-000643.txt', 'govdocs1-000654.txt'])('the real text file %s', (id) => {
    it('has its words in the LaTeX', async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      const expected = wordsOf(bytes.toString('latin1'));
      expect(expected.length).toBeGreaterThan(100);
      expect(recall(expected, readLatex(await convert(bytes, 'txt', 'tex', id))), id).toBeGreaterThan(0.97);
    }, REAL_TIMEOUT_MS);
  });

  it('follows no file of the host: a raw \\input and an include in the source stay text', async () => {
    const hostile = Buffer.from('Before.\n\n\\input{/etc/hosts}\n\n![picture](/etc/hosts)\n\nAfter.\n', 'utf-8');
    const hosts = fs.existsSync('/etc/hosts') ? fs.readFileSync('/etc/hosts', 'utf-8').split('\n').find((line) => /\S{9,}/.test(line))?.trim() : undefined;
    expect(hosts, '/etc/hosts has a line to look for').toBeDefined();
    for (const tgt of ['tex', 'rst']) {
      const output = await convert(hostile, 'md', tgt, 'hostile.md');
      expect(output).toContain('Before.');
      expect(output.includes(hosts as string), `the host file is in the .${tgt}`).toBe(false);
    }
  }, REAL_TIMEOUT_MS);

  it('refuses a binary file named .md with a typed error and a text file with invalid UTF-8 bytes as text', async () => {
    const failure = await dispatchConversion(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), 'md', 'tex', {}, 'x.md').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/^File spoofing rejected/);
    const latin1 = await convert(Buffer.from('Caf\xe9 au lait.\n', 'latin1'), 'txt', 'tex', 'cafe.txt');
    expect(readLatex(latin1)).toEqual(expect.arrayContaining(['au', 'lait']));
  }, REAL_TIMEOUT_MS);
});
