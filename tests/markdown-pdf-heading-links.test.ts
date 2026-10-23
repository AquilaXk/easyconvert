import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { oracleTest } from './helpers/oracle-test';
import { pdfLinks, pdfNamedDestinations, qpdfCheck } from './helpers/pdf-named-links';

/**
 * Links to headings in the PDF the in-process renderer writes from Markdown. A heading is a target by the id GitHub gives it
 * (github-slugger 2.0.0: lower case, everything but letters, marks, numbers, connector punctuation, hyphens and spaces
 * removed, spaces to hyphens, a repeated slug numbered `-1`, `-2`), and a link to `#id` goes to it, as in a Markdown view
 * on GitHub. qpdf reads the annotations and name tree, pdftotext the words under each rectangle and at each destination.
 */

const toPdf = async (markdown: string): Promise<Buffer> => (await convertFile(Buffer.from(markdown, 'utf-8'), 'md', 'pdf', { orientation: 'portrait' }, 'notes.md')).buffer;

/** What each internal link covers and the words of the line it goes to. */
function followed(pdf: Buffer): Array<{ text: string; name: string; line: string }> {
  return pdfLinks(pdf)
    .filter((link) => link.name !== undefined)
    .map((link) => ({ text: link.text, name: link.name ?? '', line: (link.line ?? []).join(' ') }));
}

describe('a link to a heading of a Markdown file goes to it', () => {
  oracleTest('pdftotext and qpdf read the link, its rectangle and the line it goes to', ['qpdf', 'pdftotext'], async () => {
    const pdf = await toPdf(['# Overview', '', 'Go to [the details](#second-part) or [start](#overview) now.', '', '## Second Part', '', 'Closing words.'].join('\n'));
    expect(followed(pdf)).toEqual([
      { text: 'the details', name: 'second-part', line: 'Second Part' },
      { text: 'start', name: 'overview', line: 'Overview' },
    ]);
    expect(qpdfCheck(pdf).status).toBe(0);
  });

  oracleTest('gives a heading the id GitHub gives it: punctuation removed, case folded, letters outside ASCII kept', ['qpdf', 'pdftotext'], async () => {
    const pdf = await toPdf(
      ['# Hello, World!', '', '## C++ & Rust: 100% *safe* `code`', '', '### 한글 제목', '', '#### Über Café', '', '[a](#hello-world) [b](#c--rust-100-safe-code) [c](#한글-제목) [d](#über-café)'].join('\n')
    );
    expect(pdfNamedDestinations(pdf).map((destination) => destination.name).sort()).toEqual(['c--rust-100-safe-code', 'hello-world', 'über-café', '한글-제목'].sort());
    expect(followed(pdf).map((link) => link.line)).toEqual(['Hello, World!', 'C++ & Rust: 100% safe code', '한글 제목', 'Über Café']);
  });

  oracleTest('numbers a repeated heading -1, -2 in document order, as GitHub does', ['qpdf', 'pdftotext'], async () => {
    const pdf = await toPdf(['# Notes', '', '# Notes', '', '# Notes', '', '[one](#notes) [two](#notes-1) [three](#notes-2)'].join('\n'));
    expect(pdfNamedDestinations(pdf).map((destination) => destination.name)).toEqual(['notes', 'notes-1', 'notes-2']);
    expect(followed(pdf).map((link) => link.name)).toEqual(['notes', 'notes-1', 'notes-2']);
  });

  oracleTest('leaves a link to a heading that is not there as text, and the links to the web as they were', ['qpdf', 'pdftotext'], async () => {
    const pdf = await toPdf(['# Only heading', '', '[nowhere](#missing) and [web](https://example.com/a).'].join('\n'));
    expect(followed(pdf)).toEqual([]);
    expect(pdfLinks(pdf).map((link) => link.uri)).toEqual(['https://example.com/a']);
  });
});
