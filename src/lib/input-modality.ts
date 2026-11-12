/**
 * Which input moved focus last, kept on `<html data-input-modality>` so the focus ring follows the keyboard only.
 *
 * Browsers decide `:focus-visible` for a focus that script moves (a dialog that opens, a menu that takes focus) by their
 * own rules, and touch Safari draws the ring after a tap. The rule below follows the input-modality tracking of React Aria
 * (adobe/react-spectrum, Apache-2.0, packages/react-aria/src/interactions/useFocusVisible.ts: `isValidKey`,
 * `handleKeyboardEvent`, `handlePointerEvent`), which Headless UI's focus rings build on: a pointer or touch press sets
 * `pointer`, an unmodified key sets `keyboard`. Modifier keys alone, and shortcuts with Meta or Control (or Alt off macOS),
 * leave the modality as it was, because they also arrive when a person switches back to the tab. The CSS hides the ring
 * only while the modality is `pointer`, so a page that has seen no input yet keeps it, as before.
 *
 * It runs as an inline script in the document head, before any focus can move, so it is written as a string.
 */
export const INPUT_MODALITY_SCRIPT = `
(function () {
  var root = document.documentElement;
  var isMac = /^Mac/.test(navigator.platform || '');
  function set(modality) {
    if (root.getAttribute('data-input-modality') !== modality) root.setAttribute('data-input-modality', modality);
  }
  function onKey(e) {
    if (e.metaKey || (!isMac && e.altKey) || e.ctrlKey || e.key === 'Control' || e.key === 'Shift' || e.key === 'Meta') return;
    set('keyboard');
  }
  function onPointer() {
    set('pointer');
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKey, true);
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('mousedown', onPointer, true);
})();
`;
