import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseConverterSlug } from '../src/lib/slug-parser';
import { FORMAT_REGISTRY } from '../src/lib/registry';

describe('Redesign & Free Static Architecture Verification', () => {
  const rootDir = path.resolve(__dirname, '..');

  it('verifies obsolete pricing page route has been completely eliminated', () => {
    const pricingPagePath = path.join(rootDir, 'src', 'app', 'pricing', 'page.tsx');
    expect(fs.existsSync(pricingPagePath)).toBe(false);
  });

  it('verifies obsolete api/v2 documentation page route has been completely eliminated', () => {
    const apiV2PagePath = path.join(rootDir, 'src', 'app', 'api', 'v2', 'page.tsx');
    expect(fs.existsSync(apiV2PagePath)).toBe(false);
  });

  it('verifies Header uses root-relative anchor links to prevent dead links on subpages', () => {
    const headerPath = path.join(rootDir, 'src', 'components', 'Header.tsx');
    const headerContent = fs.readFileSync(headerPath, 'utf-8');

    // Should point to /#format-catalog and /#how-it-works
    expect(headerContent).toContain('href="/#format-catalog"');
    expect(headerContent).toContain('href="/#how-it-works"');

    // Should NOT contain bare anchor links href="#format-catalog" or href="#how-it-works"
    expect(headerContent).not.toMatch(/href="#format-catalog"/);
    expect(headerContent).not.toMatch(/href="#how-it-works"/);

    // Should contain 100% Free badge
    expect(headerContent).toContain('100% Free');
  });

  it('verifies Footer uses root-relative anchor links to prevent dead links on subpages', () => {
    const footerPath = path.join(rootDir, 'src', 'components', 'Footer.tsx');
    const footerContent = fs.readFileSync(footerPath, 'utf-8');

    expect(footerContent).toContain('href="/#format-catalog"');
    expect(footerContent).toContain('href="/#how-it-works"');
    expect(footerContent).not.toMatch(/href="#format-catalog"/);
    expect(footerContent).not.toMatch(/href="#how-it-works"/);

    // Obsolete pricing and api links should not exist
    expect(footerContent).not.toContain('/pricing');
    expect(footerContent).not.toContain('/api/v2');

    // Categorized converter directory headings
    expect(footerContent).toContain('Video Converter');
    expect(footerContent).toContain('Audio Converter');
    expect(footerContent).toContain('Image Converter');
    expect(footerContent).toContain('Document & Ebook');
    expect(footerContent).toContain('Archive & Compression');
    expect(footerContent).toContain('Data & Unit Tools');
    expect(footerContent).toContain('Web Apps');
    expect(footerContent).toContain('Client & Edge Tools');

    // Key conversion routes
    expect(footerContent).toContain('href: \'/mp4-to-mp3\'');
    expect(footerContent).toContain('href: \'/jpg-to-pdf\'');
    expect(footerContent).toContain('href: \'/pdf-to-docx\'');
    expect(footerContent).toContain('href: \'/video-to-gif\'');
    expect(footerContent).toContain('href: \'/heic-to-jpg\'');
    expect(footerContent).toContain('href: \'/rar-to-zip\'');

    // Privacy badge and copyright
    expect(footerContent).toContain('100% Client-Side & Zero-Server Retention');
    expect(footerContent).toContain('© 2026 EasyConvert.com');
  });

  it('verifies Terms of Service has no obsolete daily quotas or paid credits mentions', () => {
    const slugPagePath = path.join(rootDir, 'src', 'app', '[slug]', 'page.tsx');
    const slugContent = fs.readFileSync(slugPagePath, 'utf-8');

    expect(slugContent).not.toContain('10 daily conversions');
    expect(slugContent).not.toContain('credits with prioritized throughput');
    expect(slugContent).toContain('100% free with unlimited conversions');
  });

  it('verifies Hero component synchronizes target format on file drop and selection', () => {
    const heroPath = path.join(rootDir, 'src', 'components', 'Hero.tsx');
    const heroContent = fs.readFileSync(heroPath, 'utf-8');

    // Uses targetFormatRef to guard against closure latency
    expect(heroContent).toContain('targetFormatRef');
    expect(heroContent).toContain('const chosen = targetFormatRef.current');
  });

  it('verifies all Hero popular presets specify supported formats in FORMAT_REGISTRY', () => {
    const popularPresets = [
      { label: 'PDF to Word', src: 'pdf', tgt: 'docx' },
      { label: 'Word to PDF', src: 'docx', tgt: 'pdf' },
      { label: 'Image to WebP', src: 'png', tgt: 'webp' },
      { label: 'Video to MP3', src: 'mp4', tgt: 'mp3' },
      { label: 'HEIC to JPG', src: 'heic', tgt: 'jpg' },
      { label: 'EPUB to PDF', src: 'epub', tgt: 'pdf' },
    ];

    for (const preset of popularPresets) {
      const srcDef = FORMAT_REGISTRY[preset.src];
      expect(srcDef, `Source format ${preset.src} should exist`).toBeDefined();
      expect(
        srcDef.targetFormats.includes(preset.tgt),
        `Source ${preset.src} should support target ${preset.tgt}`
      ).toBe(true);
    }
  });

  it('verifies parseConverterSlug properly routes dynamic converter and informational paths', () => {
    const pdfToWord = parseConverterSlug('pdf-to-docx');
    expect(pdfToWord.isInfoPage).toBe(false);
    expect(pdfToWord.sourceFormat).toBe('pdf');
    expect(pdfToWord.targetFormat).toBe('docx');

    const terms = parseConverterSlug('terms');
    expect(terms.isInfoPage).toBe(true);
    expect(terms.infoType).toBe('terms');

    const privacy = parseConverterSlug('privacy');
    expect(privacy.isInfoPage).toBe(true);
    expect(privacy.infoType).toBe('privacy');

    const status = parseConverterSlug('status');
    expect(status.isInfoPage).toBe(true);
    expect(status.infoType).toBe('status');
    expect(status.pageTitle).toBe('System Status');

    const unitConverter = parseConverterSlug('unit-converter');
    expect(unitConverter.isInfoPage).toBe(true);
    expect(unitConverter.infoType).toBe('unit');

    const lbsToKg = parseConverterSlug('lbs-to-kg');
    expect(lbsToKg.isInfoPage).toBe(true);
    expect(lbsToKg.infoType).toBe('unit');
    expect(lbsToKg.pageTitle).toContain('LBS to KG');
  });

  it('verifies category and alias slugs resolve to registered canonical formats', () => {
    const testCases = [
      { slug: 'video-to-gif', expectedSrc: 'mp4', expectedTgt: 'gif', expectedTitle: 'Video to GIF Converter' },
      { slug: 'video-to-mp3', expectedSrc: 'mp4', expectedTgt: 'mp3', expectedTitle: 'Video to MP3 Converter' },
      { slug: 'image-to-pdf', expectedSrc: 'jpg', expectedTgt: 'pdf', expectedTitle: 'Image to PDF Converter' },
      { slug: 'pdf-to-word', expectedSrc: 'pdf', expectedTgt: 'docx', expectedTitle: 'PDF to Word Converter' },
      { slug: 'word-to-pdf', expectedSrc: 'docx', expectedTgt: 'pdf', expectedTitle: 'Word to PDF Converter' },
      { slug: 'cad-converter', expectedSrc: 'dxf', expectedTgt: 'any', expectedTitle: 'CAD Converter' },
      { slug: 'font-converter', expectedSrc: 'ttf', expectedTgt: 'any', expectedTitle: 'Font Converter' },
      { slug: 'vector-converter', expectedSrc: 'svg', expectedTgt: 'any', expectedTitle: 'Vector Converter' },
      { slug: 'presentation-converter', expectedSrc: 'pptx', expectedTgt: 'any', expectedTitle: 'Presentation Converter' },
      { slug: 'spreadsheet-converter', expectedSrc: 'xlsx', expectedTgt: 'any', expectedTitle: 'Spreadsheet Converter' },
      { slug: 'data-converter', expectedSrc: 'csv', expectedTgt: 'any', expectedTitle: 'Data Converter' },
    ];

    for (const tc of testCases) {
      const parsed = parseConverterSlug(tc.slug);
      expect(parsed.isInfoPage).toBe(false);
      expect(parsed.sourceFormat).toBe(tc.expectedSrc);
      expect(parsed.targetFormat).toBe(tc.expectedTgt);
      expect(parsed.pageTitle).toBe(tc.expectedTitle);

      const srcDef = FORMAT_REGISTRY[parsed.sourceFormat];
      expect(srcDef, `Format registry must define ${parsed.sourceFormat}`).toBeDefined();
    }
  });

  it('verifies footer directory grid uses balanced responsive layout with status link', () => {
    const footerPath = path.join(rootDir, 'src', 'components', 'Footer.tsx');
    const footerContent = fs.readFileSync(footerPath, 'utf-8');

    expect(footerContent).toContain('href="/status"');
    expect(footerContent).toContain('grid-cols-2 sm:grid-cols-4 lg:grid-cols-4 xl:grid-cols-8');
    expect(footerContent).toContain('easyconvert-theme-change');
  });
});
