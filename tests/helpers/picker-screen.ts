import { act } from 'react';
import { vi } from 'vitest';

/** What a person sees of the page: where the trigger is, the visual viewport (a keyboard shrinks it, a pan offsets it) and the sticky header. */
export interface Screen {
  trigger: DOMRect;
  viewport: { width: number; height: number; offsetLeft: number; offsetTop: number };
  headerBottom: number;
}

const PANEL_SIZE = { width: 352, height: 321 };
const fresh = (): Screen => ({ trigger: new DOMRect(100, 200, 128, 32), viewport: { width: 390, height: 844, offsetLeft: 0, offsetTop: 0 }, headerBottom: 0 });
export const screen: Screen = fresh();

/** The observers a page has live: a disconnected one never calls back, as in a browser. */
type Observed = { callback: (entries: unknown[]) => void };
const liveObservers = new Set<Observed>();

class FakeObserver implements Observed {
  constructor(readonly callback: (entries: unknown[]) => void) {}
  observe() {
    liveObservers.add(this);
  }
  unobserve() {}
  disconnect() {
    liveObservers.delete(this);
  }
}

let triggerReads = 0;

const cssPixels = (value: string, fallback: number) => Number.parseFloat(value) || fallback;
const panelWidth = (panel: HTMLElement) => cssPixels(panel.style.width, PANEL_SIZE.width);
const panelHeight = (panel: HTMLElement) => Math.min(PANEL_SIZE.height, cssPixels(panel.style.maxHeight, PANEL_SIZE.height));

/** jsdom lays nothing out, so each element reports the box the page of `screen` would give it. */
export function layOutPage() {
  Object.assign(screen, fresh());
  triggerReads = 0;
  liveObservers.clear();
  vi.stubGlobal('ResizeObserver', FakeObserver);
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  const viewport = Object.assign(new EventTarget(), screen.viewport);
  Object.defineProperty(document.defaultView!, 'visualViewport', { configurable: true, get: () => Object.assign(viewport, screen.viewport) });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'trigger') {
      triggerReads += 1;
      return screen.trigger;
    }
    if (this.hasAttribute('data-sticky-header')) return new DOMRect(0, 0, screen.viewport.width, screen.headerBottom);
    if (this.tagName === 'DIALOG') return new DOMRect(cssPixels(this.style.left, 0), cssPixels(this.style.top, 0), panelWidth(this), panelHeight(this));
    return new DOMRect();
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.tagName === 'DIALOG' ? panelWidth(this) : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.tagName === 'DIALOG' ? panelHeight(this) : 0;
  });
}

export function restorePage() {
  Reflect.deleteProperty(document.defaultView!, 'visualViewport');
}

/** Lets the popover's placement, which is computed asynchronously, finish. */
export const settled = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** The page scrolls, or the keyboard moves the visual viewport: the popover is told as it is in a browser. */
export async function moveScreen(change: Partial<Screen>) {
  Object.assign(screen, change);
  act(() => {
    document.defaultView!.dispatchEvent(new Event('scroll'));
  });
  await settled();
}

/** How many times the page has measured the trigger, and how many observers still watch it. */
export const measurements = () => ({ trigger: triggerReads, observers: liveObservers.size });

/** The trigger changes size, or a row above it grows and moves it: the observers the placement keeps tell it, as a browser's do. */
export async function changeLayout(change: Partial<Screen>) {
  Object.assign(screen, change);
  const trigger = document.querySelector('[data-testid=trigger]');
  act(() => {
    for (const observer of [...liveObservers]) observer.callback([{ target: trigger, intersectionRatio: 0.5 }]);
  });
  await settled();
}
