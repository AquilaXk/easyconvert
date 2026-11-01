import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { NextIntlClientProvider, useFormatter } from 'next-intl';
import ViewerTimeZone, { ViewerTimeZoneProvider, browserTimeZone } from '../src/i18n/ViewerTimeZone';

/**
 * Dates the interface formats in the browser read in the viewer's time zone, not the zone of the server that prerendered
 * the page. The server provider hands its own zone (UTC on the build host) to the client components; the viewer's zone,
 * read from the browser, takes its place there.
 */

const ORIGINAL_TZ = process.env.TZ;
const INSTANT = new Date('2026-11-01T00:30:00Z');

function CheckedAt() {
  return createElement('span', null, useFormatter().dateTime(INSTANT, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
}

function rendered(viewerZone: string | undefined): string {
  const inner = createElement(ViewerTimeZoneProvider, { timeZone: viewerZone, children: createElement(CheckedAt) });
  return renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: 'en', timeZone: 'UTC', messages: {}, children: inner }));
}

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('client-formatted dates use the viewer time zone', () => {
  it('reads the browser zone, which follows TZ', () => {
    process.env.TZ = 'Asia/Seoul';
    expect(browserTimeZone()).toBe('Asia/Seoul');
    process.env.TZ = 'America/Los_Angeles';
    expect(browserTimeZone()).toBe('America/Los_Angeles');
  });

  it('formats in the viewer zone instead of the server zone the page was rendered with', () => {
    process.env.TZ = 'Asia/Seoul';
    expect(rendered(browserTimeZone())).toBe('<span>09:30</span>');
  });

  it('keeps the server zone until the browser zone is known, so the first client render matches the server HTML', () => {
    expect(rendered(undefined)).toBe('<span>00:30</span>');
  });

  it('renders the server snapshot in the server zone, even on a host whose own zone is another', () => {
    process.env.TZ = 'Asia/Seoul';
    const page = createElement(ViewerTimeZone, { children: createElement(CheckedAt) });
    expect(renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: 'en', timeZone: 'UTC', messages: {}, children: page }))).toBe(
      '<span>00:30</span>'
    );
  });
});
