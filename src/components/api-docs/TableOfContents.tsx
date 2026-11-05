'use client';

import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export interface TocItem {
  readonly id: string;
  readonly label: string;
  readonly children?: readonly TocItem[];
}

const flatIds = (items: readonly TocItem[]): string[] => items.flatMap((item) => [item.id, ...flatIds(item.children ?? [])]);

/**
 * The heading the reader is at: the last heading above the top quarter of the viewport, as the reference table of contents
 * marks it. The headings are read again on each scroll frame, so a section that grows (an opened list) moves the mark.
 */
function useCurrentHeading(ids: readonly string[]): string | undefined {
  const [current, setCurrent] = useState<string | undefined>(ids[0]);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = window.innerHeight / 4;
      let found = ids[0];
      for (const id of ids) {
        const heading = document.getElementById(id);
        if (heading && heading.getBoundingClientRect().top <= line) found = id;
      }
      setCurrent(found);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [ids]);
  return current;
}

function TocList({ items, current, nested, tall }: Readonly<{ items: readonly TocItem[]; current?: string; nested: boolean; tall: boolean }>) {
  return (
    <ul className={nested ? 'ms-3' : 'border-s border-rule'}>
      {items.map((item) => (
        <li key={item.id} className="-ms-px">
          <a
            href={`#${item.id}`}
            aria-current={item.id === current ? 'location' : undefined}
            className={`border-s ps-4 text-sm transition-colors ${tall ? 'flex items-center min-h-[44px]' : 'block py-1'} ${
              item.id === current ? 'border-accent-ink text-accent-ink' : 'border-transparent text-ink-3 hover:text-ink'
            }`}
          >
            {item.label}
          </a>
          {item.children?.length ? <TocList items={item.children} current={current} nested tall={tall} /> : null}
        </li>
      ))}
    </ul>
  );
}

/** "On this page": a sticky list from 1024 px, a collapsed bar under it, as the reference places it. */
export default function TableOfContents({ title, items }: Readonly<{ title: string; items: readonly TocItem[] }>) {
  const [ids] = useState(() => flatIds(items));
  const current = useCurrentHeading(ids);
  if (items.length === 0) return null;
  return (
    <>
      <nav aria-label={title} className="hidden lg:block sticky top-[var(--header-height)] py-8">
        <p className="py-1.5 -mt-1.5 text-sm font-semibold text-ink">{title}</p>
        <TocList items={items} current={current} nested={false} tall={false} />
      </nav>
      <details className="group/toc lg:hidden border-b border-dashed border-rule">
        <summary className="flex items-center justify-between min-h-[44px] py-2 text-sm font-semibold text-ink cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          {title}
          <ChevronDown className="size-4 text-ink-3 transition-transform group-open/toc:rotate-180" aria-hidden="true" />
        </summary>
        <nav aria-label={title} className="pb-4">
          <TocList items={items} current={current} nested={false} tall />
        </nav>
      </details>
    </>
  );
}
