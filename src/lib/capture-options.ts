/** How a `capture.website` node loads and draws the page; every field has a default. */
export interface WebsiteCaptureOptions {
  /** The browser window of a PNG or JPEG: width 200 to 3840 (1280), height 200 to 16384 (800). */
  viewport?: { width?: number; height?: number };
  /** PNG and JPEG: the whole height of the page (up to 16384 px) instead of the window. */
  fullPage?: boolean;
  /** `load` (default) draws once the page has loaded; `idle` also waits until it has made no request for half a second. */
  waitUntil?: 'load' | 'idle';
  /** Extra time to wait after that, 0 to 30000 ms. */
  delayMs?: number;
  /** JPEG quality, 1 to 100 (85). */
  quality?: number;
  userAgent?: string;
  /** The time the page has to load and be drawn, 1000 to 120000 ms (60000). */
  timeoutMs?: number;
  pdf?: WebsiteCapturePdfOptions;
}

export interface WebsiteCapturePdfOptions {
  paper?: 'A3' | 'A4' | 'A5' | 'Letter' | 'Legal' | 'Tabloid';
  /** The page size in millimetres; both set, they take the place of `paper`. */
  width?: number;
  height?: number;
  landscape?: boolean;
  /** Margin on every side, millimetres (10). */
  margin?: number;
  printBackground?: boolean;
  /** Zoom of the page, 0.1 to 2 (1). */
  scale?: number;
}
