'use client';

import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

/** The pages that do something other than convert a file, whose upload card says so. */
export type HeroOperation = 'merge' | 'compress' | 'ocr';

/** The id of the page's file input, which the file bar's "add files" opens. */
export const MAIN_FILE_INPUT_ID = 'main-file-input';

function isTextField(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable));
}

/**
 * The ways files reach the page from a hero: the hidden file input, the drop zone, a link import and a paste outside a text
 * field. Each hands its files to `onFilesSelected` with `target`, the target the hero names at that moment. An
 * `operation` page words the file input and the upload card for what it does with the files.
 */
export function useHeroUpload(
  onFilesSelected: (files: File[], target?: string) => void,
  target: string | undefined,
  operation?: HeroOperation
) {
  const t = useTranslations('hero');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const addFiles = (files: File[]) => onFilesSelected(files, target);
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const pasted = event.clipboardData?.files;
      if (isTextField(event.target) || !pasted || pasted.length === 0) return;
      event.preventDefault();
      addFilesRef.current(Array.from(pasted));
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, []);

  const fileInput = {
    id: MAIN_FILE_INPUT_ID,
    ref: fileInputRef,
    type: 'file',
    multiple: true,
    className: 'sr-only',
    'aria-label': operation ? t(`operations.${operation}.fileInputLabel`) : t('fileInputLabel'),
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      const { files } = event.target;
      if (!files || files.length === 0) return;
      addFiles(Array.from(files));
      event.target.value = '';
    },
  } as const;

  const dropzone = {
    operation,
    isDragOver,
    onDragOver: (event: React.DragEvent) => {
      event.preventDefault();
      setIsDragOver(true);
    },
    onDragLeave: (event: React.DragEvent) => {
      event.preventDefault();
      setIsDragOver(false);
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      setIsDragOver(false);
      if (event.dataTransfer.files.length > 0) addFiles(Array.from(event.dataTransfer.files));
    },
    onOpenFileDialog: () => fileInputRef.current?.click(),
    onImportFile: (file: File) => addFiles([file]),
  };

  return { fileInput, dropzone };
}
