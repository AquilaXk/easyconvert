/**
 * Detects mobile WebKit / touch browsers where `navigator.deviceMemory` is unexposed (`undefined`) and per-tab Jetsam
 * memory limits (~300–512 MiB) kill multi-megabyte client WASM allocations, as well as embedded social/messenger WebViews
 * where `blob:` anchor downloads fail or drop filenames.
 */

export const MOBILE_CONSTRAINED_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB

const IN_APP_WEBVIEW_PATTERN = /\b(KAKAOTALK|NAVER\(inapp|Instagram|FBAN|FBAV|Line\/|MicroMessenger)\b/i;
const MOBILE_BROWSER_PATTERN = /\b(iPhone|iPod|iPad|Android.+Mobile|Mobile\/\w+\s+Safari)\b/i;

function readNavigatorUserAgent(explicit?: string): string {
  if (typeof explicit === 'string') return explicit;
  if (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string') {
    return navigator.userAgent;
  }
  return '';
}

/** True inside embedded messenger/social WebViews (`KAKAOTALK`, `NAVER`, `Instagram`, `FBAN/FBAV`, `Line`, `WeChat`). */
export function isInAppWebView(userAgent?: string): boolean {
  const ua = readNavigatorUserAgent(userAgent);
  return ua.length > 0 && IN_APP_WEBVIEW_PATTERN.test(ua);
}

/**
 * True on mobile/tablet browsers that hide `navigator.deviceMemory` (such as iOS Safari) where per-tab memory is tightly
 * capped by the OS even when `hardwareConcurrency` reports 6+ cores.
 */
export function isMobileConstrainedBrowser(deviceMemory?: number, userAgent?: string): boolean {
  if (deviceMemory !== undefined && deviceMemory >= 4) return false;
  const ua = readNavigatorUserAgent(userAgent);
  if (!ua) return false;
  return MOBILE_BROWSER_PATTERN.test(ua) || IN_APP_WEBVIEW_PATTERN.test(ua);
}

/** True when `fileSize` fits within `maxBytes` and the browser is not a memory-constrained mobile tab. */
export function fitsOpfsStream(fileSize: number, maxBytes: number, deviceMemory?: number): boolean {
  return fileSize <= maxBytes && !isMobileConstrainedBrowser(deviceMemory);
}
