import React from 'react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import AdBanner from '@/components/AdBanner';
import FaqSection from '@/components/FaqSection';
import StatusDashboard from '@/components/StatusDashboard';
import UnitConverter from '@/components/UnitConverter';
import type { ParsedSlug } from '@/lib/slug-parser';

const ROOT_SHELL_CLASS =
  'flex flex-col min-h-screen bg-neutral-scaffold dark:bg-dark-scaffold text-brand-950 dark:text-dark-text transition-colors';

function PrivacyContent() {
  return (
    <>
      <section className="space-y-2">
        <h2 className="text-lg font-bold text-brand-950 dark:text-white">Zero Permanent Retention</h2>
        <p>
          EasyConvert processes supported client-side conversions directly in your browser memory without uploading source
          files to external storage.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-bold text-brand-950 dark:text-white">
          Isolated Worker Execution &amp; Automatic TTL Cleanup
        </h2>
        <p>
          When a format pair uses server-assisted processing or the REST API, requests travel over TLS 1.3 into isolated
          ephemeral worker containers. Output artifacts are removed automatically after download or when their short
          retention TTL expires.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-bold text-brand-950 dark:text-white">No Content Resale or Inspection</h2>
        <p>
          We do not sell, rent, or train models on your files. Uploaded bytes exist only to complete the conversion you
          requested.
        </p>
      </section>
    </>
  );
}

function TermsContent() {
  return (
    <>
      <section className="space-y-2">
        <h2 className="text-lg font-bold text-brand-950 dark:text-white">1. Acceptance of Terms</h2>
        <p>
          By accessing or using EasyConvert, you agree to these Terms of Service. If you do not agree, discontinue use
          of the service.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-bold text-brand-950 dark:text-white">2. Acceptable Use</h2>
        <p>
          You agree not to convert content that you lack permission to process, and not to submit malicious binaries,
          exploit payloads, or unlawful material.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-bold text-brand-950 dark:text-white">3. Service Availability &amp; Free Use</h2>
        <p>
          EasyConvert is 100% free with unlimited conversions in the web application. Interactive browser conversions
          require no subscription, credit pack, or paid account.
        </p>
      </section>
    </>
  );
}

function ContactContent() {
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h2 className="text-lg font-bold text-brand-950 dark:text-white">Get in Touch</h2>
        <p>
          Send questions about format support, conversion fidelity, or API integration directly to our engineering team.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
        <div className="p-5 rounded-lg bg-neutral-scaffold dark:bg-white/5 border border-neutral-border dark:border-dark-border space-y-2">
          <h3 className="font-bold text-brand-950 dark:text-white text-sm">Direct Support Email</h3>
          <p className="text-xs text-ink-secondary dark:text-neutral-400">
            Contact our engineering team for technical questions, API inquiries, or general feedback.
          </p>
          <a
            href="mailto:support@easyconvert.com"
            className="min-h-[44px] inline-flex items-center gap-1.5 text-xs font-semibold text-brand-700 dark:text-brand-400 hover:underline"
          >
            support@easyconvert.com
          </a>
        </div>

        <div className="p-5 rounded-lg bg-neutral-scaffold dark:bg-white/5 border border-neutral-border dark:border-dark-border space-y-2">
          <h3 className="font-bold text-brand-950 dark:text-white text-sm">Bug Reports &amp; Issues</h3>
          <p className="text-xs text-ink-secondary dark:text-neutral-400">
            Found an edge case or rendering discrepancy? Email reproduction steps and a non-sensitive sample file.
          </p>
          <a
            href="mailto:support@easyconvert.com?subject=Bug%20Report"
            className="min-h-[44px] inline-flex items-center gap-1.5 text-xs font-semibold text-brand-700 dark:text-brand-400 hover:underline"
          >
            Report an Issue
          </a>
        </div>
      </div>
    </div>
  );
}

function AboutContent({ totalFormatCount }: Readonly<{ totalFormatCount: number }>) {
  return (
    <>
      <section className="space-y-2">
        <h2 className="text-lg font-bold text-brand-950 dark:text-white">Purpose-Built File Conversion Utility</h2>
        <p>
          EasyConvert provides fast, accurate file conversions across {totalFormatCount} registered formats spanning
          documents, spreadsheets, presentations, raster and RAW images, vector graphics, CAD drawings, audio, video,
          fonts, ebooks, and archives.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-bold text-brand-950 dark:text-white">Hybrid Browser &amp; Ephemeral Sandbox Architecture</h2>
        <p>
          Browser-supported formats run locally on your device through WebAssembly and WebCodecs. Heavy or specialized
          containers execute inside isolated worker sandboxes over TLS 1.3 with automatic short-TTL cleanup.
        </p>
      </section>
    </>
  );
}

function SecurityContent({ totalFormatCount }: Readonly<{ totalFormatCount: number }>) {
  return (
    <>
      <section className="space-y-2">
        <h2 className="text-lg font-bold text-brand-950 dark:text-white">TLS 1.3 Transport Encryption</h2>
        <p>
          All HTTPS traffic uses TLS 1.3 with strict HSTS headers, CSRF validation on cookie-authenticated routes, and
          scoped bearer keys for programmatic API calls across {totalFormatCount} supported formats.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-bold text-brand-950 dark:text-white">Sandboxed Browser &amp; Worker Isolation</h2>
        <p>
          Client-side conversions stay inside the browser origin sandbox. Server-assisted jobs execute in resource-bounded
          worker processes with strict input validation, archive decompression limits, and automatic TTL artifact deletion.
        </p>
      </section>
    </>
  );
}

function AccessibilityContent() {
  return (
    <>
      <section className="space-y-2">
        <h2 className="text-lg font-bold text-brand-950 dark:text-white">Conformance Target</h2>
        <p>
          EasyConvert targets Web Content Accessibility Guidelines (WCAG) 2.1 Level AA conformance across desktop,
          tablet, and mobile viewports in both light and dark themes.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-bold text-brand-950 dark:text-white">Keyboard Navigation &amp; Shortcuts</h2>
        <p>
          Every interactive control is operable with a keyboard alone. A skip link jumps directly to{' '}
          <code>#main-content</code>, focus indicators remain visible on all interactive elements, format selectors and
          tabs support arrow and tab key navigation, and modal dialogs use native HTML <code>&lt;dialog&gt;</code> focus
          containment with <code>Escape</code> dismissal.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-bold text-brand-950 dark:text-white">
          Screen Reader Landmarks &amp; Live Announcements
        </h2>
        <p>
          Pages expose semantic <code>&lt;header&gt;</code>, <code>&lt;nav&gt;</code>, <code>&lt;main&gt;</code>, and{' '}
          <code>&lt;footer&gt;</code> landmarks, sequential heading levels from <code>h1</code> through <code>h3</code>,
          explicit <code>&lt;label htmlFor&gt;</code> associations on every text input and selector, descriptive{' '}
          <code>aria-label</code> names on icon-only controls, and polite status regions for conversion progress and
          clipboard confirmation.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-bold text-brand-950 dark:text-white">Visual Contrast, Motion &amp; Zoom</h2>
        <p>
          Body copy maintains at least a 4.5:1 contrast ratio and interactive UI boundaries maintain at least a 3:1
          contrast ratio across light and dark palettes. Form controls use a minimum 16px text size to prevent forced
          viewport zoom on mobile browsers, primary and icon buttons provide 44px touch targets, layouts reflow cleanly
          at 390px width and 200% browser zoom without horizontal page scroll, and non-essential motion honours{' '}
          <code>prefers-reduced-motion</code>.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-bold text-brand-950 dark:text-white">Feedback &amp; Assistance</h2>
        <p>
          If you encounter an accessibility barrier on any EasyConvert page or API tool, contact our team so we can
          reproduce and resolve the issue promptly.
        </p>
        <div>
          <a
            href="mailto:support@easyconvert.com?subject=Accessibility%20Feedback"
            className="min-h-[44px] inline-flex items-center gap-1.5 text-sm font-semibold text-brand-700 dark:text-brand-400 hover:underline"
          >
            support@easyconvert.com (Accessibility Feedback)
          </a>
        </div>
      </section>
    </>
  );
}

interface ConverterInfoPageProps {
  parsed: ParsedSlug;
  totalFormatCount: number;
}

export function ConverterInfoPage({ parsed, totalFormatCount }: Readonly<ConverterInfoPageProps>) {
  if (parsed.infoType === 'status') {
    return (
      <div className={ROOT_SHELL_CLASS}>
        <Header />
        <main id="main-content" className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-12">
          <div className="mb-8">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-brand-950 dark:text-white">
              {parsed.pageTitle}
            </h1>
            <p className="mt-2 text-sm sm:text-base text-ink-secondary dark:text-neutral-400 max-w-3xl">
              {parsed.pageDescription}
            </p>
          </div>
          <StatusDashboard />
        </main>
        <Footer />
      </div>
    );
  }

  if (parsed.infoType === 'unit') {
    return (
      <div className={ROOT_SHELL_CLASS}>
        <Header />
        <main id="main-content" className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-12">
          <div className="mb-8">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-brand-950 dark:text-white">
              {parsed.pageTitle}
            </h1>
            <p className="mt-2 text-sm sm:text-base text-ink-secondary dark:text-neutral-400 max-w-2xl">
              {parsed.pageDescription}
            </p>
          </div>
          <UnitConverter initialSrc={parsed.sourceFormat} initialTgt={parsed.targetFormat} />
          <div className="mt-12">
            <AdBanner slot="mid-content" />
          </div>
          <div className="mt-10">
            <FaqSection />
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className={ROOT_SHELL_CLASS}>
      <Header />
      <main id="main-content" className="flex-1 max-w-4xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold text-brand-950 dark:text-white tracking-tight">
            {parsed.pageTitle}
          </h1>
          <p className="mt-2 text-sm sm:text-base text-ink-secondary dark:text-neutral-400">
            {parsed.pageDescription}
          </p>
        </div>

        <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-xl p-6 sm:p-8 shadow-sm space-y-6 text-sm text-ink-secondary dark:text-neutral-300 leading-relaxed">
          {parsed.infoType === 'privacy' && <PrivacyContent />}
          {parsed.infoType === 'terms' && <TermsContent />}
          {parsed.infoType === 'contact' && <ContactContent />}
          {parsed.infoType === 'about' && <AboutContent totalFormatCount={totalFormatCount} />}
          {parsed.infoType === 'security' && <SecurityContent totalFormatCount={totalFormatCount} />}
          {parsed.infoType === 'accessibility' && <AccessibilityContent />}
        </div>
      </main>
      <Footer />
    </div>
  );
}
