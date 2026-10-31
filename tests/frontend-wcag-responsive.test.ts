import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ComponentType } from 'react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: () => undefined,
    replace: () => undefined,
    refresh: () => undefined,
    prefetch: () => Promise.resolve(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));

import { CATEGORIES, getAllFormats } from '../src/lib/registry';
import { CATEGORY_ORDER, REGISTRY_STATS } from '../src/lib/registry-stats';
import HomePage from '../src/app/page';
import DynamicConverterPage from '../src/app/[slug]/page';
import AuthPage from '../src/app/auth/page';
import { resolveOAuthErrorMessage } from '../src/components/auth/AuthForms';
import ApiDocsPage from '../src/app/api-docs/page';
import { buildCurlSnippet } from '../src/components/api-docs/curl-builder';
import StatusPage from '../src/app/status/page';
import { DiagnosticResultsCard } from '../src/components/status/StatusDiagnosticsPanels';
import UnitConverterPage from '../src/app/unit-converter/page';
import OptionsModal from '../src/components/OptionsModal';
import UrlImportModal from '../src/components/UrlImportModal';
import ConversionQueue from '../src/components/ConversionQueue';
import FormatSelector from '../src/components/FormatSelector';
import { DlqPayloadDialog } from '../src/components/dashboard/DlqPayloadDialog';
import type { ConversionQueueItem } from '../src/lib/types';
import type { WebhookDlqEntry } from '../src/lib/api-keys/types';
import {
  allElements,
  attrOf,
  phrasesMissing,
  phrasesPresent,
  renderDom,
  select,
  visibleText,
  type DomElement,
} from './helpers/rendered-dom';

const ROOT_DIR = path.resolve(__dirname, '..');

function collectUiFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'api') collectUiFiles(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

function slugParams(slug: string): Promise<{ slug: string }> {
  const value = { slug };
  const settled = Promise.resolve(value) as Promise<{ slug: string }> & {
    status: string;
    value: { slug: string };
  };
  settled.status = 'fulfilled';
  settled.value = value;
  return settled;
}

const noop = () => undefined;
const render = <P extends object>(component: ComponentType<P>, props: P) =>
  renderDom(createElement(component, props));

function headingLevels(root: DomElement): Array<{ level: number; text: string }> {
  return allElements(root)
    .filter((el) => /^h[1-6]$/.test(el.tagName))
    .map((el) => ({
      level: Number(el.tagName.slice(1)),
      text: visibleText(el),
    }));
}

function makeQueueItem(overrides: Partial<ConversionQueueItem> = {}): ConversionQueueItem {
  return {
    id: 'item-1',
    file: new File(['sample'], 'diagram.png', { type: 'image/png' }),
    name: 'diagram.png',
    size: 4096,
    sourceFormat: 'png',
    targetFormat: 'webp',
    status: 'ready',
    progress: 0,
    options: { quality: 85 },
    ...overrides,
  };
}

describe('Frontend Registry Truth, Domain Workbench & WCAG 2.1 AA Verification', () => {
  it('derives REGISTRY_STATS and CATEGORIES directly from FORMAT_REGISTRY with zero stale counts', () => {
    const allFormats = getAllFormats();
    expect(REGISTRY_STATS.formatCount).toBe(allFormats.length);
    expect(REGISTRY_STATS.formatCount).toBe(302);
    expect(REGISTRY_STATS.categoryCount).toBe(12);
    expect(CATEGORIES).toHaveLength(12);
    expect(CATEGORIES.map((c) => c.id)).toEqual([...CATEGORY_ORDER]);

    const summedCategoryFormats = CATEGORIES.reduce((sum, cat) => sum + cat.count, 0);
    expect(summedCategoryFormats).toBe(allFormats.length);

    for (const cat of CATEGORIES) {
      const actualInRegistry = allFormats.filter((f) => f.category === cat.id).length;
      expect(cat.count).toBe(actualInRegistry);
    }

    const expectedPairs = allFormats.reduce((sum, fmt) => sum + fmt.targetFormats.length, 0);
    expect(REGISTRY_STATS.pairCount).toBe(expectedPairs);
  });

  it('eliminates retired files, fake language state, hardcoded 292 strings, and AI-slop tokens across UI modules', () => {
    expect(fs.existsSync(path.join(ROOT_DIR, 'src/components/FormatExplorer.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT_DIR, 'src/components/UrlUploadModal.tsx'))).toBe(false);

    const uiFiles = [
      ...collectUiFiles(path.join(ROOT_DIR, 'src/components')),
      ...collectUiFiles(path.join(ROOT_DIR, 'src/app')),
    ];

    const violations: string[] = [];
    const forbiddenPatterns: ReadonlyArray<{ label: string; pattern: RegExp }> = [
      { label: 'hardcoded 292 format count', pattern: /\b292\b/ },
      { label: 'fake AVAILABLE_LANGUAGES selector', pattern: /AVAILABLE_LANGUAGES/ },
      { label: 'decorative Sparkles icon', pattern: /\bSparkles\b/ },
      { label: 'lavender-glow class', pattern: /lavender-glow/ },
      { label: 'fake Upgrade to Pro CTA', pattern: /Upgrade to Pro/i },
      { label: 'fake Contact Sales CTA', pattern: /Contact Sales/i },
      { label: 'em-dash character', pattern: /\u2014/ },
    ];

    for (const file of uiFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const rel = path.relative(ROOT_DIR, file);
      for (const { label, pattern } of forbiddenPatterns) {
        if (pattern.test(content)) {
          violations.push(`${rel}: ${label}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('scopes OptionsModal sections strictly to engine capabilities and uses native dialog + 16px labeled controls', () => {
    const imageModal = render(OptionsModal, {
      filename: 'photo.png',
      sourceFormat: 'png',
      targetFormat: 'webp',
      initialOptions: { quality: 85, fit: 'contain' },
      onSave: noop,
      onClose: noop,
    });

    const dialogs = select(imageModal, 'dialog');
    expect(dialogs).toHaveLength(1);
    expect(attrOf(dialogs[0], 'aria-labelledby')).toBe('options-modal-title');

    const imageText = visibleText(imageModal);
    expect(
      phrasesMissing(imageText, [
        'Compression Quality',
        'Width (px)',
        'Height (px)',
        'Strip EXIF, GPS, and camera metadata',
      ])
    ).toEqual([]);
    expect(phrasesPresent(imageText, ['Page Range', 'Open Password', 'Video Codec', 'Audio Bitrate'])).toEqual([]);

    const pngToPdfText = visibleText(
      render(OptionsModal, {
        filename: 'scan.png',
        sourceFormat: 'png',
        targetFormat: 'pdf',
        initialOptions: {},
        onSave: noop,
        onClose: noop,
      })
    );
    expect(phrasesPresent(pngToPdfText, ['Open Password', 'Page Range', 'Orientation'])).toEqual([]);

    const pdfToPngText = visibleText(
      render(OptionsModal, {
        filename: 'slides.pdf',
        sourceFormat: 'pdf',
        targetFormat: 'png',
        initialOptions: {},
        onSave: noop,
        onClose: noop,
      })
    );
    expect(phrasesMissing(pdfToPngText, ['Page Range', 'Open Password (PDF)'])).toEqual([]);
    expect(phrasesPresent(pdfToPngText, ['Orientation', 'Enable OCR text recognition'])).toEqual([]);

    const jsonToYamlText = visibleText(
      render(OptionsModal, {
        filename: 'config.json',
        sourceFormat: 'json',
        targetFormat: 'yaml',
        initialOptions: {},
        onSave: noop,
        onClose: noop,
      })
    );
    expect(phrasesPresent(jsonToYamlText, ['Field Delimiter', 'Worksheet Index'])).toEqual([]);

    const pngToMp4Text = visibleText(
      render(OptionsModal, {
        filename: 'poster.png',
        sourceFormat: 'png',
        targetFormat: 'mp4',
        initialOptions: {},
        onSave: noop,
        onClose: noop,
      })
    );
    expect(phrasesPresent(pngToMp4Text, ['Audio Bitrate', 'Audio Codec'])).toEqual([]);

    const zipToTarText = visibleText(
      render(OptionsModal, {
        filename: 'bundle.zip',
        sourceFormat: 'zip',
        targetFormat: 'tar',
        initialOptions: {},
        onSave: noop,
        onClose: noop,
      })
    );
    expect(phrasesPresent(zipToTarText, ['Compression Level', 'Output Archive Password', 'Open Password'])).toEqual([]);

    const pngToZipText = visibleText(
      render(OptionsModal, {
        filename: 'bundle.png',
        sourceFormat: 'png',
        targetFormat: 'zip',
        initialOptions: {},
        onSave: noop,
        onClose: noop,
      })
    );
    expect(phrasesMissing(pngToZipText, ['Compression Level', 'Output Archive Password (ZIP)'])).toEqual([]);

    const videoModal = render(OptionsModal, {
      filename: 'clip.mov',
      sourceFormat: 'mov',
      targetFormat: 'mp4',
      initialOptions: {},
      onSave: noop,
      onClose: noop,
    });
    const videoLabels = select(videoModal, 'label').map((l) => visibleText(l));
    expect(videoLabels.filter((text) => text.startsWith('Trim Start'))).toHaveLength(1);
    expect(videoLabels.filter((text) => text.startsWith('Trim End'))).toHaveLength(1);
    expect(phrasesMissing(visibleText(videoModal), ['Video Codec', 'Audio Bitrate'])).toEqual([]);

    const labelTargets = new Set(
      select(videoModal, 'label')
        .map((l) => attrOf(l, 'for'))
        .filter((v): v is string => Boolean(v))
    );
    const textAndSelectControls = allElements(videoModal).filter(
      (el) =>
        el.tagName === 'select' ||
        (el.tagName === 'input' && !['checkbox', 'range', 'hidden'].includes(attrOf(el, 'type') ?? 'text'))
    );
    expect(textAndSelectControls.length).toBeGreaterThanOrEqual(4);
    for (const ctrl of textAndSelectControls) {
      const id = attrOf(ctrl, 'id');
      expect(id).not.toBeNull();
      expect(labelTargets.has(id as string)).toBe(true);
      expect(attrOf(ctrl, 'class') ?? '').toMatch(/\btext-base\b/);
    }
  });

  it('renders UrlImportModal and DlqPayloadDialog with native HTML dialog elements and typed payloads', () => {
    const urlModal = render(UrlImportModal, {
      isOpen: true,
      onClose: noop,
      onAddFile: noop,
    });
    const urlDialogs = select(urlModal, 'dialog');
    expect(urlDialogs).toHaveLength(1);
    expect(attrOf(urlDialogs[0], 'aria-labelledby')).toBe('url-import-heading');

    const urlInput = select(urlModal, 'input', 'id', 'url-input');
    expect(urlInput).toHaveLength(1);
    expect(attrOf(urlInput[0], 'class') ?? '').toMatch(/\btext-base\b/);
    expect(select(urlModal, 'label', 'for', 'url-input')).toHaveLength(1);

    const sampleEntry: WebhookDlqEntry = {
      id: 'dlq_01',
      originalDeliveryId: 'deliv_01',
      targetUrl: 'https://hooks.example.com/events',
      event: 'job.completed',
      payload: { jobId: 'job_123', status: 'completed' },
      secret: 'whsec_redacted',
      failedAt: 1730332800000,
      finalStatusCode: 502,
      errorMessage: 'Upstream gateway timeout',
      retryCount: 3,
      status: 'failed',
    };
    const dlqModal = render(DlqPayloadDialog, {
      entry: sampleEntry,
      onClose: noop,
      onReplay: noop,
      onCopy: noop,
    });
    const dlqDialogs = select(dlqModal, 'dialog');
    expect(dlqDialogs).toHaveLength(1);
    expect(attrOf(dlqDialogs[0], 'aria-labelledby')).toBe('dlq-payload-dialog-title');
    expect(phrasesMissing(visibleText(dlqModal), ['Inspect Webhook Payload', 'Upstream gateway timeout', 'Replay Now'])).toEqual([]);
  });

  it('distinguishes unselected, ready, converting, and error states in ConversionQueue with semantic progress and output elements', () => {
    const unselectedQueue = render(ConversionQueue, {
      items: [makeQueueItem({ targetFormat: '' })],
      onRemoveItem: noop,
      onClearAll: noop,
      onUpdateTargetFormat: noop,
      onUpdateOptions: noop,
      onConvertAll: noop,
      onConvertSingle: noop,
      onAddMoreFiles: noop,
      onDownloadAllZip: noop,
      isConverting: false,
    });
    const unselectedText = visibleText(unselectedQueue);
    expect(phrasesMissing(unselectedText, ['Select format', 'Please select an output format to continue'])).toEqual([]);
    expect(phrasesPresent(unselectedText, ['Ready to convert'])).toEqual([]);

    const optionsBtn = select(unselectedQueue, 'button', 'aria-label', 'Conversion options for diagram.png');
    expect(optionsBtn).toHaveLength(1);
    expect(attrOf(optionsBtn[0], 'disabled')).toBe('');

    const convertBtn = select(unselectedQueue, 'button').find((b) => visibleText(b) === 'Convert');
    expect(convertBtn).toBeDefined();
    expect(attrOf(convertBtn as DomElement, 'disabled')).toBe('');

    const statusOutputs = select(unselectedQueue, 'output');
    expect(statusOutputs).toHaveLength(1);
    expect(attrOf(statusOutputs[0], 'aria-live')).toBe('polite');

    const convertingQueue = render(ConversionQueue, {
      items: [makeQueueItem({ status: 'converting', progress: 64 })],
      onRemoveItem: noop,
      onClearAll: noop,
      onUpdateTargetFormat: noop,
      onUpdateOptions: noop,
      onConvertAll: noop,
      onConvertSingle: noop,
      onAddMoreFiles: noop,
      onDownloadAllZip: noop,
      isConverting: true,
    });
    const progressBars = select(convertingQueue, 'progress');
    expect(progressBars).toHaveLength(1);
    expect(attrOf(progressBars[0], 'value')).toBe('64');

    const errorQueue = render(ConversionQueue, {
      items: [makeQueueItem({ status: 'error', error: 'Corrupt PNG header signature' })],
      onRemoveItem: noop,
      onClearAll: noop,
      onUpdateTargetFormat: noop,
      onUpdateOptions: noop,
      onConvertAll: noop,
      onConvertSingle: noop,
      onAddMoreFiles: noop,
      onDownloadAllZip: noop,
      isConverting: false,
    });
    const alerts = allElements(errorQueue).filter((el) => attrOf(el, 'role') === 'alert');
    expect(alerts.map((a) => visibleText(a))).toEqual(['Corrupt PNG header signature']);
  });

  it('handles FormatSelector empty capability arrays, OAuth error allowlists, unsupported diagnostics, and OpenAPI cURL synthesis', () => {
    const imagePicker = render(FormatSelector, {
      sourceFormat: 'png',
      onSelect: noop,
      onClose: noop,
    });
    expect(phrasesMissing(visibleText(imagePicker), ['WEBP', 'JPG', 'AVIF'])).toEqual([]);

    const emptyPicker = render(FormatSelector, {
      availableFormats: [],
      sourceFormat: 'xyz',
      onSelect: noop,
      onClose: noop,
    });
    expect(visibleText(emptyPicker)).toMatch(/No supported output formats for this file/);
    expect(phrasesPresent(visibleText(emptyPicker), ['WEBP', 'DOCX', 'MP4'])).toEqual([]);

    expect(resolveOAuthErrorMessage(null)).toBeNull();
    expect(resolveOAuthErrorMessage('%')).toBe('Authentication failed. Please try signing in again.');
    expect(resolveOAuthErrorMessage('100%')).toBe('Authentication failed. Please try signing in again.');
    expect(resolveOAuthErrorMessage('Call +1-800-PHISH')).toBe('Authentication failed. Please try signing in again.');
    expect(resolveOAuthErrorMessage('account_linking_required')).toMatch(/Sign in with your password first/);

    const diagDom = render(DiagnosticResultsCard, {
      results: [
        { id: 'wasm', name: 'WebAssembly SIMD', details: '128-bit lanes', latencyMs: 1, supported: true },
        { id: 'opfs', name: 'Origin Private FS', details: 'Blob memory streaming active', latencyMs: 1, supported: false },
      ],
    });
    expect(phrasesMissing(visibleText(diagDom), ['1/2 Active', 'Unavailable'])).toEqual([]);

    const jsonPostCurl = buildCurlSnippet(
      {
        key: 'post:/api/v1/jobs',
        method: 'post',
        path: '/api/v1/jobs',
        operation: {
          requestBody: {
            content: {
              'application/json': {
                schema: { properties: { uploadId: { type: 'string' }, targetFormat: { type: 'string' } }, required: ['uploadId', 'targetFormat'] },
              },
            },
          },
        },
      },
      '',
      'https://api.easyconvert.com'
    );
    expect(jsonPostCurl).toContain('-H "Content-Type: application/json"');
    expect(jsonPostCurl).not.toContain('-F "file=@sample.docx"');

    const publicPutCurl = buildCurlSnippet(
      {
        key: 'put:/api/v1/uploads/direct/part',
        method: 'put',
        path: '/api/v1/uploads/direct/part',
        operation: {
          security: [],
          requestBody: { content: { 'application/octet-stream': {} } },
        },
      },
      ''
    );
    expect(publicPutCurl).toContain('--upload-file ./part.bin');
    expect(publicPutCurl).not.toContain('Authorization: Bearer');
  });

  it('maintains WCAG 2.1 AA landmarks, single h1, non-skipping heading levels, and labeled 16px controls across routes', () => {
    const routes: ReadonlyArray<{ name: string; dom: DomElement }> = [
      { name: '/', dom: render(HomePage, {}) },
      { name: '/pdf-to-docx', dom: render(DynamicConverterPage, { params: slugParams('pdf-to-docx') }) },
      { name: '/accessibility', dom: render(DynamicConverterPage, { params: slugParams('accessibility') }) },
      { name: '/contact', dom: render(DynamicConverterPage, { params: slugParams('contact') }) },
      { name: '/auth', dom: render(AuthPage, {}) },
      { name: '/api-docs', dom: render(ApiDocsPage, {}) },
      { name: '/status', dom: render(StatusPage, {}) },
      { name: '/unit-converter', dom: render(UnitConverterPage, {}) },
    ];

    for (const route of routes) {
      expect(select(route.dom, 'header'), `${route.name} must render <header>`).toHaveLength(1);
      expect(select(route.dom, 'main', 'id', 'main-content'), `${route.name} must render <main id="main-content">`).toHaveLength(1);
      expect(select(route.dom, 'footer'), `${route.name} must render <footer>`).toHaveLength(1);

      const levels = headingLevels(route.dom);
      const h1s = levels.filter((h) => h.level === 1);
      expect(h1s, `${route.name} must have a single <h1>`).toHaveLength(1);

      const skippedTransitions: string[] = [];
      for (let i = 1; i < levels.length; i++) {
        if (levels[i].level - levels[i - 1].level > 1) {
          skippedTransitions.push(
            `${route.name}: h${levels[i - 1].level}("${levels[i - 1].text}") -> h${levels[i].level}("${levels[i].text}")`
          );
        }
      }
      expect(skippedTransitions).toEqual([]);

      const labelIds = new Set(
        select(route.dom, 'label')
          .map((l) => attrOf(l, 'for'))
          .filter((v): v is string => Boolean(v))
      );

      const visibleFormControls = allElements(route.dom).filter((el) => {
        if (el.tagName === 'select' || el.tagName === 'textarea') return true;
        if (el.tagName !== 'input') return false;
        const type = attrOf(el, 'type') ?? 'text';
        return !['file', 'hidden', 'checkbox', 'radio', 'range'].includes(type);
      });

      for (const ctrl of visibleFormControls) {
        const id = attrOf(ctrl, 'id');
        const ariaLabel = attrOf(ctrl, 'aria-label');
        const hasAccessibleLabel = Boolean(ariaLabel) || Boolean(id && labelIds.has(id));
        expect(hasAccessibleLabel, `${route.name} control id=${id} must have <label htmlFor> or aria-label`).toBe(true);

        const cls = attrOf(ctrl, 'class') ?? '';
        expect(
          /\btext-(?:base|lg|xl|2xl|3xl)\b/.test(cls),
          `${route.name} control id=${id} must be >= 16px (got "${cls}")`
        ).toBe(true);
      }
    }

    const accessibilityRoute = routes.find((r) => r.name === '/accessibility')!;
    expect(
      phrasesMissing(visibleText(accessibilityRoute.dom), [
        'Accessibility Statement',
        'WCAG',
        'Keyboard Navigation',
        'Screen Reader Landmarks',
        'Visual Contrast, Motion & Zoom',
      ])
    ).toEqual([]);
  });
});
