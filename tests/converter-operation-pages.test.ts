// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildQueuedFileItem } from '../src/hooks/useClientQueue';
import { parseConverterSlug } from '../src/lib/slug-parser';
import { drop, mountSlug, stubBrowser, unmountPage } from './helpers/mount-converter-page';

vi.mock('../src/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement('a', { href, ...rest }, children),
}));
vi.mock('../src/components/Header', () => ({ default: () => null }));
vi.mock('../src/components/Footer', () => ({ default: () => null }));

const { default: ConverterPageView } = await import('../src/components/pages/ConverterPageView');

beforeEach(stubBrowser);
afterEach(unmountPage);

const file = (name: string) => new File(['x'], name);

describe('the files of a page that does one operation with them', () => {
  it('start with text recognition on the OCR page, a scanned image and a PDF alike, so a PDF is not only compressed and an image not only wrapped', () => {
    expect(buildQueuedFileItem(file('scan.pdf'), 'pdf', 'ocr').options).toMatchObject({ ocrEnabled: true });
    expect(buildQueuedFileItem(file('photo.jpg'), 'pdf', 'ocr').options).toMatchObject({ ocrEnabled: true });
    expect(buildQueuedFileItem(file('photo.png'), 'pdf', 'ocr').options).toMatchObject({ ocrEnabled: true });
  });

  it('keep recognition off a target it cannot apply to, and off every other page', () => {
    expect(buildQueuedFileItem(file('letter.docx'), 'pdf', 'ocr').options.ocrEnabled).toBeUndefined();
    expect(buildQueuedFileItem(file('scan.pdf'), 'pdf').options.ocrEnabled).toBeUndefined();
    expect(buildQueuedFileItem(file('scan.pdf'), 'pdf', 'compress').options.ocrEnabled).toBeUndefined();
  });

  it('start with a PDF/A export on the PDF/A page, for a PDF and a document alike', () => {
    expect(buildQueuedFileItem(file('report.pdf'), 'pdf', 'pdfa').options).toMatchObject({ pdfa: {} });
    expect(buildQueuedFileItem(file('letter.docx'), 'pdf', 'pdfa').options).toMatchObject({ pdfa: {} });
    expect(buildQueuedFileItem(file('letter.docx'), 'pdf').options.pdfa).toBeUndefined();
  });
});

describe('the PDF/A page', () => {
  it('is a page that makes PDF/A files from PDFs, at the path the Tools menu links to, not the converter of a format no file has', () => {
    expect(parseConverterSlug('pdfa-converter')).toMatchObject({
      sourceFormat: 'pdf', targetFormat: 'pdf', copy: { kind: 'pdfa' }, canonicalPath: '/pdfa-converter',
    });
  });

  it('shows the PDF tiles, and a PDF dropped on it takes PDF with the export on', async () => {
    const host = await mountSlug(ConverterPageView, 'pdfa-converter');
    expect(host.querySelector('[data-testid=hero-source-format-btn]')?.getAttribute('aria-label')).toBe('Source format PDF');
    expect(host.querySelector('[data-testid=hero-target-format-btn]')?.getAttribute('aria-label')).toBe('Target format PDF');
    drop(host, [file('report.pdf')]);
    await vi.waitFor(() => expect(host.querySelector('[data-testid=queue-target-format-btn]')?.textContent).toBe('PDF'));
  });
});

describe('the OCR page', () => {
  it('opens the options of a dropped image with text recognition already on', async () => {
    const host = await mountSlug(ConverterPageView, 'pdf-ocr');
    drop(host, [file('scan.png')]);
    const options = await vi.waitFor(() => {
      const button = host.querySelector<HTMLElement>('[data-testid=queue-options-btn]');
      expect(button).not.toBeNull();
      return button!;
    });
    options.click();
    const checkbox = await vi.waitFor(() => {
      const element = document.querySelector<HTMLInputElement>('#opt-doc-ocr');
      expect(element).not.toBeNull();
      return element!;
    });
    expect(checkbox.checked).toBe(true);
  });
});
