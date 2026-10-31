'use client';

import React, { useMemo, useState } from 'react';
import {
  UNIT_CATEGORIES,
  convertValue,
  resolveStartingCategory,
  type UnitCategory,
  type UnitDefinition,
} from '@/lib/unit-catalog';
import {
  CategorySelectorBar,
  UnitWorkbenchCard,
} from '@/components/converter/UnitWorkbenchCard';
import {
  CategoryBreakdownSection,
  PopularConversionsSection,
  QuickReferenceSection,
} from '@/components/converter/UnitConverterPanels';

export { UNIT_CATEGORIES, convertValue };
export type { UnitCategory, UnitDefinition };

interface UnitConverterProps {
  initialCategory?: string;
  initialSrc?: string;
  initialTgt?: string;
}

export default function UnitConverter({
  initialCategory = 'weight',
  initialSrc,
  initialTgt,
}: Readonly<UnitConverterProps>) {
  const resolvedCategory = useMemo(
    () => resolveStartingCategory(initialCategory, initialSrc, initialTgt),
    [initialCategory, initialSrc, initialTgt]
  );

  const [activeCategoryKey, setActiveCategoryKey] = useState<string>(resolvedCategory);
  const currentCategory = UNIT_CATEGORIES[activeCategoryKey] || UNIT_CATEGORIES.weight;
  const [inputStr, setInputStr] = useState<string>('1');

  const inputVal = useMemo(() => {
    if (inputStr === '' || inputStr === '-' || inputStr === '.') return 0;
    const num = Number.parseFloat(inputStr);
    return Number.isNaN(num) ? 0 : num;
  }, [inputStr]);

  const [fromUnitKey, setFromUnitKey] = useState<string>(
    initialSrc && currentCategory.units[initialSrc.toLowerCase()]
      ? initialSrc.toLowerCase()
      : currentCategory.defaultFrom
  );
  const [toUnitKey, setToUnitKey] = useState<string>(
    initialTgt && currentCategory.units[initialTgt.toLowerCase()]
      ? initialTgt.toLowerCase()
      : currentCategory.defaultTo
  );
  const [precision, setPrecision] = useState<number>(6);
  const [isCopied, setIsCopied] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleSelectCategory = (catKey: string) => {
    setActiveCategoryKey(catKey);
    const cat = UNIT_CATEGORIES[catKey];
    if (cat) {
      setFromUnitKey(cat.defaultFrom);
      setToUnitKey(cat.defaultTo);
    }
  };

  const fromDef = currentCategory.units[fromUnitKey] || Object.values(currentCategory.units)[0];
  const toDef = currentCategory.units[toUnitKey] || Object.values(currentCategory.units)[1];

  const calculatedResult = useMemo(
    () => convertValue(inputVal, fromDef, toDef),
    [inputVal, fromDef, toDef]
  );

  const formattedResult = useMemo(() => {
    if (!Number.isFinite(calculatedResult)) return '0';
    return Number.parseFloat(calculatedResult.toFixed(precision)).toLocaleString(undefined, {
      maximumFractionDigits: precision,
    });
  }, [calculatedResult, precision]);

  const rawCopyValue = useMemo(() => {
    if (!Number.isFinite(calculatedResult)) return '0';
    return Number.parseFloat(calculatedResult.toFixed(precision)).toString();
  }, [calculatedResult, precision]);

  const handleSwap = () => {
    setFromUnitKey(toUnitKey);
    setToUnitKey(fromUnitKey);
    if (Number.isFinite(calculatedResult) && calculatedResult !== 0) {
      setInputStr(String(Number.parseFloat(calculatedResult.toFixed(precision))));
    }
  };

  const handleCopy = (textToCopy: string, key?: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(textToCopy);
      if (key) {
        setCopiedKey(key);
        setTimeout(() => setCopiedKey(null), 1500);
      } else {
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 1500);
      }
    }
  };

  const allCategoryConversions = useMemo(
    () =>
      Object.entries(currentCategory.units).map(([key, def]) => ({
        key,
        name: def.name,
        symbol: def.symbol,
        value: convertValue(inputVal, fromDef, def),
      })),
    [inputVal, fromDef, currentCategory]
  );

  const formulaText = useMemo(() => {
    if (currentCategory.formulaDescription) {
      return currentCategory.formulaDescription(fromUnitKey, toUnitKey, inputVal, calculatedResult);
    }
    const unitRatio = convertValue(1, fromDef, toDef);
    return `1 ${fromDef.symbol} = ${unitRatio.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${toDef.symbol}`;
  }, [currentCategory, fromDef, toDef, fromUnitKey, toUnitKey, inputVal, calculatedResult]);

  return (
    <div className="w-full space-y-8">
      <CategorySelectorBar
        activeCategoryKey={activeCategoryKey}
        onSelectCategory={handleSelectCategory}
      />

      <UnitWorkbenchCard
        props={{
          currentCategory,
          fromDef,
          toDef,
          fromUnitKey,
          toUnitKey,
          inputStr,
          formattedResult,
          rawCopyValue,
          precision,
          formulaText,
          isCopied,
          onChangeInput: setInputStr,
          onChangeFromUnit: setFromUnitKey,
          onChangeToUnit: setToUnitKey,
          onChangePrecision: setPrecision,
          onSwap: handleSwap,
          onCopyResult: (val) => handleCopy(val),
        }}
      />

      <CategoryBreakdownSection
        inputVal={inputVal}
        fromName={fromDef.name}
        categoryName={currentCategory.name}
        rows={allCategoryConversions}
        fromUnitKey={fromUnitKey}
        toUnitKey={toUnitKey}
        precision={precision}
        copiedKey={copiedKey}
        onCopyRow={handleCopy}
      />

      <QuickReferenceSection fromDef={fromDef} toDef={toDef} precision={precision} />

      <PopularConversionsSection
        onSelectPreset={(category, from, to) => {
          setActiveCategoryKey(category);
          setFromUnitKey(from);
          setToUnitKey(to);
        }}
      />
    </div>
  );
}
