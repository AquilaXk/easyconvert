import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ComponentType } from 'react';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
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
import HomePage from '../src/components/pages/HomePageView';
import ConverterPageView from '../src/components/pages/ConverterPageView';
import AuthPage from '../src/components/pages/AuthPageView';
import { resolveOAuthErrorKey } from '../src/components/auth/AuthForms';
import ApiDocsPage from '../src/components/pages/ApiDocsPageView';
import { API_DOC_TOPICS, apiDocsHref } from '../src/components/api-docs/topics';
import { writeClipboardText } from '../src/hooks/useCopyFeedback';
import OptionsModal from '../src/components/OptionsModal';
import {
  computeVisibleSections,
  DEFAULT_OPTIONS,
  resolvePasswordMode,
} from '../src/components/workbench/options/options-capabilities';
import UrlImportModal from '../src/components/UrlImportModal';
import ConversionQueue from '../src/components/ConversionQueue';
import { getViewerMaxFileBytes } from '../src/lib/viewer-plan';
import { CreateApiKeyForm } from '../src/components/dashboard/ApiKeyCreateCard';
import { ApiKeysPanel } from '../src/components/dashboard/ApiKeysPanel';
import { DlqPayloadDialog } from '../src/components/dashboard/DlqPayloadDialog';
import { IntegrationGuide } from '../src/components/dashboard/IntegrationGuide';
import { buildKeyCreationRequest } from '../src/components/dashboard/useDashboardController';
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
import { parsedSlug, testTranslator } from './helpers/intl';
import { ANONYMOUS_DAILY_CONVERSIONS } from '../src/lib/plan-limits';

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
    expect(REGISTRY_STATS.formatCount).toBe(308);
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
      render(OptionsModal, { filename: 'scan.png', sourceFormat: 'png', targetFormat: 'pdf', initialOptions: {}, onSave: noop, onClose: noop })
    );
    expect(phrasesMissing(pngToPdfText, ['Orientation', 'Enable OCR text recognition'])).toEqual([]);
    expect(phrasesPresent(pngToPdfText, ['Open Password', 'Page Range'])).toEqual([]);

    const pdfToPngText = visibleText(
      render(OptionsModal, { filename: 'slides.pdf', sourceFormat: 'pdf', targetFormat: 'png', initialOptions: {}, onSave: noop, onClose: noop })
    );
    expect(phrasesMissing(pdfToPngText, ['Page Range', 'Open Password (PDF)'])).toEqual([]);
    expect(phrasesPresent(pdfToPngText, ['Orientation', 'Enable OCR text recognition'])).toEqual([]);

    const jsonToYamlText = visibleText(
      render(OptionsModal, { filename: 'config.json', sourceFormat: 'json', targetFormat: 'yaml', initialOptions: {}, onSave: noop, onClose: noop })
    );
    expect(phrasesPresent(jsonToYamlText, ['Field Delimiter', 'Worksheet Index'])).toEqual([]);

    const pngToMp4Text = visibleText(
      render(OptionsModal, { filename: 'poster.png', sourceFormat: 'png', targetFormat: 'mp4', initialOptions: {}, onSave: noop, onClose: noop })
    );
    expect(phrasesPresent(pngToMp4Text, ['Audio Bitrate', 'Audio Codec'])).toEqual([]);

    const zipToTarText = visibleText(
      render(OptionsModal, { filename: 'bundle.zip', sourceFormat: 'zip', targetFormat: 'tar', initialOptions: {}, onSave: noop, onClose: noop })
    );
    expect(phrasesPresent(zipToTarText, ['Archive Password', 'Compression Level', 'Output Archive Password', 'Open Password'])).toEqual([]);

    expect(Object.keys(DEFAULT_OPTIONS)).toHaveLength(0);
    expect(DEFAULT_OPTIONS.delimiter).toBeUndefined();
    expect(computeVisibleSections('pdf', 'hocr').canConfigureOcr).toBe(true);
    expect(computeVisibleSections('pdf', 'hocr').ocrAlwaysEnabled).toBe(true);
    expect(computeVisibleSections('png', 'alto').canConfigureOcr).toBe(true);
    expect(computeVisibleSections('docx', 'txt').canConfigureLayout).toBe(false);
    expect(computeVisibleSections('docx', 'pdf').canConfigureLayout).toBe(false);
    expect(computeVisibleSections('md', 'pdf').canConfigureLayout).toBe(true);
    expect(computeVisibleSections('png', 'pdf').canConfigureLayout).toBe(true);
    expect(computeVisibleSections('pdf', 'docx').canSelectPages).toBe(false);
    expect(resolvePasswordMode('rar', 'zip')).toBe('archive-reencrypt');
    expect(resolvePasswordMode('pdf', 'zip')).toBe('archive-encrypt');
    expect(resolvePasswordMode('pdf', 'txt')).toBe('pdf-decrypt');
    expect(resolvePasswordMode('zip', 'tar')).toBeNull();

    const csvToTsvText = visibleText(
      render(OptionsModal, { filename: 'rows.csv', sourceFormat: 'csv', targetFormat: 'tsv', initialOptions: {}, onSave: noop, onClose: noop })
    );
    expect(phrasesMissing(csvToTsvText, ['Auto (match format)'])).toEqual([]);

    const pngToZipText = visibleText(
      render(OptionsModal, { filename: 'bundle.png', sourceFormat: 'png', targetFormat: 'zip', initialOptions: {}, onSave: noop, onClose: noop })
    );
    expect(phrasesMissing(pngToZipText, ['Compression Level', 'Output Archive Password (ZIP)'])).toEqual([]);

    const videoModal = render(OptionsModal, { filename: 'clip.mov', sourceFormat: 'mov', targetFormat: 'mp4', initialOptions: {}, onSave: noop, onClose: noop });
    const videoLabels = select(videoModal, 'label').map((l) => visibleText(l));
    expect(videoLabels.filter((text) => text.startsWith('Trim Start'))).toHaveLength(1);
    expect(videoLabels.filter((text) => text.startsWith('Trim End'))).toHaveLength(1);
    expect(phrasesMissing(visibleText(videoModal), ['Video Codec', 'Audio Bitrate'])).toEqual([]);

    const webmModalText = visibleText(
      render(OptionsModal, { filename: 'clip.mp4', sourceFormat: 'mp4', targetFormat: 'webm', initialOptions: {}, onSave: noop, onClose: noop })
    );
    expect(phrasesMissing(webmModalText, ['VP9', 'AV1', 'Opus', 'Vorbis'])).toEqual([]);
    expect(phrasesPresent(webmModalText, ['H.264 (AVC)', 'H.265 (HEVC)', 'AAC'])).toEqual([]);

    const wavModalText = visibleText(
      render(OptionsModal, { filename: 'track.mp3', sourceFormat: 'mp3', targetFormat: 'wav', initialOptions: {}, onSave: noop, onClose: noop })
    );
    expect(phrasesMissing(wavModalText, ['Sample Rate', 'Channels'])).toEqual([]);
    expect(phrasesPresent(wavModalText, ['Audio Bitrate', 'Audio Codec'])).toEqual([]);

    const rarToZipModal = render(OptionsModal, { filename: 'bundle.rar', sourceFormat: 'rar', targetFormat: 'zip', initialOptions: {}, onSave: noop, onClose: noop });
    expect(visibleText(rarToZipModal)).toContain('Archive Password (RAR to ZIP)');
    expect(attrOf(select(rarToZipModal, 'input', 'id', 'opt-doc-password')[0], 'maxlength')).toBe('99');

    const hocrModal = render(OptionsModal, { filename: 'scan.pdf', sourceFormat: 'pdf', targetFormat: 'hocr', initialOptions: {}, onSave: noop, onClose: noop });
    expect(select(hocrModal, 'input', 'id', 'opt-doc-ocr')).toHaveLength(0);
    expect(attrOf(select(hocrModal, 'select', 'id', 'opt-doc-ocr-lang')[0], 'disabled')).toBeNull();

    const maxBytes = getViewerMaxFileBytes();
    const oversizeItem = { id: 'over', file: new File(['x'], 'big.mp4'), name: 'big.mp4', size: maxBytes + 1, sourceFormat: 'mp4', targetFormat: '', status: 'error' as const, progress: 0, options: {} };
    const validItem = { id: 'ok', file: new File(['x'], 'ok.png'), name: 'ok.png', size: 128, sourceFormat: 'png', targetFormat: 'webp', status: 'ready' as const, progress: 0, options: {} };
    const mixedQueue = render(ConversionQueue, { items: [oversizeItem, validItem], onRemoveItem: noop, onClearAll: noop, onUpdateTargetFormat: noop, onUpdateOptions: noop, onConvertAll: noop, onAddMoreFiles: noop, onImportFile: noop, onDownloadAllZip: noop, isConverting: false });
    expect(attrOf(select(mixedQueue, 'button').find((b) => visibleText(b) === 'Convert')!, 'disabled')).toBeNull();
    const onlyOversize = render(ConversionQueue, { items: [oversizeItem], onRemoveItem: noop, onClearAll: noop, onUpdateTargetFormat: noop, onUpdateOptions: noop, onConvertAll: noop, onAddMoreFiles: noop, onImportFile: noop, onDownloadAllZip: noop, isConverting: false });
    expect(attrOf(select(onlyOversize, 'button').find((b) => visibleText(b) === 'Convert')!, 'disabled')).toBe('');

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
      onAddMoreFiles: noop,
      onImportFile: noop,
      onDownloadAllZip: noop,
      isConverting: false,
    });
    const unselectedText = visibleText(unselectedQueue);
    expect(phrasesMissing(unselectedText, ['Select format', 'Please select an output format to continue'])).toEqual([]);
    expect(phrasesPresent(unselectedText, ['ready to convert'])).toEqual([]);

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
      onAddMoreFiles: noop,
      onImportFile: noop,
      onDownloadAllZip: noop,
      isConverting: true,
    });
    const progressBars = select(convertingQueue, 'progress');
    expect(progressBars).toHaveLength(1);
    expect(attrOf(progressBars[0], 'value')).toBe('64');

    const errorQueue = render(ConversionQueue, {
      items: [makeQueueItem({ status: 'error', error: { code: 'server', problem: { detail: 'Corrupt PNG header signature', status: 400 } } })],
      onRemoveItem: noop,
      onClearAll: noop,
      onUpdateTargetFormat: noop,
      onUpdateOptions: noop,
      onConvertAll: noop,
      onAddMoreFiles: noop,
      onImportFile: noop,
      onDownloadAllZip: noop,
      isConverting: false,
    });
    const alerts = allElements(errorQueue).filter((el) => attrOf(el, 'role') === 'alert');
    expect(alerts.map((a) => visibleText(a))).toEqual(['The request was refused. Check what you entered and the settings you chose.']);
    expect(visibleText(errorQueue)).not.toContain('Corrupt PNG header signature');
  });

  it('handles OAuth error allowlists', () => {
    const tOAuth = testTranslator('en', 'auth');
    const oauthMessage = (code: string | null) => {
      const key = resolveOAuthErrorKey(code);
      return key ? tOAuth(`oauthErrors.${key}`) : null;
    };
    expect(oauthMessage(null)).toBeNull();
    expect(oauthMessage('%')).toBe('Authentication failed. Please try signing in again.');
    expect(oauthMessage('100%')).toBe('Authentication failed. Please try signing in again.');
    expect(oauthMessage('Call +1-800-PHISH')).toBe('Authentication failed. Please try signing in again.');
    expect(oauthMessage('account_linking_required')).toMatch(/Sign in with your password first/);
  });

  it('maintains WCAG 2.1 AA landmarks, single h1, non-skipping heading levels, and labeled 16px controls across routes', () => {
    const routes: ReadonlyArray<{ name: string; dom: DomElement }> = [
      { name: '/', dom: render(HomePage, { dailyLimit: ANONYMOUS_DAILY_CONVERSIONS, apiOrigin: 'https://convert.example.test' }) },
      { name: '/pdf-to-docx', dom: render(ConverterPageView, { parsed: parsedSlug('pdf-to-docx'), dailyLimit: ANONYMOUS_DAILY_CONVERSIONS }) },
      { name: '/accessibility', dom: render(ConverterPageView, { parsed: parsedSlug('accessibility'), dailyLimit: ANONYMOUS_DAILY_CONVERSIONS }) },
      { name: '/contact', dom: render(ConverterPageView, { parsed: parsedSlug('contact'), dailyLimit: ANONYMOUS_DAILY_CONVERSIONS }) },
      { name: '/auth', dom: render(AuthPage, {}) },
      ...API_DOC_TOPICS.map((topic) => ({ name: apiDocsHref(topic.slug), dom: render(ApiDocsPage, { topic: topic.slug }) })),
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

  it('enforces roving tablists, persistent status live regions, RBAC warnings, and unmounted empty dialogs', () => {
    const emptyDlq = render(DlqPayloadDialog, {
      entry: null,
      onClose: noop,
      onReplay: noop,
    });
    expect(select(emptyDlq, 'dialog')).toHaveLength(0);

    const emptyScopesForm = render(CreateApiKeyForm, {
      newKeyName: 'Worker Key',
      selectedScopes: [],
      keyExpiry: '30d',
      acceptedTerms: false,
      isGeneratingKey: false,
      onNameChange: noop,
      onToggleScope: noop,
      onExpiryChange: noop,
      onAcceptedTermsChange: noop,
      onSubmit: noop,
      onCancel: noop,
    });
    expect(visibleText(emptyScopesForm)).toContain('Select at least one scope to generate a key.');
    const emptyScopesSubmit = select(emptyScopesForm, 'button', 'type', 'submit');
    expect(emptyScopesSubmit).toHaveLength(1);
    expect(attrOf(emptyScopesSubmit[0], 'disabled')).toBe('');

    const validScopesForm = render(CreateApiKeyForm, {
      newKeyName: 'Worker Key',
      selectedScopes: ['convert:read'],
      keyExpiry: '30d',
      acceptedTerms: false,
      isGeneratingKey: false,
      onNameChange: noop,
      onToggleScope: noop,
      onExpiryChange: noop,
      onAcceptedTermsChange: noop,
      onSubmit: noop,
      onCancel: noop,
    });
    const termsBox = select(validScopesForm, 'input', 'id', 'new-key-accept-terms');
    expect(termsBox).toHaveLength(1);
    expect(attrOf(termsBox[0], 'type')).toBe('checkbox');
    expect(attrOf(termsBox[0], 'required')).toBe('');
    const termsLabel = select(validScopesForm, 'label', 'for', 'new-key-accept-terms');
    expect(visibleText(termsLabel[0])).toContain('I accept the terms of service');
    expect(select(termsLabel[0], 'a').map((link) => attrOf(link, 'href'))).toEqual(['/terms']);
    const validScopesSubmit = select(validScopesForm, 'button', 'type', 'submit');
    expect(validScopesSubmit).toHaveLength(1);
    expect(attrOf(validScopesSubmit[0], 'disabled')).toBeNull();

    expect(buildKeyCreationRequest('Worker Key', [], '30d', 1730000000000, 'Production API Key')).toEqual({
      ok: false,
      error: 'noScopes',
    });
    expect(testTranslator('en', 'dashboard.errors')('noScopes')).toBe(
      'Select at least one permission scope before creating an API key.'
    );
    const validKeyReq = buildKeyCreationRequest(
      'Worker Key',
      ['convert:read'],
      'never',
      1730000000000,
      'Production API Key'
    );
    expect(validKeyReq).toEqual({
      ok: true,
      body: { name: 'Worker Key', scopes: ['convert:read'], expiresAt: undefined },
    });

    const keysPanelDom = render(ApiKeysPanel, {
      state: {
        apiKeys: [
          {
            id: 'k1',
            userId: 'u1',
            name: 'Prod',
            prefix: 'ec_live_ab12...',
            keyHash: 'h',
            createdAt: 1730000000000,
            status: 'active',
            scopes: ['convert:write'],
          },
        ],
        quota: null,
        newKeyName: '',
        generatedSecret: null,
        isGeneratingKey: false,
        showGenerateForm: false,
        copiedKey: false,
        revokingKeyId: null,
        selectedScopes: ['convert:write'],
        keyExpiry: '30d',
        acceptedTerms: false,
      },
      actions: {
        onOpenGenerateForm: noop,
        onCloseGenerateForm: noop,
        onDismissGeneratedSecret: noop,
        onNameChange: noop,
        onToggleScope: noop,
        onExpiryChange: noop,
        onAcceptedTermsChange: noop,
        onGenerateKey: noop,
        onRequestRevoke: noop,
        onConfirmRevoke: noop,
        onCopy: noop,
      },
    });
    const preCodeText = visibleText(select(keysPanelDom, 'pre')[0]);
    expect(preCodeText).toContain('Authorization: Bearer $EASYCONVERT_API_KEY');
    expect(preCodeText).toContain('https://api.easyconvert.com/api/v1/convert');
    expect(preCodeText).not.toContain('ec_live_ab12...');
    expect(preCodeText).not.toContain('easyconvert.app');

    const guideDom = render(IntegrationGuide, { sampleKeyDisplay: '$EASYCONVERT_API_KEY' });
    const guideTablist = allElements(guideDom).filter((el) => attrOf(el, 'role') === 'tablist');
    expect(guideTablist).toHaveLength(1);
    expect(attrOf(guideTablist[0], 'aria-label')).toBe('SDK language');
    const guideTabs = allElements(guideDom).filter((el) => attrOf(el, 'role') === 'tab');
    expect(guideTabs).toHaveLength(3);
    expect(guideTabs.map((t) => attrOf(t, 'tabindex'))).toEqual(['0', '-1', '-1']);
    expect(select(guideDom, 'div', 'id', 'sdk-guide-tabpanel')).toHaveLength(1);
    expect(attrOf(select(guideDom, 'div', 'id', 'sdk-guide-tabpanel')[0], 'role')).toBe('tabpanel');
  });

  it('guards clipboard writes against missing APIs and rejected permissions before reporting success', async () => {
    const prevDesc = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
    try {
      Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: undefined });
      expect(await writeClipboardText('curl -I https://api.easyconvert.com')).toBe(false);

      const rejectingWrite = vi.fn().mockRejectedValueOnce(new Error('NotAllowedError'));
      Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: rejectingWrite } });
      expect(await writeClipboardText('curl -I https://api.easyconvert.com')).toBe(false);

      const resolvingWrite = vi.fn().mockResolvedValueOnce(undefined);
      Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: resolvingWrite } });
      expect(await writeClipboardText('42.5')).toBe(true);
      expect(resolvingWrite).toHaveBeenCalledWith('42.5');
    } finally {
      if (prevDesc) Object.defineProperty(globalThis.navigator, 'clipboard', prevDesc);
      else Reflect.deleteProperty(globalThis.navigator, 'clipboard');
    }
  });
});
