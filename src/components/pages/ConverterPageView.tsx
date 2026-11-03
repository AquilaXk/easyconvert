'use client';

import React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import Header from '@/components/Header';
import { PairHero, QueueHeader } from '@/components/Hero';
import { MAIN_FILE_INPUT_ID } from '@/components/hero/useHeroUpload';
import { usePairTiles } from '@/components/hero/usePairTiles';
import ConversionQueue from '@/components/ConversionQueue';
import Footer from '@/components/Footer';
import { FORMAT_REGISTRY } from '@/lib/registry';
import { isSameFormat, otherFormats } from '@/lib/format-aliases';
import { REGISTRY_STATS } from '@/lib/registry-stats';
import { parseConverterSlug } from '@/lib/slug-parser';
import { useClientQueue } from '@/hooks/useClientQueue';
import { formatCategoryLabel } from '@/components/converter/format-specs';
import { localizeSlugCopy } from '@/components/converter/slug-copy';
import { ConverterBreadcrumb } from '@/components/converter/ConverterBreadcrumb';
import { FormatCards } from '@/components/converter/FormatCards';
import { FormatCrossLinks } from '@/components/converter/FormatCrossLinks';
import { ConverterInfoPage } from '@/components/converter/ConverterInfoPage';

/** A converter or information page; `dailyLimit` is the anonymous daily allowance the server enforces, read on the server. */
export default function ConverterPageView({ slug, dailyLimit }: Readonly<{ slug: string; dailyLimit: number }>) {
  const locale = useLocale();
  const tSlug = useTranslations('slugPages');
  const tDetail = useTranslations('formatDetail');
  const parsed = parseConverterSlug(slug);
  const copy = localizeSlugCopy(tSlug, parsed, locale);
  const totalFormatCount = REGISTRY_STATS.formatCount;

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
    handleConvertAll,
    handleDownloadAllZip,
  } = useClientQueue({ bundlePrefix });
  const tiles = usePairTiles(parsed.sourceFormat, parsed.targetFormat);
  const queueTarget = tiles.chosenTarget ?? queue[0]?.targetFormat;

  if (parsed.isInfoPage) {
    return <ConverterInfoPage parsed={parsed} copy={copy} totalFormatCount={totalFormatCount} dailyLimit={dailyLimit} />;
  }

  const srcKey = parsed.sourceFormat.toLowerCase();
  const tgtKey = parsed.targetFormat.toLowerCase();
  // A format converted to itself or to another name of it (JPEG to JPG) is no pair: the page describes the one format.
  const isPair = Boolean(tgtKey && tgtKey !== 'any' && !isSameFormat(tgtKey, srcKey));
  const isCategorySlug = parsed.copy.kind === 'format' && parsed.copy.name.kind === 'category';

  const sourceFormatRegistry = FORMAT_REGISTRY[srcKey];
  const convertFromTargets = otherFormats(
    srcKey,
    sourceFormatRegistry?.targetFormats || ['pdf', 'docx', 'png', 'jpg', 'txt']
  );

  const targetForReverse = tgtKey !== 'any' ? tgtKey : srcKey;
  const convertToSources = otherFormats(
    targetForReverse,
    Object.entries(FORMAT_REGISTRY)
      .filter(([, def]) => def.targetFormats.includes(targetForReverse))
      .map(([key]) => key)
  );

  const categoryName = sourceFormatRegistry?.category || 'document';
  const categoryLabel = formatCategoryLabel(tDetail, categoryName);

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
        {queue.length > 0 ? (
          <QueueHeader
            onFilesSelected={handleFilesSelected}
            sourceFormat={queue[0].sourceFormat}
            targetFormat={queueTarget}
            pageTitle={copy.title}
            pageDescription={copy.description}
          />
        ) : (
          <PairHero
            onFilesSelected={handleFilesSelected}
            dailyLimit={dailyLimit}
            tiles={tiles}
            title={copy.title}
            description={copy.description}
          />
        )}

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
            onAddMoreFiles={() => {
              const input = document.getElementById(MAIN_FILE_INPUT_ID) as HTMLInputElement | null;
              if (input) input.click();
            }}
            onImportFile={(file) => handleFilesSelected([file], queueTarget)}
            onDownloadAllZip={() => {
              void handleDownloadAllZip();
            }}
            isConverting={isConverting}
            zipError={zipError}
            onDismissZipError={dismissZipError}
          />
        ) : (
          <>
            {!isCategorySlug && <FormatCards srcKey={srcKey} tgtKey={isPair ? tgtKey : null} />}

            <FormatCrossLinks
              sourceFormat={parsed.sourceFormat}
              convertFromTargets={convertFromTargets}
              targetForReverse={targetForReverse}
              convertToSources={convertToSources.slice(0, 30)}
            />
          </>
        )}
      </main>

      <Footer />
    </div>
  );
}
