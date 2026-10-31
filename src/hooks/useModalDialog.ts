'use client';

import { RefObject, useEffect, useRef } from 'react';

function isPointerOutsideDialog(dialog: HTMLDialogElement, event: PointerEvent): boolean {
  if (event.target !== dialog) return false;
  const rect = dialog.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return true;
  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  );
}

export function useModalDialog(
  dialogRef: RefObject<HTMLDialogElement | null>,
  isOpen: boolean,
  onClose: () => void
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (!isOpen) {
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
      return;
    }

    if (!dialog.open && typeof dialog.showModal === 'function') dialog.showModal();

    let pointerDownOutside = false;
    const handleClose = () => onCloseRef.current();
    const handlePointerDown = (event: PointerEvent) => {
      pointerDownOutside = isPointerOutsideDialog(dialog, event);
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (pointerDownOutside && isPointerOutsideDialog(dialog, event)) {
        pointerDownOutside = false;
        onCloseRef.current();
      }
      pointerDownOutside = false;
    };

    dialog.addEventListener('close', handleClose);
    dialog.addEventListener('pointerdown', handlePointerDown);
    dialog.addEventListener('pointerup', handlePointerUp);
    return () => {
      dialog.removeEventListener('close', handleClose);
      dialog.removeEventListener('pointerdown', handlePointerDown);
      dialog.removeEventListener('pointerup', handlePointerUp);
    };
  }, [dialogRef, isOpen]);
}
