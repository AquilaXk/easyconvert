import React from 'react';

export interface PolicySection {
  heading: string;
  body: React.ReactNode;
  footer?: React.ReactNode;
}

export function getPolicySections(
  infoType: string | undefined,
  totalFormatCount: number
): PolicySection[] {
  switch (infoType) {
    case 'privacy':
      return [
        {
          heading: 'Zero Permanent Retention',
          body: 'EasyConvert processes supported client-side conversions directly in your browser memory without uploading source files to external storage.',
        },
        {
          heading: 'Isolated Worker Execution & Automatic TTL Cleanup',
          body: 'When a format pair uses server-assisted processing or the REST API, requests travel over TLS 1.3 into isolated ephemeral worker containers. Output artifacts are removed automatically after download or when their short retention TTL expires.',
        },
        {
          heading: 'No Content Resale or Inspection',
          body: 'We do not sell, rent, or train models on your files. Uploaded bytes exist only to complete the conversion you requested.',
        },
      ];
    case 'terms':
      return [
        {
          heading: '1. Acceptance of Terms',
          body: 'By accessing or using EasyConvert, you agree to these Terms of Service. If you do not agree, discontinue use of the service.',
        },
        {
          heading: '2. Acceptable Use',
          body: 'You agree not to convert content that you lack permission to process, and not to submit malicious binaries, exploit payloads, or unlawful material.',
        },
        {
          heading: '3. Service Availability & Free Use',
          body: 'EasyConvert is 100% free with unlimited conversions in the web application. Interactive browser conversions require no subscription, credit pack, or paid account.',
        },
      ];
    case 'about':
      return [
        {
          heading: 'Purpose-Built File Conversion Utility',
          body: `EasyConvert provides fast, accurate file conversions across ${totalFormatCount} registered formats spanning documents, spreadsheets, presentations, raster and RAW images, vector graphics, CAD drawings, audio, video, fonts, ebooks, and archives.`,
        },
        {
          heading: 'Hybrid Browser & Ephemeral Sandbox Architecture',
          body: 'Browser-supported formats run locally on your device through WebAssembly and WebCodecs. Heavy or specialized containers execute inside isolated worker sandboxes over TLS 1.3 with automatic short-TTL cleanup.',
        },
      ];
    case 'security':
      return [
        {
          heading: 'TLS 1.3 Transport Encryption',
          body: `All HTTPS traffic uses TLS 1.3 with strict HSTS headers, CSRF validation on cookie-authenticated routes, and scoped bearer keys for programmatic API calls across ${totalFormatCount} supported formats.`,
        },
        {
          heading: 'Sandboxed Browser & Worker Isolation',
          body: 'Client-side conversions stay inside the browser origin sandbox. Server-assisted jobs execute in resource-bounded worker processes with strict input validation, archive decompression limits, and automatic TTL artifact deletion.',
        },
      ];
    case 'accessibility':
      return [
        {
          heading: 'Conformance Target',
          body: 'EasyConvert targets Web Content Accessibility Guidelines (WCAG) 2.1 Level AA conformance across desktop, tablet, and mobile viewports in both light and dark themes.',
        },
        {
          heading: 'Keyboard Navigation & Shortcuts',
          body: (
            <>
              Every interactive control is operable with a keyboard alone. A skip link jumps
              directly to <code>#main-content</code>, focus indicators remain visible on all
              interactive elements, format selectors and tabs support arrow and tab key navigation,
              and modal dialogs use native HTML <code>&lt;dialog&gt;</code> focus containment with{' '}
              <code>Escape</code> dismissal.
            </>
          ),
        },
        {
          heading: 'Screen Reader Landmarks & Live Announcements',
          body: (
            <>
              Pages expose semantic <code>&lt;header&gt;</code>, <code>&lt;nav&gt;</code>,{' '}
              <code>&lt;main&gt;</code>, and <code>&lt;footer&gt;</code> landmarks, sequential
              heading levels from <code>h1</code> through <code>h3</code>, explicit{' '}
              <code>&lt;label htmlFor&gt;</code> associations on every text input and selector,
              descriptive <code>aria-label</code> names on icon-only controls, and polite status
              regions for conversion progress and clipboard confirmation.
            </>
          ),
        },
        {
          heading: 'Visual Contrast, Motion & Zoom',
          body: (
            <>
              Body copy maintains at least a 4.5:1 contrast ratio and interactive UI boundaries
              maintain at least a 3:1 contrast ratio across light and dark palettes. Form controls
              use a minimum 16px text size to prevent forced viewport zoom on mobile browsers,
              primary and icon buttons provide 44px touch targets, layouts reflow cleanly at 390px
              width and 200% browser zoom without horizontal page scroll, and non-essential motion
              honours <code>prefers-reduced-motion</code>.
            </>
          ),
        },
        {
          heading: 'Feedback & Assistance',
          body: 'If you encounter an accessibility barrier on any EasyConvert page or API tool, contact our team so we can reproduce and resolve the issue promptly.',
          footer: (
            <div>
              <a
                href="mailto:support@easyconvert.com?subject=Accessibility%20Feedback"
                className="min-h-[44px] inline-flex items-center gap-1.5 text-sm font-semibold text-brand-700 dark:text-brand-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 rounded"
              >
                support@easyconvert.com (Accessibility Feedback)
              </a>
            </div>
          ),
        },
      ];
    default:
      return [];
  }
}

export function ContactContent() {
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h2 className="text-lg font-bold text-brand-950 dark:text-white">Get in Touch</h2>
        <p>
          Send questions about format support, conversion fidelity, or API integration directly to
          our engineering team.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
        <div className="p-5 rounded-lg bg-neutral-scaffold dark:bg-white/5 border border-neutral-border dark:border-dark-border space-y-2">
          <h3 className="font-bold text-brand-950 dark:text-white text-sm">Direct Support Email</h3>
          <p className="text-xs text-ink-secondary dark:text-neutral-400">
            Contact our engineering team for technical questions, API inquiries, or general
            feedback.
          </p>
          <a
            href="mailto:support@easyconvert.com"
            className="min-h-[44px] inline-flex items-center gap-1.5 text-xs font-semibold text-brand-700 dark:text-brand-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 rounded"
          >
            support@easyconvert.com
          </a>
        </div>

        <div className="p-5 rounded-lg bg-neutral-scaffold dark:bg-white/5 border border-neutral-border dark:border-dark-border space-y-2">
          <h3 className="font-bold text-brand-950 dark:text-white text-sm">
            Bug Reports &amp; Issues
          </h3>
          <p className="text-xs text-ink-secondary dark:text-neutral-400">
            Found an edge case or rendering discrepancy? Email reproduction steps and a
            non-sensitive sample file.
          </p>
          <a
            href="mailto:support@easyconvert.com?subject=Bug%20Report"
            className="min-h-[44px] inline-flex items-center gap-1.5 text-xs font-semibold text-brand-700 dark:text-brand-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 rounded"
          >
            Report an Issue
          </a>
        </div>
      </div>
    </div>
  );
}
