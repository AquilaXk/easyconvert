import { describe, expect, it } from 'vitest';
import { emlMessageHtml, readEmlMessage, sanitizeUntrustedHtmlFragment } from '../src/lib/conversions/office/eml-reader';

/**
 * A remote image in a mail is a tracking pixel: opening the converted page tells the sender that, when and from where the mail
 * was read. The converted page requests nothing remote (policy 449); the images the mail carries as data: URIs stay.
 */
const htmlMail = (body: string): Buffer =>
  Buffer.from(`Subject: s\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body>${body}</body></html>`);
const render = (body: string): string => emlMessageHtml(readEmlMessage(htmlMail(body)));

describe('the HTML page of a mail', () => {
  it('drops the address of a remote image and keeps its alt text', () => {
    const html = render('<p>Hi</p><img src="https://t.example/pixel.gif?u=42" alt="Logo" width="1" height="1">');
    expect(html).not.toContain('t.example');
    expect(html).not.toContain('src=');
    expect(html).toContain('<img alt="Logo">');
  });

  it('drops a remote image without alt text and a protocol-relative one', () => {
    const html = render('<img src="http://t.example/a.png"><img src="//t.example/b.png"><p>text</p>');
    expect(html).not.toContain('t.example');
    expect(html).not.toContain('<img');
    expect(html).toContain('<p>text</p>');
  });

  it('keeps an image that the mail carries as a data URI', () => {
    const html = render('<img src="data:image/png;base64,iVBORw0KGgo=" alt="ok">');
    expect(html).toContain('<img src="data:image/png;base64,iVBORw0KGgo=" alt="ok">');
  });

  it('keeps links, which load nothing until they are followed', () => {
    expect(render('<a href="https://example.com/x">link</a>')).toContain('<a href="https://example.com/x" rel="noopener noreferrer">link</a>');
  });

  it('allows only data: images in its content security policy', () => {
    const html = render('<p>x</p>');
    expect(html).toContain('img-src data:;');
    expect(html).not.toMatch(/img-src[^;]*https?:/);
  });
});

describe('the sanitizer for HTML pages that the reader wrote themselves', () => {
  it('keeps remote images unless the caller turns them off', () => {
    const fragment = '<img src="https://example.com/a.png" alt="a">';
    expect(sanitizeUntrustedHtmlFragment(fragment)).toBe('<img src="https://example.com/a.png" alt="a">');
    expect(sanitizeUntrustedHtmlFragment(fragment, { allowRemoteImages: false })).toBe('<img alt="a">');
  });
});
