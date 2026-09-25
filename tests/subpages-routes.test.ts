import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/fetch-url/route';
import { TIERS, calculateBaseCredits } from '../src/lib/pricing';
import { parseConverterSlug } from '../src/lib/slug-parser';

describe('Subpages & Routes Verification', () => {
  describe('Pricing volume calculation logic & Credits Calculator', () => {
    it('verifies 1,000 credits pricing matches live CloudConvert snapshot', () => {
      const tier1000 = TIERS.find((t) => t.credits === 1000);
      expect(tier1000).toBeDefined();
      expect(tier1000!.packagePrice).toBe(18.0);
      expect(tier1000!.subPrice).toBe(10.0);
      expect((tier1000!.packagePrice / tier1000!.credits).toFixed(3)).toBe('0.018');
      expect((tier1000!.subPrice / tier1000!.credits).toFixed(3)).toBe('0.010');
    });

    it('ensures volume discounts scale monotonically across all tiers', () => {
      for (let i = 1; i < TIERS.length; i++) {
        const prev = TIERS[i - 1];
        const curr = TIERS[i];
        const prevPkgRate = prev.packagePrice / prev.credits;
        const currPkgRate = curr.packagePrice / curr.credits;
        expect(currPkgRate).toBeLessThanOrEqual(prevPkgRate);
      }
    });

    it('correctly calculates base credits according to CloudConvert conversion matrices', () => {
      // General conversion -> 1 credit
      expect(calculateBaseCredits('convert', 'png', 'jpg')).toBe(1);
      expect(calculateBaseCredits('convert', 'mp4', 'mp3')).toBe(1);

      // Office to PDF -> 2 credits
      expect(calculateBaseCredits('convert', 'docx', 'pdf')).toBe(2);
      expect(calculateBaseCredits('convert', 'xlsx', 'pdf')).toBe(2);
      expect(calculateBaseCredits('convert', 'pptx', 'pdf')).toBe(2);

      // iWork to PDF -> 2 credits
      expect(calculateBaseCredits('convert', 'pages', 'pdf')).toBe(2);
      expect(calculateBaseCredits('convert', 'numbers', 'pdf')).toBe(2);
      expect(calculateBaseCredits('convert', 'key', 'pdf')).toBe(2);

      // PDF to Office -> 4 credits
      expect(calculateBaseCredits('convert', 'pdf', 'docx')).toBe(4);
      expect(calculateBaseCredits('convert', 'pdf', 'xlsx')).toBe(4);
      expect(calculateBaseCredits('convert', 'pdf', 'pptx')).toBe(4);

      // Other operations (Compress, Thumbnail, Capture, Merge) -> 1 credit
      expect(calculateBaseCredits('compress')).toBe(1);
      expect(calculateBaseCredits('thumbnail')).toBe(1);
      expect(calculateBaseCredits('capture')).toBe(1);
      expect(calculateBaseCredits('merge')).toBe(1);
    });
  });

  describe('Real Dynamic Converter Slug Parser', () => {
    it('correctly parses format pairs like pdf-to-docx', () => {
      const parsed = parseConverterSlug('pdf-to-docx');
      expect(parsed.isInfoPage).toBe(false);
      expect(parsed.sourceFormat).toBe('pdf');
      expect(parsed.targetFormat).toBe('docx');
      expect(parsed.pageTitle).toBe('PDF to DOCX Converter');
    });

    it('correctly parses category converter slugs like pdf-converter', () => {
      const parsed = parseConverterSlug('pdf-converter');
      expect(parsed.isInfoPage).toBe(false);
      expect(parsed.sourceFormat).toBe('pdf');
      expect(parsed.targetFormat).toBe('any');
      expect(parsed.pageTitle).toBe('PDF Converter');
    });

    it('correctly parses video-converter to mp4 and any', () => {
      const parsed = parseConverterSlug('video-converter');
      expect(parsed.sourceFormat).toBe('mp4');
      expect(parsed.targetFormat).toBe('any');
    });

    it('correctly parses merge and compress utility slugs', () => {
      const merge = parseConverterSlug('merge-pdf');
      expect(merge.pageTitle).toBe('Merge PDF');
      const compress = parseConverterSlug('compress-png');
      expect(compress.pageTitle).toBe('Compress PNG');
    });

    it('correctly parses website capture tools', () => {
      const webPdf = parseConverterSlug('save-website-as-pdf');
      expect(webPdf.sourceFormat).toBe('html');
      expect(webPdf.targetFormat).toBe('pdf');

      const webPng = parseConverterSlug('website-png-screenshot');
      expect(webPng.sourceFormat).toBe('html');
      expect(webPng.targetFormat).toBe('png');
    });

    it('correctly identifies informational pages without treating them as file formats', () => {
      const terms = parseConverterSlug('terms');
      expect(terms.isInfoPage).toBe(true);
      expect(terms.infoType).toBe('terms');
      expect(terms.pageTitle).toBe('Terms of Service');

      const privacy = parseConverterSlug('privacy');
      expect(privacy.isInfoPage).toBe(true);
      expect(privacy.infoType).toBe('privacy');

      const contact = parseConverterSlug('contact');
      expect(contact.isInfoPage).toBe(true);
      expect(contact.infoType).toBe('contact');

      const about = parseConverterSlug('about');
      expect(about.isInfoPage).toBe(true);
      expect(about.infoType).toBe('about');

      const security = parseConverterSlug('security');
      expect(security.isInfoPage).toBe(true);
      expect(security.infoType).toBe('security');

      const forgot = parseConverterSlug('forgot-password');
      expect(forgot.isInfoPage).toBe(true);
      expect(forgot.infoType).toBe('forgot-password');
    });
  });

  describe('Url Import Endpoint Security & SSRF Protection', () => {
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
        body: JSON.stringify({ url: 'not-a-valid-url' }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('Invalid URL format');
    });
  });
});
