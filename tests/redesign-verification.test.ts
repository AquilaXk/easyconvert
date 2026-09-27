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

  it('verifies login and register routes and AuthModal have been completely eliminated', () => {
    const loginPath = path.join(rootDir, 'src', 'app', 'login');
    const registerPath = path.join(rootDir, 'src', 'app', 'register');
    const authModalPath = path.join(rootDir, 'src', 'components', 'AuthModal.tsx');
    expect(fs.existsSync(loginPath)).toBe(false);
    expect(fs.existsSync(registerPath)).toBe(false);
    expect(fs.existsSync(authModalPath)).toBe(false);
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

  it('verifies Header is sleek without auth/login/signup residue and contains key elements', () => {
    const headerPath = path.join(rootDir, 'src', 'components', 'Header.tsx');
    const headerContent = fs.readFileSync(headerPath, 'utf-8');

    // No auth/login/signup residue or state handlers
    expect(headerContent).not.toContain('AuthModal');
    expect(headerContent).not.toContain('Sign in');
    expect(headerContent).not.toContain('Sign up');
    expect(headerContent).not.toContain('href="/login"');
    expect(headerContent).not.toContain('href="/register"');
    expect(headerContent).not.toContain('easyconvert_user');
    expect(headerContent).not.toContain('handleAuthSuccess');
    expect(headerContent).not.toContain('handleSignOut');
    expect(headerContent).not.toContain('userEmail');
    expect(headerContent).not.toContain('isAuthOpen');
    expect(headerContent).not.toContain('authMode');

    // Key elements present: Brand Logo, Tools dropdown, Formats, How It Works, 100% Free badge, Dark/Light mode toggle
    expect(headerContent).toContain('<BrandLogo');
    expect(headerContent).toContain('<span>Tools</span>');
    expect(headerContent).toContain('aria-expanded={isToolsOpen}');
    expect(headerContent).toContain('aria-expanded={isMobileMenuOpen}');
    expect(headerContent).toContain('href="/#format-catalog"');
    expect(headerContent).toContain('href="/#how-it-works"');
    expect(headerContent).toContain('100% Free');
    expect(headerContent).toContain('toggleDarkMode');
  });

  it('verifies subpage scripts do not target eliminated auth routes', () => {
    const captureScriptPath = path.join(rootDir, 'scripts', 'capture-all-subpages.mjs');
    if (fs.existsSync(captureScriptPath)) {
      const scriptContent = fs.readFileSync(captureScriptPath, 'utf-8');
      expect(scriptContent).not.toContain("path: '/login'");
      expect(scriptContent).not.toContain("path: '/register'");
    }
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
    expect(footerContent).toMatch(/100% Client-Side (&|&amp;) Zero-Server Retention/);
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

  it('verifies Hero implements spacious converter architecture with Choose Files CTA and eliminates 2-card console box', () => {
    const heroPath = path.join(rootDir, 'src', 'components', 'Hero.tsx');
    const heroContent = fs.readFileSync(heroPath, 'utf-8');

    // Spacious hero structure with prominent Choose Files CTA
    expect(heroContent).toContain('Choose Files');
    expect(heroContent).toContain('292 Formats Supported');
    expect(heroContent).toContain('bg-brand-700');
    expect(heroContent).toContain('POPULAR:');

    // 2-card converter box and obsolete animations completely eliminated
    expect(heroContent).not.toContain('animate-card-flip');
    expect(heroContent).not.toContain('Conversion Console');
    expect(heroContent).not.toContain('animate-orbit-slow');
    expect(heroContent).not.toContain('animate-orbit-fast');
  });

  it('verifies design token alignment across Console, FormatSelector, and Features', () => {
    const selectorPath = path.join(rootDir, 'src', 'components', 'FormatSelector.tsx');
    const selectorContent = fs.readFileSync(selectorPath, 'utf-8');
    expect(selectorContent).toContain('#14182B');
    expect(selectorContent).toContain('#2B3556');

    const featuresPath = path.join(rootDir, 'src', 'components', 'Features.tsx');
    const featuresContent = fs.readFileSync(featuresPath, 'utf-8');
    expect(featuresContent).toContain('dark:bg-[#151A2E]');
    expect(featuresContent).toContain('dark:border-[#2B3556]');
  });

  it('verifies Dynamic Converter Page implements dynamic breadcrumb navigation', () => {
    const slugPagePath = path.join(rootDir, 'src', 'app', '[slug]', 'page.tsx');
    const slugContent = fs.readFileSync(slugPagePath, 'utf-8');

    // Breadcrumb navigation elements
    expect(slugContent).toContain('aria-label="Breadcrumb"');
    expect(slugContent).toContain('categoryLabel');
    expect(slugContent).toContain('srcKey');
    expect(slugContent).toContain('tgtKey');
    expect(slugContent).toContain('ChevronRight');
    expect(slugContent).toContain('Home');
  });

  it('verifies Dynamic Converter Page implements 3-step visual conversion workflow', () => {
    const slugPagePath = path.join(rootDir, 'src', 'app', '[slug]', 'page.tsx');
    const slugContent = fs.readFileSync(slugPagePath, 'utf-8');

    // 3-step guide presence and structure
    expect(slugContent).toContain('Step-by-Step Guide');
    expect(slugContent).toContain('How to Convert');
    expect(slugContent).toContain('UploadCloud');
    expect(slugContent).toContain('Settings2');
    expect(slugContent).toContain('Download');
    expect(slugContent).toContain('01');
    expect(slugContent).toContain('02');
    expect(slugContent).toContain('03');
  });

  it('verifies Side-by-Side Format Specification Comparison Deck and technical dossier', () => {
    const slugPagePath = path.join(rootDir, 'src', 'app', '[slug]', 'page.tsx');
    const slugContent = fs.readFileSync(slugPagePath, 'utf-8');

    // Specification deck structure
    expect(slugContent).toContain('Technical Specifications');
    expect(slugContent).toContain('SOURCE FORMAT');
    expect(slugContent).toContain('TARGET FORMAT');
    expect(slugContent).toContain('Full Name');
    expect(slugContent).toContain('Developer');
    expect(slugContent).toContain('MIME Type');
    expect(slugContent).toContain('Key Capabilities');
    expect(slugContent).toContain('FORMAT_SPECIFICATIONS');
  });

  it('verifies top leaderboard ad unit has CLS protection container', () => {
    const slugPagePath = path.join(rootDir, 'src', 'app', '[slug]', 'page.tsx');
    const slugContent = fs.readFileSync(slugPagePath, 'utf-8');

    expect(slugContent).toContain('min-h-[50px] sm:min-h-[64px]');
  });

  it('verifies fake rating pills are purged and replaced with genuine client-side zero-retention guarantee', () => {
    const slugPagePath = path.join(rootDir, 'src', 'app', '[slug]', 'page.tsx');
    const slugContent = fs.readFileSync(slugPagePath, 'utf-8');

    // Fake social proof and manufactured ratings must be purged completely
    expect(slugContent).not.toContain('4.8 / 5.0');
    expect(slugContent).not.toContain('14,200+ user ratings');
    expect(slugContent).not.toContain('rating-star-');

    // Genuine verifiable architecture guarantees must be present
    expect(slugContent).toContain('100% Free & Unlimited');
    expect(slugContent).toContain('Zero Server Storage');
    expect(slugContent).toContain('Private & Secure');
    expect(slugContent).toContain('Client-Side WebAssembly Pipeline');
  });

  it('verifies AdBanner implements industry-standard IAB units and eliminates fake SaaS marketing cards', () => {
    const adBannerPath = path.join(rootDir, 'src', 'components', 'AdBanner.tsx');
    const adBannerContent = fs.readFileSync(adBannerPath, 'utf-8');

    // Must NOT contain fake feature/sponsored cards pretending to be ads
    expect(adBannerContent).not.toContain('High-speed edge cloud network');
    expect(adBannerContent).not.toContain('Fast & Secure Storage Sponsor');
    expect(adBannerContent).not.toContain('Enterprise Cloud Infrastructure');
    expect(adBannerContent).not.toContain('100% Free Service');

    // Must contain standardized Advertisement header and IAB dimension labels
    expect(adBannerContent).toContain('Advertisement');
    expect(adBannerContent).toContain('Ad Choices');
    expect(adBannerContent).toContain('728 × 90 Leaderboard');
    expect(adBannerContent).toContain('300 × 250 Medium Rectangle');
  });

  it('verifies category-aware dynamic descriptions in parseConverterSlug without AI slop', () => {
    // Video to Audio pair should NOT claim to preserve typography or document formatting
    const mp4ToMp3 = parseConverterSlug('mp4-to-mp3');
    expect(mp4ToMp3.pageDescription).not.toContain('layouts, fonts, and data formatting');
    expect(mp4ToMp3.pageDescription).toContain('audio');

    // Document pair should preserve layout and typography
    const pdfToDocx = parseConverterSlug('pdf-to-docx');
    expect(pdfToDocx.pageDescription).toContain('layouts, formatting');

    // Format converters should not falsely claim to be document converters or mention MS Office
    const mp4Converter = parseConverterSlug('mp4-converter');
    expect(mp4Converter.pageDescription).not.toContain('online document converter');
    expect(mp4Converter.pageDescription).not.toContain('Microsoft Office');
    expect(mp4Converter.pageDescription).toContain('video');

    const svgConverter = parseConverterSlug('svg-converter');
    expect(svgConverter.pageDescription).not.toContain('online document converter');
    expect(svgConverter.pageDescription).not.toContain('Microsoft Office');
  });

  it('verifies category-aware dynamic descriptions in parseConverterSlug without AI slop', () => {
    // Video to Audio pair should NOT claim to preserve typography or document formatting
    const mp4ToMp3 = parseConverterSlug('mp4-to-mp3');
    expect(mp4ToMp3.pageDescription).not.toContain('layouts, fonts, and data formatting');
    expect(mp4ToMp3.pageDescription).toContain('audio');

    // Document pair should preserve layout and typography
    const pdfToDocx = parseConverterSlug('pdf-to-docx');
    expect(pdfToDocx.pageDescription).toContain('layouts, formatting');

    // Format converters should not falsely claim to be document converters or mention external office software
    const mp4Converter = parseConverterSlug('mp4-converter');
    expect(mp4Converter.pageDescription).not.toContain('online document converter');
    expect(mp4Converter.pageDescription).not.toContain('Microsoft Office');
    expect(mp4Converter.pageDescription).toContain('video');

    const svgConverter = parseConverterSlug('svg-converter');
    expect(svgConverter.pageDescription).not.toContain('online document converter');
    expect(svgConverter.pageDescription).not.toContain('Microsoft Office');
  });

  it('verifies FaqSection accordion conforms to WCAG accessibility standards', () => {
    const faqPath = path.join(rootDir, 'src', 'components', 'FaqSection.tsx');
    const faqContent = fs.readFileSync(faqPath, 'utf-8');

    expect(faqContent).toContain('aria-expanded={isOpen}');
    expect(faqContent).toContain('aria-controls={`faq-answer-${idx}`}');
    expect(faqContent).toContain('id={`faq-answer-${idx}`}');
    expect(faqContent).toContain('role="region"');
  });

  it('verifies Dynamic Converter Page maintains clean dual-theme scaffold regardless of queue state', () => {
    const slugPagePath = path.join(rootDir, 'src', 'app', '[slug]', 'page.tsx');
    const slugContent = fs.readFileSync(slugPagePath, 'utf-8');

    expect(slugContent).toContain(
      'className="flex flex-col min-h-screen bg-neutral-scaffold dark:bg-dark-scaffold text-brand-950 dark:text-dark-text transition-colors"'
    );
  });

  it('verifies Dynamic Converter Page handles category slugs and protects specification arrays', () => {
    const slugPagePath = path.join(rootDir, 'src', 'app', '[slug]', 'page.tsx');
    const slugContent = fs.readFileSync(slugPagePath, 'utf-8');

    expect(slugContent).toContain('isCategorySlug');
    expect(slugContent).toContain('(meta.advantages || []).map');
    expect(slugContent).toContain('FormatDossierCard');
    expect(slugContent).toContain('useClientQueue');
  });

  it('verifies ConversionQueue eliminates duplicate fixed bottom bar and fake cloud storage options', () => {
    const queuePath = path.join(rootDir, 'src', 'components', 'ConversionQueue.tsx');
    const queueContent = fs.readFileSync(queuePath, 'utf-8');

    // Must NOT have redundant fixed bottom bar causing duplicate CTA dock
    expect(queueContent).not.toContain('fixed bottom-0');
    expect(queueContent).not.toContain('files ready');

    // Must NOT have fake/dummy cloud storage options
    expect(queueContent).not.toContain('From Google Drive');
    expect(queueContent).not.toContain('From Dropbox');
    expect(queueContent).not.toContain('From OneDrive');

    // Must have clean attached conversion dock with Add more files and Convert CTA
    expect(queueContent).toContain('Add more files');
    expect(queueContent).toContain('Convert');
  });

  it('verifies Hero and dynamic slug pages do not contain fake cloud storage options or claims', () => {
    const heroPath = path.join(rootDir, 'src', 'components', 'Hero.tsx');
    const heroContent = fs.readFileSync(heroPath, 'utf-8');
    expect(heroContent).not.toContain('From Google Drive');
    expect(heroContent).not.toContain('From Dropbox');
    expect(heroContent).not.toContain('From OneDrive');

    const slugPath = path.join(rootDir, 'src', 'app', '[slug]', 'page.tsx');
    const slugContent = fs.readFileSync(slugPath, 'utf-8');
    expect(slugContent).not.toContain('import from URLs or cloud storage');
    expect(slugContent).not.toContain('From Google Drive');
    expect(slugContent).not.toContain('From Dropbox');
  });
});



