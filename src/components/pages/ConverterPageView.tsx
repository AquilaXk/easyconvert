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
import { otherFormats } from '@/lib/format-aliases';
import { REGISTRY_STATS } from '@/lib/registry-stats';
import { offersConversion, type ParsedSlug } from '@/lib/slug-parser';
import type { HeroOperation } from '@/components/hero/useHeroUpload';
import { useClientQueue } from '@/hooks/useClientQueue';
import { localizeSlugCopy } from '@/components/converter/slug-copy';
import { FormatCards } from '@/components/converter/FormatCards';
import { CategoryConverters, FormatCrossLinks } from '@/components/converter/FormatCrossLinks';
import { ConverterInfoPage } from '@/components/converter/ConverterInfoPage';

/** The operation a page does instead of converting, whose upload card is worded for it. */
function operationOf(kind: ParsedSlug['copy']['kind']): HeroOperation | undefined {
  return kind === 'merge' || kind === 'compress' || kind === 'ocr' ? kind : undefined;
}

/** A converter or information page, as the server's page parsed its slug; `dailyLimit` is the anonymous daily allowance the server enforces, read on the server. */
export default function ConverterPageView({ parsed, dailyLimit }: Readonly<{ parsed: ParsedSlug; dailyLimit: number }>) {
  const locale = useLocale();
  const tSlug = useTranslations('slugPages');
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
  const isPair = parsed.copy.kind !== 'format' && tgtKey !== 'any' && tgtKey !== srcKey;
  const isCategorySlug = parsed.copy.kind === 'format' && parsed.copy.name.kind === 'category';

  const sourceFormatRegistry = FORMAT_REGISTRY[srcKey];
  const convertFromTargets = otherFormats(sourceFormatRegistry.targetFormats, [srcKey]);

  const targetForReverse = tgtKey !== 'any' ? tgtKey : srcKey;
  const convertToSources = otherFormats(
    Object.keys(FORMAT_REGISTRY).filter((key) => offersConversion(key, targetForReverse)),
    [targetForReverse]
  );

  return (
    <div className="flex flex-col min-h-screen">
      <Header />

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
            operation={operationOf(parsed.copy.kind)}
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
            {!isCategorySlug && <FormatCards ids={isPair ? [srcKey, tgtKey] : [srcKey]} />}

            {parsed.copy.kind === 'format' && parsed.copy.name.kind === 'category' && (
              <CategoryConverters category={parsed.copy.name.id} />
            )}
            {parsed.copy.kind === 'format' && parsed.copy.name.kind !== 'category' && (
              <FormatCrossLinks format={parsed.sourceFormat} targets={convertFromTargets} sources={convertToSources} />
            )}
          </>
        )}
      </main>

      <Footer />
    </div>
  );
}
