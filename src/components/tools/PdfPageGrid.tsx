'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { GripVertical, Eye, RotateCw, ArrowLeft, ArrowRight, Check } from 'lucide-react';
import type { WebTool } from '@/lib/tools/tool-names';

export interface PdfPageItem {
  pageNumber: number;
  thumbnailUrl?: string;
}

interface PdfPageGridProps {
  file?: File | Blob;
  tool?: WebTool;
  initialPages?: number;
  selectedPages?: number[];
  pageRotations?: Record<number, number>;
  onOrderChange?: (newOrder: number[]) => void;
  onSelectionChange?: (selectedPages: number[]) => void;
  onRotatePage?: (pageNum: number) => void;
  className?: string;
}

export function formatPageRanges(pages: number[]): string {
  if (pages.length === 0) return '';
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let end = start;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = sorted[i];
      end = start;
    }
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(', ');
}

export function PdfPageGrid({
  file,
  tool,
  initialPages = 1,
  selectedPages,
  pageRotations,
  onOrderChange,
  onSelectionChange,
  onRotatePage,
  className = '',
}: Readonly<PdfPageGridProps>) {
  const t = useTranslations('tools.organizer');
  const [pages, setPages] = useState<PdfPageItem[]>(() =>
    Array.from({ length: initialPages }, (_, i) => ({ pageNumber: i + 1 }))
  );
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [lastClickedPage, setLastClickedPage] = useState<number | null>(null);
  const onOrderChangeRef = useRef(onOrderChange);
  onOrderChangeRef.current = onOrderChange;

  useEffect(() => {
    if (!file) return;
    let active = true;

    async function loadPdf() {
      try {
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
        const isJsdom = typeof navigator !== 'undefined' && navigator.userAgent.includes('jsdom');
        if (isJsdom || typeof IntersectionObserver === 'undefined') return;

        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs').catch(() => null);
        if (!pdfjs) return;
        const g = globalThis as Record<string, unknown>;
        if (!g.pdfjsWorker) {
          g.pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs').catch(() => null);
        }

        const arrayBuffer = await file!.arrayBuffer();
        const loadingTask = pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) });
        const doc = await loadingTask.promise;
        if (!active) return;

        const count = doc.numPages;
        const items: PdfPageItem[] = Array.from({ length: count }, (_, i) => ({ pageNumber: i + 1 }));
        setPages(items);
        onOrderChangeRef.current?.(items.map((it) => it.pageNumber));

        for (let i = 1; i <= Math.min(count, 30); i++) {
          if (!active) break;
          await renderThumbnail(doc, i, (url) => {
            if (active) {
              setPages((curr) => curr.map((p) => (p.pageNumber === i ? { ...p, thumbnailUrl: url } : p)));
            }
          });
        }
      } catch {
        // Fallback to placeholder page list
      }
    }

    void loadPdf();
    return () => {
      active = false;
    };
  }, [file]);

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;
    const next = [...pages];
    const [moved] = next.splice(draggedIndex, 1);
    next.splice(index, 0, moved);
    setDraggedIndex(index);
    setPages(next);
    onOrderChange?.(next.map((p) => p.pageNumber));
  };

  const movePage = (fromIndex: number, delta: -1 | 1) => {
    const toIndex = fromIndex + delta;
    if (toIndex < 0 || toIndex >= pages.length) return;
    const next = [...pages];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setPages(next);
    onOrderChange?.(next.map((p) => p.pageNumber));
  };

  const handleCardClick = (e: React.MouseEvent, pageNum: number) => {
    if (!onSelectionChange) return;
    if (e.shiftKey && lastClickedPage !== null) {
      const min = Math.min(lastClickedPage, pageNum);
      const max = Math.max(lastClickedPage, pageNum);
      const range: number[] = [];
      for (let i = min; i <= max; i++) range.push(i);
      const union = [...new Set([...(selectedPages ?? []), ...range])];
      onSelectionChange(union);
    } else {
      toggleSelection(pageNum, selectedPages, onSelectionChange);
    }
    setLastClickedPage(pageNum);
  };

  const isReorder = tool === 'reorder-pages';
  const isRotate = tool === 'rotate';
  const isSelectable = !isReorder && !isRotate;

  return (
    <div className={`grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 ${className}`}>
      {pages.map((p, idx) => (
        <PageCard
          key={p.pageNumber}
          item={p}
          index={idx}
          total={pages.length}
          isReorder={isReorder}
          isRotate={isRotate}
          isSelectable={isSelectable}
          isSelected={Boolean(selectedPages?.includes(p.pageNumber))}
          rotationAngle={pageRotations?.[p.pageNumber] ?? 0}
          t={t}
          onDragStart={() => isReorder && setDraggedIndex(idx)}
          onDragOver={(e) => isReorder && handleDragOver(e, idx)}
          onDragEnd={() => isReorder && setDraggedIndex(null)}
          onClick={(e) => isSelectable && handleCardClick(e, p.pageNumber)}
          onRotate={() => onRotatePage?.(p.pageNumber)}
          onMove={(delta) => movePage(idx, delta)}
        />
      ))}
    </div>
  );
}

interface PageCardProps {
  item: PdfPageItem;
  index: number;
  total: number;
  isReorder: boolean;
  isRotate: boolean;
  isSelectable: boolean;
  isSelected: boolean;
  rotationAngle: number;
  t: ReturnType<typeof useTranslations<'tools.organizer'>>;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onClick: (e: React.MouseEvent) => void;
  onRotate: () => void;
  onMove: (delta: -1 | 1) => void;
}

function PageCard({
  item, index, total, isReorder, isRotate, isSelectable, isSelected, rotationAngle,
  t, onDragStart, onDragOver, onDragEnd, onClick, onRotate, onMove,
}: Readonly<PageCardProps>) {
  let cursorClass = 'cursor-default';
  if (isReorder) cursorClass = 'cursor-grab active:cursor-grabbing';
  else if (isSelectable) cursorClass = 'cursor-pointer';

  const borderClass = isSelected
    ? 'border-accent ring-1 ring-accent bg-accent-soft/30'
    : 'border-rule bg-canvas hover:border-rule-strong';

  return (
    <div
      draggable={isReorder}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className={`group relative flex flex-col items-center justify-between p-2 rounded-xs border transition-all ${cursorClass} ${borderClass}`}
    >
      {isSelected && (
        <span className="absolute top-3 right-3 z-10 inline-flex items-center justify-center size-5 rounded-xs bg-accent text-on-accent shadow-sm">
          <Check aria-hidden="true" className="size-3.5" />
        </span>
      )}
      {rotationAngle > 0 && (
        <span className="absolute top-3 left-3 z-10 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums rounded-xs bg-accent-soft text-accent-ink border border-accent-edge">
          {rotationAngle}°
        </span>
      )}
      <PageThumbnail pageNumber={item.pageNumber} pageAlt={t('pageAlt', { page: item.pageNumber })} thumbnailUrl={item.thumbnailUrl} rotation={rotationAngle} />
      <div className="mt-1.5 flex items-center justify-between w-full text-xs text-ink-2 px-1">
        <span className="font-medium tabular-nums">{t('pageLabel', { page: item.pageNumber })}</span>
        {isRotate && (
          <button
            type="button"
            aria-label={t('rotate90', { page: item.pageNumber })}
            title={t('rotate90', { page: item.pageNumber })}
            onClick={(e) => { e.stopPropagation(); onRotate(); }}
            className="p-1 hover:text-ink hover:bg-sunken rounded-xs cursor-pointer"
          >
            <RotateCw className="size-3.5 text-ink-3" />
          </button>
        )}
        {isReorder && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={t('moveEarlier', { page: item.pageNumber })}
              disabled={index === 0}
              onClick={(e) => { e.stopPropagation(); onMove(-1); }}
              className="p-0.5 hover:text-ink disabled:opacity-30 cursor-pointer"
            >
              <ArrowLeft className="size-3 text-ink-3" />
            </button>
            <button
              type="button"
              aria-label={t('moveLater', { page: item.pageNumber })}
              disabled={index === total - 1}
              onClick={(e) => { e.stopPropagation(); onMove(1); }}
              className="p-0.5 hover:text-ink disabled:opacity-30 cursor-pointer"
            >
              <ArrowRight className="size-3 text-ink-3" />
            </button>
            <GripVertical className="size-3.5 text-ink-3 opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        )}
      </div>
    </div>
  );
}

function PageThumbnail({
  pageNumber,
  pageAlt,
  thumbnailUrl,
  rotation = 0,
}: Readonly<{ pageNumber: number; pageAlt: string; thumbnailUrl?: string; rotation?: number }>) {
  const rotationStyle = rotation !== 0 ? { transform: `rotate(${rotation}deg)` } : undefined;
  return (
    <div
      style={rotationStyle}
      className="w-full aspect-[3/4] rounded-xs bg-surface flex items-center justify-center overflow-hidden border border-rule/70 transition-transform"
    >
      {thumbnailUrl ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={thumbnailUrl} alt={pageAlt} className="object-contain size-full" />
      ) : (
        <div className="flex flex-col items-center justify-center text-xs text-ink-3">
          <Eye className="size-4 mb-1 opacity-50" />
          <span>{pageNumber}</span>
        </div>
      )}
    </div>
  );
}

function toggleSelection(pageNumber: number, selected?: number[], onChange?: (p: number[]) => void): void {
  if (!onChange) return;
  const isSelected = selected?.includes(pageNumber);
  const next = isSelected ? (selected ?? []).filter((n) => n !== pageNumber) : [...(selected ?? []), pageNumber];
  onChange(next);
}

type PdfJsDocProxy = Awaited<ReturnType<typeof import('pdfjs-dist/legacy/build/pdf.mjs')['getDocument']>['promise']>;

async function renderThumbnail(doc: PdfJsDocProxy, pageNum: number, onRendered: (url: string) => void): Promise<void> {
  try {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 0.3 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      onRendered(canvas.toDataURL('image/jpeg', 0.8));
    }
  } catch {
    // Ignore render failure in non-canvas or unsupported contexts
  }
}

export default PdfPageGrid;
