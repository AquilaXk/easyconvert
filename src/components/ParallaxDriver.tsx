'use client';

import { useEffect } from 'react';

/**
 * Browsers with CSS scroll-driven animations move the parallax layers in globals.css on their own. Elsewhere this
 * writes the scroll offset to `--scroll-y` once per frame, which the same layers read as a transform.
 */
export default function ParallaxDriver() {
  useEffect(() => {
    if (CSS.supports('animation-timeline: scroll()')) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const root = document.documentElement;
    let frame = 0;
    const write = () => {
      frame = 0;
      root.style.setProperty('--scroll-y', String(window.scrollY));
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(write);
    };
    write();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);

  return null;
}
