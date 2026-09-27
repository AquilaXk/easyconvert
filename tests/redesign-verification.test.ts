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
  });
});
