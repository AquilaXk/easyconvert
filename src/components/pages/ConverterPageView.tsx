'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import Header from '@/components/Header';
import Hero from '@/components/Hero';
import ConversionQueue from '@/components/ConversionQueue';
import AdBanner from '@/components/AdBanner';
import FaqSection from '@/components/FaqSection';
import Footer from '@/components/Footer';
import { FORMAT_REGISTRY } from '@/lib/registry';
import { REGISTRY_STATS } from '@/lib/registry-stats';
import { parseConverterSlug } from '@/lib/slug-parser';
import { useClientQueue } from '@/hooks/useClientQueue';
import { formatCategoryLabel, useFormatDetail } from '@/components/converter/format-specs';
import { buildContextualFaqs } from '@/components/converter/FormatFaqAndSteps';
import { localizeSlugCopy } from '@/components/converter/slug-copy';
import {
  ConverterBreadcrumb,
  ConverterGuaranteeBar,
  ConverterWorkflowSteps,
  FormatSpecDeck,
} from '@/components/converter/FormatSpecDeck';
import { FormatCrossLinks } from '@/components/converter/FormatCrossLinks';
import { ConverterInfoPage } from '@/components/converter/ConverterInfoPage';

/** A converter or information page; `dailyLimit` is the anonymous daily allowance the server enforces, read on the server. */
export default function ConverterPageView({ slug, dailyLimit }: Readonly<{ slug: string; dailyLimit: number }>) {
  const t = useTranslations('converterPage');
  const tSlug = useTranslations('slugPages');
  const tDetail = useTranslations('formatDetail');
  const getFormatDetail = useFormatDetail();
  const parsed = parseConverterSlug(slug);
  const copy = localizeSlugCopy(tSlug, parsed.copy);
  const totalFormatCount = REGISTRY_STATS.formatCount;

  const defaultTarget =
    parsed.targetFormat && parsed.targetFormat.toLowerCase() !== 'any'
      ? parsed.targetFormat
      : undefined;
  const bundlePrefix = `easyconvert_${parsed.sourceFormat}_to_${parsed.targetFormat || 'files'}`;

  const {
    queue,
    isConverting,
    zipError,
    clearZipError: dismissZipError,
    handleFilesSelected,
    handleRemoveItem,
    handleClearAll,
    handleUpdateTargetFormat,
    handleUpdateAllTargets,
    handleUpdateOptions,
    convertSingleItem,
    handleConvertAll,
    handleDownloadAllZip,
  } = useClientQueue({
    defaultTarget,
    bundlePrefix,
  });

  if (parsed.isInfoPage) {
    return <ConverterInfoPage parsed={parsed} copy={copy} totalFormatCount={totalFormatCount} dailyLimit={dailyLimit} />;
  }

  const srcKey = parsed.sourceFormat.toLowerCase();
  const tgtKey = parsed.targetFormat.toLowerCase();
  const isPair = Boolean(tgtKey && tgtKey !== 'any' && tgtKey !== srcKey);

  const srcMeta = getFormatDetail(srcKey);
  const tgtMeta = isPair ? getFormatDetail(tgtKey) : null;

  const sourceFormatRegistry = FORMAT_REGISTRY[srcKey];
  const convertFromTargets = sourceFormatRegistry?.targetFormats || [
    'pdf',
    'docx',
    'png',
    'jpg',
    'txt',
  ];

  const targetForReverse = tgtKey !== 'any' ? tgtKey : srcKey;
  const convertToSources = Object.entries(FORMAT_REGISTRY)
    .filter(([key, def]) => def.targetFormats.includes(targetForReverse) && key !== targetForReverse)
    .map(([key]) => key);

  const categoryName = sourceFormatRegistry?.category || 'document';
  const categoryLabel = formatCategoryLabel(tDetail, categoryName);
  const normalizedSlug = slug.toLowerCase().trim();
  const isCategorySlug =
    normalizedSlug === `${categoryName}-converter` ||
    normalizedSlug === `${categoryName}s-converter` ||
    (srcKey === categoryName.toLowerCase() && normalizedSlug.includes('-converter'));

  const contextualFaqs = buildContextualFaqs(t, srcMeta, tgtMeta, isPair, totalFormatCount);
  const srcUpper = srcMeta.extension.toUpperCase();
  const tgtUpper = tgtMeta?.extension.toUpperCase() ?? '';
  const faqTitle = isPair
    ? t('faq.pairTitle', { src: srcUpper, tgt: tgtUpper })
    : t('faq.singleTitle', { src: srcUpper });

  return (
    <div className="flex flex-col min-h-screen">
      <Header />

      <ConverterBreadcrumb
        categoryName={categoryName}
        categoryLabel={categoryLabel}
        srcKey={srcKey}
        tgtKey={tgtKey}
        isCategorySlug={isCategorySlug}
        isPair={isPair}
      />

      <main id="main-content" className="flex-1">
        <Hero
          onFilesSelected={handleFilesSelected}
          hasActiveQueue={queue.length > 0}
          dailyLimit={dailyLimit}
          activeSourceFormat={parsed.sourceFormat}
          activeTargetFormat={parsed.targetFormat}
          pair={{ title: copy.title, description: copy.description }}
        />

        {queue.length > 0 ? (
          <ConversionQueue
            items={queue}
            onRemoveItem={handleRemoveItem}
            onClearAll={handleClearAll}
            onUpdateTargetFormat={handleUpdateTargetFormat}
            onUpdateAllTargets={handleUpdateAllTargets}
            onUpdateOptions={handleUpdateOptions}
            onConvertAll={() => {
              void handleConvertAll();
            }}
            onConvertSingle={(id) => {
              const target = queue.find((item) => item.id === id);
              if (target) {
                void convertSingleItem(target);
              }
            }}
            onAddMoreFiles={() => {
              const input = document.getElementById('main-file-input') as HTMLInputElement | null;
              if (input) input.click();
            }}
            onImportFile={(file) => handleFilesSelected([file])}
            onDownloadAllZip={() => {
              void handleDownloadAllZip();
            }}
            isConverting={isConverting}
            zipError={zipError}
            onDismissZipError={dismissZipError}
          />
        ) : (
          <>
            <div className="w-full min-h-[50px] sm:min-h-[64px] flex items-center justify-center my-2">
              <AdBanner slot="top-leaderboard" className="py-0" />
            </div>

            <ConverterGuaranteeBar dailyLimit={dailyLimit} />

            <ConverterWorkflowSteps
              srcMeta={srcMeta}
              tgtMeta={tgtMeta}
              isPair={isPair}
              totalFormatCount={totalFormatCount}
            />

            <FormatSpecDeck srcMeta={srcMeta} tgtMeta={tgtMeta} isPair={isPair} />

            <AdBanner slot="mid-content" />

            <FormatCrossLinks
              sourceFormat={parsed.sourceFormat}
              convertFromTargets={convertFromTargets}
              targetForReverse={targetForReverse}
              convertToSources={convertToSources.slice(0, 30)}
            />

            <FaqSection
              dailyLimit={dailyLimit}
              customFaqs={contextualFaqs}
              title={faqTitle}
              subtitle={t('faq.subtitle', { src: srcUpper })}
            />
          </>
        )}
      </main>

      <Footer />
    </div>
  );
}
