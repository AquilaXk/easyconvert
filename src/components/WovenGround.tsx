'use client';

import { useEffect, useRef } from 'react';

/** The ground drifts up at a fifth of the scroll speed and stops after this many pixels; globals.css overscans it by as much. */
export const GROUND_DRIFT_RATE = 0.2;
export const GROUND_DRIFT_MAX_PX = 240;

export function groundOffset(scrollY: number): number {
  return Math.min(Math.max(scrollY, 0) * GROUND_DRIFT_RATE, GROUND_DRIFT_MAX_PX);
}

/**
 * The woven ground behind every page. Browsers with CSS scroll-driven animations move it from globals.css; elsewhere
 * this writes the same offset to the layer's own transform once per frame, so no other element restyles on scroll.
 */
export default function WovenGround() {
  const groundRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ground = groundRef.current;
    if (!ground || CSS.supports('animation-timeline: scroll()')) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

    let frame = 0;
    const write = () => {
      frame = 0;
      ground.style.transform = `translate3d(0, ${-groundOffset(window.scrollY)}px, 0)`;
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(write);
    };
    const start = () => {
      write();
      window.addEventListener('scroll', onScroll, { passive: true });
    };
    const stop = () => {
      window.removeEventListener('scroll', onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      ground.style.transform = '';
    };
    const onPreferenceChange = () => (reduced.matches ? stop() : start());

    if (!reduced.matches) start();
    reduced.addEventListener('change', onPreferenceChange);
    return () => {
      reduced.removeEventListener('change', onPreferenceChange);
      stop();
    };
  }, []);

  return <div ref={groundRef} aria-hidden="true" className="woven-ground" />;
}
