import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/fetch-url/route';
import { parseConverterSlug } from '../src/lib/slug-parser';
import { parsedSlug, slugPageCopy } from './helpers/intl';

describe('Subpages & Routes Verification', () => {
  describe('Real Dynamic Converter Slug Parser', () => {
    it('correctly parses format pairs like pdf-to-docx', () => {
      const parsed = parsedSlug('pdf-to-docx');
      expect(parsed.isInfoPage).toBe(false);
      expect(parsed.sourceFormat).toBe('pdf');
      expect(parsed.targetFormat).toBe('docx');
      expect(slugPageCopy('pdf-to-docx').title).toBe('PDF to DOCX Converter');
    });

    it('correctly parses category converter slugs like pdf-converter', () => {
      const parsed = parsedSlug('pdf-converter');
      expect(parsed.isInfoPage).toBe(false);
      expect(parsed.sourceFormat).toBe('pdf');
      expect(parsed.targetFormat).toBe('any');
      expect(slugPageCopy('pdf-converter').title).toBe('PDF Converter');
    });

    it('correctly parses video-converter to mp4 and any', () => {
      const parsed = parsedSlug('video-converter');
      expect(parsed.sourceFormat).toBe('mp4');
      expect(parsed.targetFormat).toBe('any');
    });

    it('correctly parses merge and compress utility slugs', () => {
      expect(slugPageCopy('merge-pdf').title).toBe('Merge PDF');
      expect(slugPageCopy('compress-pdf').title).toBe('Compress PDF');
      expect(slugPageCopy('compress-png').title).toBe('Compress PNG');
      expect(slugPageCopy('compress-jpg').title).toBe('Compress JPG');
      expect(slugPageCopy('create-zip-archive').title).toBe('Create Archive');
      expect(slugPageCopy('extract-zip-archive').title).toBe('Extract Archive');
      expect(slugPageCopy('split-pdf').title).toBe('Split PDF');
      expect(slugPageCopy('rotate-pdf').title).toBe('Rotate PDF');
    });

    it('correctly parses website capture tools', () => {
      const webPdf = parsedSlug('save-website-as-pdf');
      expect(webPdf.sourceFormat).toBe('html');
      expect(webPdf.targetFormat).toBe('pdf');

      const webPng = parsedSlug('website-png-screenshot');
      expect(webPng.sourceFormat).toBe('html');
      expect(webPng.targetFormat).toBe('png');
    });

    it('correctly identifies informational pages without treating them as file formats', () => {
      const contact = parsedSlug('contact');
      expect(contact.isInfoPage).toBe(true);
      expect(contact.infoType).toBe('contact');

      const about = parsedSlug('about');
      expect(about.isInfoPage).toBe(true);
      expect(about.infoType).toBe('about');

      const security = parsedSlug('security');
      expect(security.isInfoPage).toBe(true);
      expect(security.infoType).toBe('security');

      // forgot-password is completely purged as EasyConvert has zero auth/accounts
      expect(parseConverterSlug('forgot-password')).toBeNull();
    });
  });

  describe('Url Import Endpoint Security & SSRF Protection', () => {
    // A visitor a declared proxy attributes: one no proxy attributes is refused every link import, as every upload.
    const VISITOR = { 'x-forwarded-for': '203.0.113.42' };

    beforeEach(() => {
      vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('blocks internal loopback and private IPv4 ranges', async () => {
      const privateUrls = [
        'http://localhost:8080/secret.txt',
        'http://127.0.0.1:3000/api',
        'http://10.0.0.1/admin',
        'http://192.168.1.1/router',
        'http://172.16.0.1/conf',
      ];

      for (const url of privateUrls) {
        const req = new NextRequest('http://localhost:3000/api/fetch-url', {
          method: 'POST',
          headers: VISITOR,
          body: JSON.stringify({ url }),
        });
        const res = await POST(req);
        expect(res.status).toBe(403);
        const data = await res.json();
        expect(data.error).toContain('Requests to internal/private addresses are blocked');
      }
    });

    it('rejects unsupported protocols like file:// or ftp://', async () => {
      const req = new NextRequest('http://localhost:3000/api/fetch-url', {
        method: 'POST',
        headers: VISITOR,
        body: JSON.stringify({ url: 'file:///etc/passwd' }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('Only HTTP and HTTPS URLs are permitted');
    });

    it('rejects malformed URLs', async () => {
      const req = new NextRequest('http://localhost:3000/api/fetch-url', {
        method: 'POST',
        headers: VISITOR,
        body: JSON.stringify({ url: 'not-a-valid-url' }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('Invalid URL format');
    });
  });
});
